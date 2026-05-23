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
