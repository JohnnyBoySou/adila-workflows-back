import { Elysia, t } from "elysia";
import { env } from "../../config/env";
import { requireOrganization } from "../../lib/auth-middleware";
import { LANE_NAMES, workflowQueues } from "../../lib/queue";
import { subscribeToRun } from "../../lib/run-events";
import { auditLog } from "../audit-logs/service";
import { workflowsController } from "../workflows/controller";
import { workflowRunsController } from "./controller";
import { workflowRunEventsRepository } from "./events-repository";
import { workflowRunsRepository } from "./repository";
import { workflowRunStepsRepository } from "./steps-repository";
import { listRunsParams, listRunsQuery, runParams } from "./schema";

// Status terminais — quando recebemos um evento desses fechamos o SSE.
const TERMINAL_EVENTS = new Set([
  "run-success",
  "run-failed",
  "run-cancelled",
  "workflow.finished",
  "workflow.failed",
  "workflow.cancelled",
]);

// Sub-rota de workflows → /workflows/:id/runs.
export const workflowRunsRouter = new Elysia({ prefix: "/workflows/:id/runs" })
  .use(requireOrganization)

  .get(
    "/throughput",
    async ({ organizationId, params }) => {
      const windowMinutes = 15;
      const since = new Date(Date.now() - windowMinutes * 60_000);
      const events = await workflowRunEventsRepository.listWorkflowFinishedEvents(
        organizationId,
        params.id,
        since,
      );
      const counts = new Map<string, number>();
      for (const event of events) {
        const bucket = new Date(event.occurredAt);
        bucket.setSeconds(0, 0);
        const key = bucket.toISOString();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const series = Array.from(counts.entries())
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([minute, runs]) => ({ minute, runs }));
      // Soma contadores de todas as lanes — o throughput é uma visão
      // agregada da capacidade total, não por lane.
      const perLane = await Promise.all(
        LANE_NAMES.map((lane) =>
          workflowQueues[lane].getJobCounts(
            "waiting",
            "prioritized",
            "active",
            "completed",
            "failed",
            "delayed",
          ),
        ),
      );
      const jobCounts = perLane.reduce<Record<string, number>>((acc, c) => {
        for (const [k, v] of Object.entries(c)) acc[k] = (acc[k] ?? 0) + v;
        return acc;
      }, {});
      const runsPerSecond = Number((events.length / (windowMinutes * 60)).toFixed(3));
      return {
        windowMinutes,
        finishedRuns: events.length,
        runsPerSecond,
        workerConcurrency: env.WORKFLOW_WORKER_CONCURRENCY,
        queue: jobCounts,
        series,
      };
    },
    { params: listRunsParams },
  )

  // Agregação de duração por nó, baseada nos últimos N runs.
  // Alimenta o heatmap/tabela de gargalos no painel de performance.
  .get(
    "/node-durations",
    ({ organizationId, params, query }) =>
      workflowRunStepsRepository.durationsByNode(organizationId, params.id, query.runs ?? 50),
    {
      params: listRunsParams,
      query: t.Object({
        runs: t.Optional(t.Numeric({ minimum: 1, maximum: 500, default: 50 })),
      }),
    },
  )

  // Dispara N execuções com payload sintético pra medir throughput sob carga.
  // Reaproveita workflowsController.run → mesma resolução de versão da execução normal.
  // Limite alto na contagem mas guardado por validação pra evitar abuso.
  .post(
    "/load-test",
    async ({ organizationId, user, params, body, request }) => {
      const startedAt = Date.now();
      const results: Array<{ runId: string; jobId: string | undefined }> = [];
      const errors: Array<{ index: number; error: string }> = [];

      for (let i = 0; i < body.count; i++) {
        const result = await workflowsController.run(organizationId, params.id, user.id, {
          input: { ...(body.input ?? {}), __loadTest: { index: i, batchAt: startedAt } },
          queuePriority: body.priority ?? 10,
        });
        if ("error" in result) {
          errors.push({ index: i, error: String(result.error) });
        } else {
          results.push({ runId: result.runId, jobId: result.jobId });
        }
      }

      const enqueueMs = Date.now() - startedAt;

      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.load_test",
        resourceType: "workflow",
        resourceId: params.id,
        metadata: {
          requested: body.count,
          enqueued: results.length,
          failed: errors.length,
          enqueueMs,
        },
        request,
      });

      return {
        requested: body.count,
        enqueued: results.length,
        failed: errors.length,
        enqueueMs,
        runs: results,
        errors,
      };
    },
    {
      params: listRunsParams,
      body: t.Object({
        count: t.Integer({ minimum: 1, maximum: 500 }),
        priority: t.Optional(t.Integer({ minimum: 1, maximum: 20 })),
        input: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )

  .get(
    "/:runId/timeline",
    async ({ organizationId, params, status }) => {
      const run = await workflowRunsRepository.findById(organizationId, params.id, params.runId);
      if (!run) return status(404, { error: "not_found" });
      const events = await workflowRunEventsRepository.listByRun(
        organizationId,
        params.id,
        params.runId,
      );
      const firstAt = events[0]?.occurredAt?.getTime() ?? null;
      return events.map((event) => ({
        ...event,
        deltaMs: firstAt === null ? 0 : event.occurredAt.getTime() - firstAt,
      }));
    },
    { params: runParams },
  )

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
    async ({ organizationId, params, status, set, request }) => {
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

      // Resume protocol — browser EventSource manda `Last-Event-Id` automaticamente
      // ao reconectar. Valor é a `seq` do último evento entregue; replicamos
      // tudo que veio depois antes de re-assinar o Redis. Inválido = ignora.
      const lastEventIdRaw = request.headers.get("last-event-id");
      const lastEventId = lastEventIdRaw ? Number(lastEventIdRaw) : null;
      const resumeFromSeq = Number.isFinite(lastEventId) ? (lastEventId as number) : null;

      // Capturados no escopo externo para que `start` e `cancel` compartilhem.
      let closed = false;
      let unsubscribe: (() => Promise<void>) | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
      let lastSentSeq = resumeFromSeq ?? 0;

      const send = (event: string, data: unknown, id?: number) => {
        if (closed || !controllerRef) return;
        try {
          const idLine = typeof id === "number" ? `id: ${id}\n` : "";
          controllerRef.enqueue(
            encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
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

          // Sem resume: snapshot completo. Com resume: pula snapshot (cliente
          // já tem) e só replaya o que perdeu.
          if (resumeFromSeq === null) {
            send("snapshot", { run, steps: initialSteps });
          }

          // Replay de eventos perdidos durante a desconexão.
          const missed = await workflowRunEventsRepository.listByRunSinceSeq(
            runId,
            resumeFromSeq ?? 0,
          );
          for (const evt of missed) {
            const seq = Number(evt.seq);
            send(
              evt.eventType,
              {
                type: evt.eventType,
                runId,
                seq,
                at: evt.occurredAt.toISOString(),
                data: evt.payload ?? {},
              },
              seq,
            );
            lastSentSeq = Math.max(lastSentSeq, seq);
          }

          if (run.status === "success" || run.status === "failed" || run.status === "cancelled") {
            await teardown();
            return;
          }

          unsubscribe = await subscribeToRun(runId, (event) => {
            // Dedup: o replay pode ter alcançado eventos publicados ao mesmo tempo.
            if (typeof event.seq === "number" && event.seq <= lastSentSeq) return;
            if (typeof event.seq === "number") lastSentSeq = event.seq;
            send(event.type, event, event.seq);
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
