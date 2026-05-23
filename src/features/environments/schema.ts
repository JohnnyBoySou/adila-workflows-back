import { t } from "elysia";
import { environmentKind } from "../../db/schema";

const kindEnum = t.Union(environmentKind.map((k) => t.Literal(k)));
const slugPattern = "^[a-z0-9][a-z0-9-_]{0,62}$";

export const createEnvironmentBody = t.Object({
  slug: t.String({ pattern: slugPattern, minLength: 1, maxLength: 63 }),
  name: t.String({ minLength: 1, maxLength: 120 }),
  kind: t.Optional(kindEnum),
  description: t.Optional(t.String({ maxLength: 1000 })),
  isDefault: t.Optional(t.Boolean()),
});

export const updateEnvironmentBody = t.Object({
  slug: t.Optional(t.String({ pattern: slugPattern, minLength: 1, maxLength: 63 })),
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  kind: t.Optional(kindEnum),
  description: t.Optional(t.Union([t.String({ maxLength: 1000 }), t.Null()])),
  isDefault: t.Optional(t.Boolean()),
});

export const environmentIdParam = t.Object({
  id: t.String({ format: "uuid" }),
});

export type CreateEnvironmentBody = typeof createEnvironmentBody.static;
export type UpdateEnvironmentBody = typeof updateEnvironmentBody.static;
