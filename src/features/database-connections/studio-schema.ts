/**
 * Validação TypeBox dos endpoints do DB Studio.
 *
 * Os identificadores recebem só uma validação de forma aqui (pattern leve);
 * a checagem forte (existência + citação segura) acontece em `studio.ts`.
 */
import { t } from "elysia";

const identPattern = "^[A-Za-z_][A-Za-z0-9_]*$";
const ident = t.String({ pattern: identPattern, minLength: 1, maxLength: 63 });
const optionalSchema = t.Optional(t.String({ pattern: identPattern, minLength: 1, maxLength: 63 }));

// Database é um identificador mais permissivo (aceita dígito inicial, `$`, `-`).
// Espelha `DATABASE_NAME_RE` em studio.ts.
export const databasePattern = "^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$";
const optionalDatabase = t.Optional(t.String({ pattern: databasePattern, minLength: 1, maxLength: 63 }));

const filterOp = t.Union([
  t.Literal("="),
  t.Literal("!="),
  t.Literal(">"),
  t.Literal(">="),
  t.Literal("<"),
  t.Literal("<="),
  t.Literal("LIKE"),
  t.Literal("ILIKE"),
  t.Literal("IS NULL"),
  t.Literal("IS NOT NULL"),
  t.Literal("IN"),
]);

const filter = t.Object({
  column: ident,
  op: filterOp,
  value: t.Optional(t.Unknown()),
});

export const browseBody = t.Object({
  schema: optionalSchema,
  database: optionalDatabase,
  table: ident,
  limit: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
  offset: t.Optional(t.Integer({ minimum: 0 })),
  orderBy: t.Optional(ident),
  orderDir: t.Optional(t.Union([t.Literal("asc"), t.Literal("desc")])),
  filters: t.Optional(t.Array(filter, { maxItems: 25 })),
});

// Linha = mapa coluna→valor arbitrário (validado contra o schema no service).
const rowValues = t.Record(t.String(), t.Unknown());

export const insertRowBody = t.Object({
  schema: optionalSchema,
  database: optionalDatabase,
  table: ident,
  values: rowValues,
});

export const updateRowBody = t.Object({
  schema: optionalSchema,
  database: optionalDatabase,
  table: ident,
  pk: rowValues,
  set: rowValues,
});

export const deleteRowBody = t.Object({
  schema: optionalSchema,
  database: optionalDatabase,
  table: ident,
  pk: rowValues,
});

const columnDef = t.Object({
  name: ident,
  type: t.String({ minLength: 1, maxLength: 64 }),
  nullable: t.Optional(t.Boolean()),
  primaryKey: t.Optional(t.Boolean()),
  default: t.Optional(t.Union([t.String({ maxLength: 200 }), t.Null()])),
});

// Ação referencial — forma validada em `assertFkAction` (studio.ts).
const fkAction = t.Union([
  t.Literal("NO ACTION"),
  t.Literal("RESTRICT"),
  t.Literal("CASCADE"),
  t.Literal("SET NULL"),
  t.Literal("SET DEFAULT"),
]);

export const ddlBody = t.Union([
  t.Object({
    op: t.Literal("create_table"),
    schema: optionalSchema,
    database: optionalDatabase,
    table: ident,
    columns: t.Array(columnDef, { minItems: 1, maxItems: 100 }),
  }),
  t.Object({ op: t.Literal("drop_table"), schema: optionalSchema, database: optionalDatabase, table: ident }),
  t.Object({ op: t.Literal("rename_table"), schema: optionalSchema, database: optionalDatabase, table: ident, to: ident }),
  t.Object({ op: t.Literal("add_column"), schema: optionalSchema, database: optionalDatabase, table: ident, column: columnDef }),
  t.Object({ op: t.Literal("drop_column"), schema: optionalSchema, database: optionalDatabase, table: ident, column: ident }),
  t.Object({
    op: t.Literal("rename_column"),
    schema: optionalSchema,
    database: optionalDatabase,
    table: ident,
    column: ident,
    to: ident,
  }),
  t.Object({
    op: t.Literal("create_index"),
    schema: optionalSchema,
    database: optionalDatabase,
    table: ident,
    columns: t.Array(ident, { minItems: 1, maxItems: 32 }),
    unique: t.Optional(t.Boolean()),
    name: t.Optional(ident),
  }),
  t.Object({ op: t.Literal("drop_index"), schema: optionalSchema, database: optionalDatabase, index: ident }),
  t.Object({
    op: t.Literal("add_foreign_key"),
    schema: optionalSchema,
    database: optionalDatabase,
    table: ident,
    columns: t.Array(ident, { minItems: 1, maxItems: 32 }),
    refSchema: optionalSchema,
    refTable: ident,
    refColumns: t.Array(ident, { minItems: 1, maxItems: 32 }),
    name: t.Optional(ident),
    onUpdate: t.Optional(fkAction),
    onDelete: t.Optional(fkAction),
  }),
  t.Object({ op: t.Literal("drop_constraint"), schema: optionalSchema, database: optionalDatabase, table: ident, name: ident }),
  t.Object({
    op: t.Literal("alter_column_type"),
    schema: optionalSchema,
    database: optionalDatabase,
    table: ident,
    column: ident,
    type: t.String({ minLength: 1, maxLength: 64 }),
    using: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
  }),
]);

export const runQueryBody = t.Object({
  sql: t.String({ minLength: 1, maxLength: 100_000 }),
  database: optionalDatabase,
});

export type BrowseBody = typeof browseBody.static;
export type InsertRowBody = typeof insertRowBody.static;
export type UpdateRowBody = typeof updateRowBody.static;
export type DeleteRowBody = typeof deleteRowBody.static;
export type DdlBody = typeof ddlBody.static;
export type RunQueryBody = typeof runQueryBody.static;
