import { t } from "elysia";
import { workflowStatus } from "../../db/schema";

const statusEnum = t.Union(workflowStatus.map((s) => t.Literal(s)));

export const createWorkflowBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  description: t.Optional(t.String({ maxLength: 1000 })),
  folderId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  definition: t.Optional(t.Record(t.String(), t.Unknown())),
});

export const updateWorkflowBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  description: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
  status: t.Optional(statusEnum),
  folderId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  definition: t.Optional(t.Record(t.String(), t.Unknown())),
});

export const listWorkflowsQuery = t.Object({
  status: t.Optional(statusEnum),
  // `null` ou "root" => sem pasta. UUID => filtra pela pasta.
  folderId: t.Optional(t.Union([t.String(), t.Null()])),
  // Busca textual por nome (case-insensitive, substring).
  q: t.Optional(t.String({ maxLength: 120 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 20 })),
  offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
});

export const workflowIdParam = t.Object({
  id: t.String({ format: "uuid" }),
});

// Body do import-from-n8n: aceita o JSON cru do n8n + overrides opcionais.
// Não validamos o shape interno (a função `importN8nWorkflow` é robusta a sujeira).
export const importN8nBody = t.Object({
  workflow: t.Record(t.String(), t.Unknown()),
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  folderId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
});

export const runWorkflowBody = t.Optional(
  t.Object({
    environmentId: t.Optional(t.String({ format: "uuid" })),
    input: t.Optional(t.Record(t.String(), t.Unknown())),
    // Saídas pinadas localmente no editor — o executor pula o handler
    // e usa o output fornecido pelo cliente, escrevendo o step como sucesso.
    // Útil pra desenvolvimento: não dispara API externa, não consome créditos
    // de AI, etc. Chave = nodeId; valor = output completo do nó.
    pinnedData: t.Optional(t.Record(t.String(), t.Record(t.String(), t.Unknown()))),
  }),
);

export type CreateWorkflowBody = typeof createWorkflowBody.static;
export type UpdateWorkflowBody = typeof updateWorkflowBody.static;
export type ListWorkflowsQuery = typeof listWorkflowsQuery.static;
export type RunWorkflowBody = typeof runWorkflowBody.static;
export type ImportN8nBody = typeof importN8nBody.static;
