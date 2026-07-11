import { t } from "elysia";

// Nome curto, sem espaços extras — usado como chave humana no dropdown da UI
// e no dialog do node Postgres/Redis.
const namePattern = "^[A-Za-z][A-Za-z0-9 _-]{0,63}$";

const kindLiteral = t.Union([t.Literal("postgres"), t.Literal("redis"), t.Literal("pgvector")]);

export const createConnectionBody = t.Object({
  name: t.String({ pattern: namePattern, minLength: 1, maxLength: 64 }),
  kind: kindLiteral,
  /** `null` (ou omisso) = default, usado quando o run roda num env sem override. */
  environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  /**
   * URL crua (postgres://… ou redis://…). Cifrada no repositório antes de
   * persistir — nunca retornada na resposta.
   */
  connectionString: t.String({ minLength: 1, maxLength: 4096 }),
});

export const updateConnectionBody = t.Object({
  name: t.Optional(t.String({ pattern: namePattern, minLength: 1, maxLength: 64 })),
  environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  connectionString: t.Optional(t.String({ minLength: 1, maxLength: 4096 })),
});

// `id` aqui é o workflowId — sub-rota de /workflows/:id/database-connections.
export const connectionListParams = t.Object({
  id: t.String({ format: "uuid" }),
});

export const connectionParams = t.Object({
  id: t.String({ format: "uuid" }),
  connectionId: t.String({ format: "uuid" }),
});

export const connectionListQuery = t.Object({
  kind: t.Optional(kindLiteral),
  /** Filtra por env. Use a string "null" pra trazer só os defaults. */
  environmentId: t.Optional(t.String()),
});

// Database é um identificador permissivo (dígito inicial, `$`, `-`). Espelha
// `DATABASE_NAME_RE` em studio.ts e `databasePattern` em studio-schema.ts.
const databasePattern = "^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$";

export const schemaQuery = t.Object({
  /** `refresh=true` ignora o cache de 5min e refaz a introspection. */
  refresh: t.Optional(t.BooleanString()),
  /** Database alvo no cluster. Omitido = database default da connection. */
  database: t.Optional(t.String({ pattern: databasePattern, minLength: 1, maxLength: 63 })),
});

export type CreateConnectionBody = typeof createConnectionBody.static;
export type UpdateConnectionBody = typeof updateConnectionBody.static;
