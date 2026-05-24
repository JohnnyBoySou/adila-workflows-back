import { t } from "elysia";

export const workflowIdParams = t.Object({ id: t.String({ format: "uuid" }) });
export const commentParams = t.Object({
  id: t.String({ format: "uuid" }),
  commentId: t.String({ format: "uuid" }),
});

export const createCommentBody = t.Object({
  body: t.String({ minLength: 1, maxLength: 4000 }),
  mentions: t.Optional(t.Array(t.String({ minLength: 1 }), { default: [] })),
  // Raiz: x e y obrigatórios. Reply: parentId setado, x/y omitidos.
  x: t.Optional(t.Number()),
  y: t.Optional(t.Number()),
  parentId: t.Optional(t.String({ format: "uuid" })),
});

export const updateCommentBody = t.Object({
  body: t.Optional(t.String({ minLength: 1, maxLength: 4000 })),
  mentions: t.Optional(t.Array(t.String({ minLength: 1 }))),
  resolved: t.Optional(t.Boolean()),
});
