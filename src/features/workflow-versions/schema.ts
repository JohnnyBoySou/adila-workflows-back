import { t } from "elysia";

export const workflowVersionParams = t.Object({
  id: t.String({ format: "uuid" }),
  versionId: t.String({ format: "uuid" }),
});

export const workflowVersionsListParams = t.Object({
  id: t.String({ format: "uuid" }),
});

export const publishVersionBody = t.Optional(
  t.Object({
    // Rótulo opcional. Definition vem do draft atual do workflow.
    name: t.Optional(t.String({ maxLength: 120 })),
  }),
);

export type PublishVersionBody = typeof publishVersionBody.static;

export const workflowVersionDiffParams = t.Object({
  id: t.String({ format: "uuid" }),
  versionId: t.String({ format: "uuid" }),
  toId: t.String({ format: "uuid" }),
});

// Só `name` é mutável. `definition` continua imutável — versões publicadas
// são append-only por design.
export const renameVersionBody = t.Object({
  name: t.Union([t.String({ maxLength: 120 }), t.Null()]),
});
export type RenameVersionBody = typeof renameVersionBody.static;

// `triggerIds` omitido = promove TODOS os triggers do workflow.
// Lista vazia = no-op (preferimos rejeitar no caller, mas o controller tolera).
export const promoteBulkBody = t.Object({
  triggerIds: t.Optional(t.Array(t.String({ format: "uuid" }))),
});
export type PromoteBulkBody = typeof promoteBulkBody.static;
