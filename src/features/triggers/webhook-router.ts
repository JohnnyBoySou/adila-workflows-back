import { createHmac, timingSafeEqual } from "node:crypto";
import { Elysia, t } from "elysia";
import { logger } from "../../lib/logger";
import { findWorkflowJobAcrossLanes, workflowQueueEvents } from "../../lib/queue";
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
 * Body é arbitrário (JSON quando aplicável) e vira o `input` do run.
 *
 * Métodos aceitos: configuráveis via `trigger.allowedMethods` (default ['POST']).
 *
 * Segurança HMAC: se `trigger.hmacSecret` estiver setado, exige header
 * `X-Signature-256: sha256=<hex>` calculado sobre o raw body com SHA-256.
 *
 * Modos de resposta (configurado no trigger):
 *   - 'async' (default): enfileira e devolve 202 com runId imediatamente.
 *   - 'sync': aguarda o run terminar via QueueEvents e responde com:
 *     • o último step `respond_to_webhook` (se houver), aplicando seu
 *       status/headers/body customizados;
 *     • caso contrário, o `output` final do run como JSON com status 200.
 */
const MAX_TIMEOUT_MS = 120_000;
const SUPPORTED_METHODS = ["POST", "GET", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof SUPPORTED_METHODS)[number];

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

/**
 * Verifica `X-Signature-256: sha256=<hex>` contra HMAC-SHA256(secret, rawBody).
 * Usa `timingSafeEqual` pra evitar timing attacks. Aceita também header alternativo
 * `X-Hub-Signature-256` (compat GitHub).
 */
function verifyHmac(secret: string, rawBody: string, headerValue: string | null): boolean {
  if (!headerValue) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(headerValue);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Tipo intencionalmente frouxo — Elysia infere status/set como union complexa
// por rota; aqui só precisamos do shape mínimo que usamos no handler.
type HandlerCtx = {
  params: { token: string };
  body: unknown;
  request: Request;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status: any;
  set: { headers: Record<string, string | number | undefined> };
  method: Method;
};

async function handleWebhook(ctx: HandlerCtx) {
  const { params, body, request, status, set, method } = ctx;

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

  // Validação de método. allowedMethods nunca é vazio (default ['POST']).
  const allowed = (trigger.allowedMethods ?? ["POST"]).map((m) => m.toUpperCase());
  if (!allowed.includes(method)) {
    set.headers["Allow"] = allowed.join(", ");
    return status(405, { error: "method_not_allowed", allowed });
  }

  // Validação HMAC: precisa do raw body, então clonamos a request.
  if (trigger.hmacSecret) {
    const rawBody = await request.clone().text();
    const sig =
      request.headers.get("x-signature-256") ?? request.headers.get("x-hub-signature-256");
    if (!verifyHmac(trigger.hmacSecret, rawBody, sig)) {
      return status(401, { error: "invalid_signature" });
    }
  }

  const result = await workflowsController.run(trigger.organizationId, trigger.workflowId, null, {
    environmentId: trigger.environmentId,
    workflowVersionId: trigger.workflowVersionId,
    input: {
      ...(body && typeof body === "object" ? (body as Record<string, unknown>) : { body }),
      __webhook: {
        method,
        triggerId: trigger.id,
        receivedAt: new Date().toISOString(),
      },
    },
    triggerId: trigger.id,
  });
  if ("error" in result) return status(400, { error: result.error });

  void triggersRepository
    .updateRaw(trigger.id, {
      lastTriggeredAt: new Date(),
      lastRunId: result.runId,
    })
    .catch((err) =>
      logger.warn({ err, triggerId: trigger.id }, "trigger telemetry update failed"),
    );

  if (trigger.webhookResponseMode !== "sync") {
    return status(202, {
      runId: result.runId,
      workflowId: result.workflowId,
    });
  }

  const timeoutMs = Math.min(trigger.webhookResponseTimeoutMs ?? 30_000, MAX_TIMEOUT_MS);
  try {
    if (!result.jobId) throw new Error("job missing — não dá pra esperar");
    // O job pode ter sido enfileirado em qualquer lane (roteamento por
    // node-type). Localizamos primeiro, depois usamos o QueueEvents da
    // lane correta — waitUntilFinished exige correspondência exata.
    const found = await findWorkflowJobAcrossLanes(result.jobId);
    if (!found) throw new Error("job not found");
    await found.job.waitUntilFinished(workflowQueueEvents[found.lane], timeoutMs);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("timed out") || msg.includes("timeout")) {
      return status(504, {
        error: "run_timeout",
        runId: result.runId,
        workflowId: result.workflowId,
        message: "run ainda executando — consulte status pelo runId",
      });
    }
    const run = await workflowRunsRepository.findByIdRaw(result.runId);
    return status(500, {
      error: "run_failed",
      runId: result.runId,
      ...(run?.error && { runError: run.error }),
    });
  }

  const custom = await findCustomResponse(result.runId);
  if (custom) {
    for (const [k, v] of Object.entries(custom.headers)) set.headers[k] = v;
    return status(custom.status, custom.body);
  }

  const run = await workflowRunsRepository.findByIdRaw(result.runId);
  return status(200, run?.output ?? {});
}

const webhookOpts = {
  params: webhookParams,
  body: t.Optional(t.Unknown()),
};

// Registra todos os métodos suportados. A validação de `allowedMethods` por
// trigger acontece dentro do handler — aqui só destravamos a rota.
export const webhookRouter = new Elysia()
  .post("/hooks/:token", (ctx) => handleWebhook({ ...ctx, method: "POST" }), webhookOpts)
  .get("/hooks/:token", (ctx) => handleWebhook({ ...ctx, body: undefined, method: "GET" }), {
    params: webhookParams,
  })
  .put("/hooks/:token", (ctx) => handleWebhook({ ...ctx, method: "PUT" }), webhookOpts)
  .patch("/hooks/:token", (ctx) => handleWebhook({ ...ctx, method: "PATCH" }), webhookOpts)
  .delete("/hooks/:token", (ctx) => handleWebhook({ ...ctx, method: "DELETE" }), webhookOpts);
