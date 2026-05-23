import { randomBytes } from "node:crypto";
import { environmentsRepository } from "../environments/repository";
import { workflowVersionsRepository } from "../workflow-versions/repository";
import { triggersRepository } from "./repository";
import { isValidCron, removeCronTrigger, upsertCronTrigger } from "./scheduler";
import type { CreateTriggerBody, UpdateTriggerBody } from "./schema";

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
  list(organizationId: string, workflowId: string, type?: "cron" | "webhook") {
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

    const trigger = await triggersRepository.create({
      organizationId,
      workflowId,
      name: body.name,
      type: body.type,
      enabled: body.enabled ?? true,
      environmentId: body.environmentId ?? null,
      workflowVersionId: body.workflowVersionId ?? null,
      nodeId: body.nodeId ?? null,
      cronExpression: body.type === "cron" ? body.cronExpression : null,
      timezone: body.type === "cron" ? (body.timezone ?? "UTC") : null,
      webhookToken: body.type === "webhook" ? generateWebhookToken() : null,
      // Defaults sãos pra triggers webhook; ignorados pra cron.
      webhookResponseMode: body.type === "webhook" ? (body.webhookResponseMode ?? "async") : null,
      webhookResponseTimeoutMs:
        body.type === "webhook" ? (body.webhookResponseTimeoutMs ?? 30_000) : null,
    });

    if (trigger.type === "cron" && trigger.enabled && trigger.cronExpression) {
      await upsertCronTrigger(trigger.id, trigger.cronExpression, trigger.timezone ?? "UTC");
    }

    return { trigger };
  },

  async update(organizationId: string, workflowId: string, id: string, body: UpdateTriggerBody) {
    const existing = await triggersRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" as const };

    if (body.environmentId) {
      const env = await environmentsRepository.findById(organizationId, body.environmentId);
      if (!env) return { error: "environment_not_found" as const };
    }

    if (body.workflowVersionId) {
      const check = await ensureVersionBelongsToWorkflow(workflowId, body.workflowVersionId);
      if (check !== true) return check;
    }

    // Cron fields só fazem sentido em triggers cron.
    if (existing.type !== "cron" && (body.cronExpression || body.timezone)) {
      return { error: "cron_fields_on_webhook" as const };
    }
    // Inverso: campos de webhook só em triggers webhook.
    if (
      existing.type !== "webhook" &&
      (body.webhookResponseMode !== undefined || body.webhookResponseTimeoutMs !== undefined)
    ) {
      return { error: "webhook_fields_on_cron" as const };
    }

    const tz = body.timezone ?? existing.timezone ?? "UTC";
    if (body.cronExpression && !isValidCron(body.cronExpression, tz)) {
      return { error: "invalid_cron" as const };
    }

    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.environmentId !== undefined && { environmentId: body.environmentId }),
      ...(body.workflowVersionId !== undefined && {
        workflowVersionId: body.workflowVersionId,
      }),
      ...(body.nodeId !== undefined && { nodeId: body.nodeId }),
      ...(body.cronExpression !== undefined && { cronExpression: body.cronExpression }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
      ...(body.webhookResponseMode !== undefined && {
        webhookResponseMode: body.webhookResponseMode,
      }),
      ...(body.webhookResponseTimeoutMs !== undefined && {
        webhookResponseTimeoutMs: body.webhookResponseTimeoutMs,
      }),
    });
    if (!updated) return { error: "not_found" as const };

    // Re-sincroniza o scheduler do BullMQ com o estado novo.
    if (updated.type === "cron") {
      if (updated.enabled && updated.cronExpression) {
        await upsertCronTrigger(updated.id, updated.cronExpression, updated.timezone ?? "UTC");
      } else {
        await removeCronTrigger(updated.id);
      }
    }

    return { trigger: updated };
  },

  async remove(organizationId: string, workflowId: string, id: string) {
    const removed = await triggersRepository.remove(organizationId, workflowId, id);
    if (!removed) return null;
    if (removed.type === "cron") await removeCronTrigger(removed.id);
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
