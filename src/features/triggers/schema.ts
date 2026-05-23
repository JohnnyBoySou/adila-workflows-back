import { t } from "elysia";
import { triggerType } from "../../db/schema";

const typeEnum = t.Union(triggerType.map((s) => t.Literal(s)));

const baseFields = {
  name: t.String({ minLength: 1, maxLength: 120 }),
  environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  enabled: t.Optional(t.Boolean()),
};

const cronFields = {
  cronExpression: t.String({ minLength: 1, maxLength: 120 }),
  timezone: t.Optional(t.String({ maxLength: 64 })),
};

// Campos específicos de webhook — `responseMode: sync` faz o endpoint /hooks/:token
// aguardar o run terminar e devolver o output (ou um `respond_to_webhook` node).
const webhookFields = {
  webhookResponseMode: t.Optional(t.Union([t.Literal("async"), t.Literal("sync")])),
  webhookResponseTimeoutMs: t.Optional(t.Integer({ minimum: 1000, maximum: 120_000 })),
};

// Body de criação: union discriminada por `type`.
// Cron exige cronExpression; webhook ignora ambos.
export const createTriggerBody = t.Union([
  t.Object({ type: t.Literal("cron"), ...baseFields, ...cronFields }),
  t.Object({ type: t.Literal("webhook"), ...baseFields, ...webhookFields }),
]);

export const updateTriggerBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  enabled: t.Optional(t.Boolean()),
  environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  // Atualizar cron só faz sentido em triggers do tipo cron — validamos no controller.
  cronExpression: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  timezone: t.Optional(t.String({ maxLength: 64 })),
  ...webhookFields,
});

export const triggerListParams = t.Object({
  id: t.String({ format: "uuid" }),
});

export const triggerParams = t.Object({
  id: t.String({ format: "uuid" }),
  triggerId: t.String({ format: "uuid" }),
});

export const webhookParams = t.Object({
  token: t.String({ minLength: 16, maxLength: 128 }),
});

export const triggerListQuery = t.Object({
  type: t.Optional(typeEnum),
});

export type CreateTriggerBody = typeof createTriggerBody.static;
export type UpdateTriggerBody = typeof updateTriggerBody.static;
