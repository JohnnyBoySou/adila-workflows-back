import { t } from "elysia";

export const createFolderBody = t.Object({
  name: t.String({ minLength: 1, maxLength: 120 }),
  parentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
});

export const updateFolderBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  parentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
});

export const listFoldersQuery = t.Object({
  // Quando informado, lista somente os filhos diretos desse pai (use "root" para raiz).
  parentId: t.Optional(t.Union([t.String(), t.Null()])),
});

export const folderIdParam = t.Object({
  id: t.String({ format: "uuid" }),
});

export type CreateFolderBody = typeof createFolderBody.static;
export type UpdateFolderBody = typeof updateFolderBody.static;
export type ListFoldersQuery = typeof listFoldersQuery.static;
