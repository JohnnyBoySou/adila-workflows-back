import { randomBytes } from "node:crypto";
import { environmentsRepository } from "../environments/repository";
import { triggersRepository } from "./repository";
import { isValidCron, removeCronTrigger, upsertCronTrigger } from "./scheduler";
import type { CreateTriggerBody, UpdateTriggerBody } from "./schema";

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
      cronExpression: body.type === "cron" ? body.cronExpression : null,
      timezone: body.type === "cron" ? (body.timezone ?? "UTC") : null,
      webhookToken: body.type === "webhook" ? generateWebhookToken() : null,
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

    // Cron fields só fazem sentido em triggers cron.
    if (existing.type !== "cron" && (body.cronExpression || body.timezone)) {
      return { error: "cron_fields_on_webhook" as const };
    }

    const tz = body.timezone ?? existing.timezone ?? "UTC";
    if (body.cronExpression && !isValidCron(body.cronExpression, tz)) {
      return { error: "invalid_cron" as const };
    }

    const updated = await triggersRepository.update(organizationId, workflowId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.enabled !== undefined && { enabled: body.enabled }),
      ...(body.environmentId !== undefined && { environmentId: body.environmentId }),
      ...(body.cronExpression !== undefined && { cronExpression: body.cronExpression }),
      ...(body.timezone !== undefined && { timezone: body.timezone }),
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
