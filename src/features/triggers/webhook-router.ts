import { Elysia, t } from "elysia";
import { logger } from "../../lib/logger";
import { workflowQueue, workflowQueueEvents } from "../../lib/queue";
import { rateLimit } from "../../lib/rate-limit";
import { workflowsController } from "../workflows/controller";
import { workflowRunStepsRepository } from "../workflow-runs/steps-repository";
import { workflowRunsRepository } from "../workflow-runs/repository";
import { triggersRepository } from "./repository";
import { webhookParams } from "./schema";

/**
 * Endpoint público (sem auth) para disparar workflows via webhook.
 * O token na URL é o segredo — gerado em create/rotate-token.
 *
 * Body é JSON arbitrário e vira o `input` do run.
 *
 * Modos de resposta (configurado no trigger):
 *   - 'async' (default): enfileira e devolve 202 com runId imediatamente.
 *   - 'sync': aguarda o run terminar via QueueEvents e responde com:
 *     • o último step `respond_to_webhook` (se houver), aplicando seu
 *       status/headers/body customizados;
 *     • caso contrário, o `output` final do run como JSON com status 200.
 */
const MAX_TIMEOUT_MS = 120_000;

interface WebhookResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

function isWebhookResponse(x: unknown): x is WebhookResponse {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return typeof o.status === "number" && typeof o.headers === "object";
}

/** Procura o último step `respond_to_webhook` com payload válido. */
async function findCustomResponse(runId: string): Promise<WebhookResponse | null> {
  const steps = await workflowRunStepsRepository.listByRun(runId);
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]!;
    if (step.nodeType !== "respond_to_webhook" || !step.output) continue;
    const payload = (step.output as Record<string, unknown>).__webhookResponse;
    if (isWebhookResponse(payload)) return payload;
  }
  return null;
}

export const webhookRouter = new Elysia().post(
  "/hooks/:token",
  async ({ params, body, status, set }) => {
    const limit = await rateLimit({
      key: `webhook:${params.token}`,
      limit: 60,
      windowSeconds: 60,
    });
    if (!limit.allowed) {
      set.headers["Retry-After"] = String(limit.resetIn);
      return status(429, { error: "rate_limited" });
    }

    const trigger = await triggersRepository.findByWebhookToken(params.token);
    if (!trigger || trigger.type !== "webhook") {
      return status(404, { error: "not_found" });
    }
    if (!trigger.enabled) {
      return status(403, { error: "trigger_disabled" });
    }

    const result = await workflowsController.run(trigger.organizationId, trigger.workflowId, null, {
      environmentId: trigger.environmentId,
      // Mesma semântica do path cron: se o trigger tem versão pinada, ela
      // ganha — independente do `definition` corrente do workflow.
      workflowVersionId: trigger.workflowVersionId,
      input: (body ?? {}) as Record<string, unknown>,
    });
    if ("error" in result) return status(400, { error: result.error });

    // Telemetria do trigger — não bloqueia a resposta.
    void triggersRepository
      .updateRaw(trigger.id, {
        lastTriggeredAt: new Date(),
        lastRunId: result.runId,
      })
      .catch((err) =>
        logger.warn({ err, triggerId: trigger.id }, "trigger telemetry update failed"),
      );

    // Modo assíncrono (default): devolve 202 e o caller acompanha por polling.
    if (trigger.webhookResponseMode !== "sync") {
      return status(202, {
        runId: result.runId,
        workflowId: result.workflowId,
      });
    }

    // Modo síncrono: espera o job terminar dentro do timeout configurado.
    const timeoutMs = Math.min(trigger.webhookResponseTimeoutMs ?? 30_000, MAX_TIMEOUT_MS);
    try {
      if (!result.jobId) throw new Error("job missing — não dá pra esperar");
      const job = await workflowQueue.getJob(result.jobId);
      if (!job) throw new Error("job not found");
      await job.waitUntilFinished(workflowQueueEvents, timeoutMs);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      // Timeout: o run continua rodando em background; só perdemos a janela sync.
      if (msg.includes("timed out") || msg.includes("timeout")) {
        return status(504, {
          error: "run_timeout",
          runId: result.runId,
          workflowId: result.workflowId,
          message: "run ainda executando — consulte status pelo runId",
        });
      }
      // Job falhou — devolvemos 500 mas com runId pra rastreio.
      const run = await workflowRunsRepository.findByIdRaw(result.runId);
      return status(500, {
        error: "run_failed",
        runId: result.runId,
        ...(run?.error && { runError: run.error }),
      });
    }

    // Sucesso — procura customização via `respond_to_webhook`, senão devolve o output cru.
    const custom = await findCustomResponse(result.runId);
    if (custom) {
      for (const [k, v] of Object.entries(custom.headers)) set.headers[k] = v;
      return status(custom.status, custom.body);
    }

    const run = await workflowRunsRepository.findByIdRaw(result.runId);
    return status(200, run?.output ?? {});
  },
  {
    params: webhookParams,
    body: t.Optional(t.Unknown()),
  },
);
