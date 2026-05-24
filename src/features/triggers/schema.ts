import { t } from "elysia";
import { triggerType } from "../../db/schema";

const typeEnum = t.Union(triggerType.map((s) => t.Literal(s)));

const baseFields = {
  name: t.String({ minLength: 1, maxLength: 120 }),
  environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  enabled: t.Optional(t.Boolean()),
  /**
   * Pin opcional: id de um `workflow_versions` específico que o trigger
   * deve disparar. NULL/ausente = comportamento legado (latest/auto-publica).
   * É o que faz o promote profissional: prod aponta pra v17, stage pra v18.
   */
  workflowVersionId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  /**
   * ID do node no canvas que representa este trigger. Opcional para
   * compatibilidade com triggers gerenciados puramente via API, mas
   * recomendado quando criado a partir do editor.
   */
  nodeId: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 128 }), t.Null()])),
};

const cronFields = {
  cronExpression: t.String({ minLength: 1, maxLength: 120 }),
  timezone: t.Optional(t.String({ maxLength: 64 })),
};

// Campos específicos de webhook — `responseMode: sync` faz o endpoint /hooks/:token
// aguardar o run terminar e devolver o output (ou um `respond_to_webhook` node).
const webhookMethodEnum = t.Union([
  t.Literal("POST"),
  t.Literal("GET"),
  t.Literal("PUT"),
  t.Literal("PATCH"),
  t.Literal("DELETE"),
]);

const webhookFields = {
  webhookResponseMode: t.Optional(t.Union([t.Literal("async"), t.Literal("sync")])),
  webhookResponseTimeoutMs: t.Optional(t.Integer({ minimum: 1000, maximum: 120_000 })),
  /** Métodos HTTP aceitos no endpoint público. Default ['POST']. */
  allowedMethods: t.Optional(t.Array(webhookMethodEnum, { minItems: 1, maxItems: 5 })),
  /** Segredo HMAC. Null/undefined remove a exigência de assinatura. */
  hmacSecret: t.Optional(t.Union([t.String({ minLength: 16, maxLength: 256 }), t.Null()])),
};

// Config de `interval_trigger`. Validado estritamente porque o scheduler
// usa esses valores no upsert do BullMQ.
const intervalConfig = t.Object({
  every: t.Integer({ minimum: 1 }),
  unit: t.Union([
    t.Literal("seconds"),
    t.Literal("minutes"),
    t.Literal("hours"),
    t.Literal("days"),
  ]),
});

// Para os triggers cujo dispatch ainda não foi implementado, aceitamos a
// criação com config opaco — o registro fica armazenado e o poller/listener
// vai consumi-lo quando a Fase 3+ chegar.
const opaqueConfig = t.Record(t.String(), t.Unknown());

// Body de criação: union discriminada por `type`.
export const createTriggerBody = t.Union([
  t.Object({ type: t.Literal("cron"), ...baseFields, ...cronFields }),
  t.Object({ type: t.Literal("webhook"), ...baseFields, ...webhookFields }),
  t.Object({ type: t.Literal("interval_trigger"), ...baseFields, config: intervalConfig }),
  // Tipos com dispatch ainda pendente — registramos a config como blob livre.
  t.Object({
    type: t.Union([
      t.Literal("schedule_trigger"),
      t.Literal("email_trigger"),
      t.Literal("form_trigger"),
      t.Literal("chat_trigger"),
      t.Literal("error_trigger"),
      t.Literal("workflow_called_trigger"),
      t.Literal("rss_trigger"),
      t.Literal("postgres_trigger"),
      t.Literal("redis_trigger"),
    ]),
    ...baseFields,
    config: t.Optional(opaqueConfig),
  }),
]);

export const updateTriggerBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  enabled: t.Optional(t.Boolean()),
  environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  workflowVersionId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  nodeId: t.Optional(t.Union([t.String({ minLength: 1, maxLength: 128 }), t.Null()])),
  // Atualizar cron só faz sentido em triggers do tipo cron — validamos no controller.
  cronExpression: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  timezone: t.Optional(t.String({ maxLength: 64 })),
  // Patch parcial da config — o controller faz merge com a config atual.
  // Validação estrita por tipo é responsabilidade do controller.
  config: t.Optional(opaqueConfig),
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

// Body do endpoint de promote — explícito e separado do update genérico
// pra rastrear como ação distinta no audit log.
export const promoteTriggerBody = t.Object({
  workflowVersionId: t.Union([t.String({ format: "uuid" }), t.Null()]),
});
export type PromoteTriggerBody = typeof promoteTriggerBody.static;

export const triggerListQuery = t.Object({
  type: t.Optional(typeEnum),
});

export type CreateTriggerBody = typeof createTriggerBody.static;
export type UpdateTriggerBody = typeof updateTriggerBody.static;
