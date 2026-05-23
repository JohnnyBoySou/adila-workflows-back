import { Elysia } from "elysia";
import { requireOrganization } from "../../lib/auth-middleware";
import { subscribeToRun } from "../../lib/run-events";
import { auditLog } from "../audit-logs/service";
import { workflowRunsController } from "./controller";
import { workflowRunsRepository } from "./repository";
import { workflowRunStepsRepository } from "./steps-repository";
import { listRunsParams, listRunsQuery, runParams } from "./schema";

// Status terminais — quando recebemos um evento desses fechamos o SSE.
const TERMINAL_EVENTS = new Set(["run-success", "run-failed", "run-cancelled"]);

// Sub-rota de workflows → /workflows/:id/runs.
export const workflowRunsRouter = new Elysia({ prefix: "/workflows/:id/runs" })
  .use(requireOrganization)

  .get(
    "/",
    ({ organizationId, params, query }) =>
      workflowRunsRepository.list({
        organizationId,
        workflowId: params.id,
        status: query.status,
        limit: query.limit ?? 20,
        offset: query.offset ?? 0,
      }),
    { params: listRunsParams, query: listRunsQuery },
  )

  .get(
    "/:runId",
    async ({ organizationId, params, status }) => {
      const run = await workflowRunsRepository.findById(organizationId, params.id, params.runId);
      if (!run) return status(404, { error: "not_found" });
      return run;
    },
    { params: runParams },
  )

  // Trilha de execução nó-a-nó. Útil pra debug visual no editor.
  .get(
    "/:runId/steps",
    async ({ organizationId, params, status }) => {
      const run = await workflowRunsRepository.findById(organizationId, params.id, params.runId);
      if (!run) return status(404, { error: "not_found" });
      return workflowRunStepsRepository.listByRun(run.id);
    },
    { params: runParams },
  )

  // SSE: stream de eventos do run em tempo real. Cliente recebe um snapshot
  // inicial e depois cada step-start/success/failed + run-success/failed/cancelled.
  // Auth: requireOrganization já validou cookie e org. Se o run não pertence
  // à org, devolve 404 antes de abrir o stream.
  .get(
    "/:runId/stream",
    async ({ organizationId, params, status, set }) => {
      const run = await workflowRunsRepository.findById(organizationId, params.id, params.runId);
      if (!run) return status(404, { error: "not_found" });

      set.headers["Content-Type"] = "text/event-stream";
      set.headers["Cache-Control"] = "no-cache, no-transform";
      set.headers["Connection"] = "keep-alive";
      // Algumas plataformas (Railway com proxy padrão) bufferizam SSE; este
      // header pede pro nginx-like não fazer isso.
      set.headers["X-Accel-Buffering"] = "no";

      const encoder = new TextEncoder();
      const runId = run.id;
      const initialSteps = await workflowRunStepsRepository.listByRun(runId);

      // Capturados no escopo externo para que `start` e `cancel` compartilhem.
      let closed = false;
      let unsubscribe: (() => Promise<void>) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed || !controllerRef) return;
        try {
          controllerRef.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      const teardown = async () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (unsubscribe) await unsubscribe();
        try {
          controllerRef?.close();
        } catch {
          // Já fechado pelo consumer.
        }
      };

      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controllerRef = controller;

          send("snapshot", { run, steps: initialSteps });

          if (run.status === "success" || run.status === "failed" || run.status === "cancelled") {
            await teardown();
            return;
          }

          unsubscribe = await subscribeToRun(runId, (event) => {
            send(event.type, event);
            if (TERMINAL_EVENTS.has(event.type)) {
              void teardown();
            }
          });

          heartbeat = setInterval(() => {
            send("ping", { at: new Date().toISOString() });
          }, 20000);
        },
        async cancel() {
          await teardown();
        },
      });
    },
    { params: runParams },
  )

  // Reexecuta um run terminal: mesma versão imutável + mesmo input.
  .post(
    "/:runId/rerun",
    async ({ organizationId, user, params, status, request }) => {
      const result = await workflowRunsController.rerun(
        organizationId,
        params.id,
        params.runId,
        user.id,
      );
      if ("error" in result) {
        if (result.error === "not_found" || result.error === "workflow_not_found") {
          return status(404, { error: result.error });
        }
        return status(409, { error: result.error, status: result.status });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow_run.rerun",
        resourceType: "workflow_run",
        resourceId: result.run.id,
        metadata: { workflowId: params.id, sourceRunId: result.sourceRunId },
        request,
      });
      return status(202, result.run);
    },
    { params: runParams },
  )

  // Cancela um run. queued sai da fila; running recebe sinal cooperativo.
  .post(
    "/:runId/cancel",
    async ({ organizationId, user, params, status, request }) => {
      const result = await workflowRunsController.cancel(organizationId, params.id, params.runId);
      if ("error" in result) {
        if (result.error === "not_found") return status(404, { error: result.error });
        return status(409, { error: result.error, status: result.status });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow_run.cancelled",
        resourceType: "workflow_run",
        resourceId: result.run.id,
        metadata: { workflowId: params.id, previousStatus: result.run.status },
        request,
      });
      return result.run;
    },
    { params: runParams },
  );
