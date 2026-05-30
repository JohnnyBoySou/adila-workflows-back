import { randomBytes } from "node:crypto";
import { environmentsRepository } from "../environments/repository";
import { workflowVersionsRepository } from "../workflow-versions/repository";
import { triggersRepository } from "./repository";
import {
  isValidCron,
  removeScheduledTrigger,
  upsertCronTrigger,
  upsertIntervalTrigger,
  type IntervalUnit,
} from "./scheduler";
import type { CreateTriggerBody, UpdateTriggerBody } from "./schema";
import type { TriggerType } from "../../db/schema";

/**
 * Garante que o `workflowVersionId` pertence ao mesmo workflow. Sem isso, um
 * trigger de `wfA` poderia ser apontado pra uma versão de `wfB` — quebrando
 * o invariante de "trigger sempre dispara o workflow dono".
 */
async function ensureVersionBelongsToWorkflow(
  workflowId: string,
  workflowVersionId: string,
): Promise<true | { error: "workflow_version_not_found" }> {
  const version = await workflowVersionsRepository.findByIdRaw(workflowVersionId);
  if (!version || version.workflowId !== workflowId) {
    return { error: "workflow_version_not_found" as const };
  }
  return true;
}

function generateWebhookToken() {
  // 32 bytes → 64 chars hex. Suficiente como segredo de URL.
  return randomBytes(32).toString("hex");
}

