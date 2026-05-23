import { Elysia, t } from "elysia";
import { rateLimit } from "../../lib/rate-limit";
import { triggersRepository } from "./repository";
import { workflowsController } from "../workflows/controller";
import { webhookParams } from "./schema";

/**
 * Endpoint público (sem auth) para disparar workflows via webhook.
 * O token na URL é o segredo — gerado em create/rotate-token.
 *
 * Body é JSON arbitrário e vira o `input` do run.
 */
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

    const result = await workflowsController.run(
      trigger.organizationId,
      trigger.workflowId,
      null, // sem usuário — disparo do webhook
      {
        environmentId: trigger.environmentId,
        input: (body ?? {}) as Record<string, unknown>,
      },
    );
    if ("error" in result) return status(400, { error: result.error });

    // Atualiza telemetria do trigger.
    await triggersRepository.updateRaw(trigger.id, {
      lastTriggeredAt: new Date(),
      lastRunId: result.runId,
    });

    return status(202, {
      runId: result.runId,
      workflowId: result.workflowId,
    });
  },
  {
    params: webhookParams,
    // Body opcional, JSON arbitrário.
    body: t.Optional(t.Unknown()),
  },
);