export const triggersController = {
  list(organizationId: string, workflowId: string, type?: TriggerType) {
    return triggersRepository.list({ organizationId, workflowId, type });
  },

  findById(organizationId: string, workflowId: string, id: string) {
    return triggersRepository.findById(organizationId, workflowId, id);
  },

  async create(organizationId: string, workflowId: string, body: CreateTriggerBody) {
    if (body.environmentId) {
      const env = await environmentsRepository.findById(organizationId, body.environmentId);
      if (!env) return { error: "environment_not_found" as const };
    }

    if (body.workflowVersionId) {
      const check = await ensureVersionBelongsToWorkflow(workflowId, body.workflowVersionId);
      if (check !== true) return check;
    }

    if (body.type === "cron") {
      const tz = body.timezone ?? "UTC";
      if (!isValidCron(body.cronExpression, tz)) {
        return { error: "invalid_cron" as const };
      }
    }

    const isCron = body.type === "cron";
    const isWebhook = body.type === "webhook";
    const isInterval = body.type === "interval_trigger";
    // `config` só existe nas variantes novas da union — narrow por checagem.
    const config =
      "config" in body && body.config && typeof body.config === "object"
        ? (body.config as Record<string, unknown>)
        : {};

    const trigger = await triggersRepository.create({
      organizationId,
      workflowId,
      name: body.name,
      type: body.type,
      enabled: body.enabled ?? true,
      environmentId: body.environmentId ?? null,
      workflowVersionId: body.workflowVersionId ?? null,
      nodeId: body.nodeId ?? null,
      cronExpression: isCron ? body.cronExpression : null,
      timezone: isCron ? (body.timezone ?? "UTC") : null,
      webhookToken: isWebhook ? generateWebhookToken() : null,
      // Defaults sãos pra triggers webhook; ignorados pros demais.
      webhookResponseMode: isWebhook ? (body.webhookResponseMode ?? "async") : null,
      webhookResponseTimeoutMs: isWebhook ? (body.webhookResponseTimeoutMs ?? 30_000) : null,
      ...(isWebhook && {
        allowedMethods: body.allowedMethods ?? ["POST"],
        hmacSecret: body.hmacSecret ?? null,
      }),
      config,
    });

    if (trigger.type === "cron" && trigger.enabled && trigger.cronExpression) {
      await upsertCronTrigger(trigger.id, trigger.cronExpression, trigger.timezone ?? "UTC");
    } else if (isInterval && trigger.enabled) {
      const cfg = trigger.config as { every: number; unit: IntervalUnit };
      await upsertIntervalTrigger(trigger.id, cfg.every, cfg.unit);
    }

    return { trigger };
  },

  async update(organizationId: string, workflowId: string, id: string, body: UpdateTriggerBody) {
    const existing = await triggersRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" as const };

    // Promover é uma operação semanticamente distinta de "editar trigger" e
    // tem endpoint próprio (`POST /:triggerId/promote`) que gera audit
    // log `trigger.promoted`. Bloquear aqui evita um caminho paralelo que
    // mudaria a versão sem registrar release. Caller deve usar /promote.
    if (body.workflowVersionId !== undefined) {
      return { error: "use_promote_endpoint" as const };
    }

    if (body.environmentId) {
      const env = await environmentsRepository.findById(organizationId, body.environmentId);
      if (!env) return { error: "environment_not_found" as const };
    }

    // Cron fields só fazem sentido em triggers cron.
    if (existing.type !== "cron" && (body.cronExpression || body.timezone)) {
      return { error: "cron_fields_on_webhook" as const };
    }
    // Inverso: campos de webhook só em triggers webhook.
    if (
      existing.type !== "webhook" &&
      (body.webhookResponseMode !== undefined ||
        body.webhookResponseTimeoutMs !== undefined ||
        body.allowedMethods !== undefined ||
        body.hmacSecret !== undefined)
    ) {
      return { error: "webhook_fields_on_cron" as const };
    }

    const tz = body.timezone ?? existing.timezone ?? "UTC";
    if (body.cronExpression && !isValidCron(body.cronExpression, tz)) {
      return { error: "invalid_cron" as const };
    }

    // Merge raso da config — patch parcial substitui chaves indicadas.
    const mergedConfig =
      body.config !== undefined
        ? { ...(existing.config ?? {}), ...body.config }
        : undefined;

    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.environmentId !== undefined && { environmentId: body.environmentId }),
      ...(body.nodeId !== undefined && { nodeId: body.nodeId }),
      ...(body.cronExpression !== undefined && { cronExpression: body.cronExpression }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      ...(body.webhookResponseMode !== undefined && {
        webhookResponseMode: body.webhookResponseMode,
      }),
      ...(body.webhookResponseTimeoutMs !== undefined && {
        webhookResponseTimeoutMs: body.webhookResponseTimeoutMs,
      }),
      ...(body.allowedMethods !== undefined && { allowedMethods: body.allowedMethods }),
      ...(body.hmacSecret !== undefined && { hmacSecret: body.hmacSecret }),
      ...(body.webhookPath !== undefined && { webhookPath: body.webhookPath }),
      ...(mergedConfig !== undefined && { config: mergedConfig }),
    });
    if (!updated) return { error: "not_found" as const };

    // Re-sincroniza o scheduler do BullMQ com o estado novo.
    if (updated.type === "cron") {
      if (updated.enabled && updated.cronExpression) {
        await upsertCronTrigger(updated.id, updated.cronExpression, updated.timezone ?? "UTC");
      } else {
        await removeScheduledTrigger(updated.id);
      }
    } else if (updated.type === "interval_trigger") {
      const cfg = updated.config as { every?: unknown; unit?: unknown };
      const every = Number(cfg.every);
      const unit = cfg.unit as IntervalUnit;
      if (updated.enabled && Number.isFinite(every) && every >= 1) {
        await upsertIntervalTrigger(updated.id, every, unit);
      } else {
        await removeScheduledTrigger(updated.id);
      }
    }

    return { trigger: updated };
  },

  async remove(organizationId: string, workflowId: string, id: string) {
    const removed = await triggersRepository.remove(organizationId, workflowId, id);
    if (!removed) return null;
    if (removed.type === "cron" || removed.type === "interval_trigger") {
      await removeScheduledTrigger(removed.id);
    }
    return removed;
  },

  /**
   * Move o pino de versão do trigger. `workflowVersionId = null` despinpina e
   * volta ao comportamento legado (latest/auto-publish). O caller (router)
   * registra `trigger.promoted` no audit log com o diff de versões.
   */
  async promote(
    organizationId: string,
    workflowId: string,
    id: string,
    workflowVersionId: string | null,
  ) {
    const existing = await triggersRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" as const };

    if (workflowVersionId) {
      const check = await ensureVersionBelongsToWorkflow(workflowId, workflowVersionId);
      if (check !== true) return check;
    }

    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      workflowVersionId,
    });
    if (!updated) return { error: "not_found" as const };
    return {
      trigger: updated,
      previousWorkflowVersionId: existing.workflowVersionId,
    };
  },

  /**
   * Gera (ou regenera) o segredo HMAC do webhook. Devolve o segredo em claro
   * pra o caller poder mostrar uma vez ao usuário — não logamos no audit.
   */
  async rotateHmacSecret(organizationId: string, workflowId: string, id: string) {
    const existing = await triggersRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" as const };
    if (existing.type !== "webhook") return { error: "not_webhook" as const };
    const secret = randomBytes(32).toString("hex");
    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      hmacSecret: secret,
    });
    return { trigger: updated, secret };
  },

  /** Remove o segredo HMAC — webhook volta a aceitar sem assinatura. */
  async clearHmacSecret(organizationId: string, workflowId: string, id: string) {
    const existing = await triggersRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" as const };
    if (existing.type !== "webhook") return { error: "not_webhook" as const };
    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      hmacSecret: null,
    });
    return { trigger: updated };
  },

  /** Rotaciona o token de webhook — invalida URLs antigas. */
  async rotateWebhookToken(organizationId: string, workflowId: string, id: string) {
    const existing = await triggersRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" as const };
    if (existing.type !== "webhook") return { error: "not_webhook" as const };
    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      webhookToken: generateWebhookToken(),
    });
    return { trigger: updated };
  },
};
