/**
 * DB Studio — execução server-side das operações de dados e DDL (Postgres-only).
 *
 * Este módulo é o "motor" do estúdio embutido no nó DB. Roda exclusivamente
 * atrás de endpoints HTTP admin-gated (`requireRole("owner","admin")`) e
 * auditados. Toda a segurança vive aqui:
 *
 *  - Identificadores (schema/tabela/coluna) SEMPRE validados contra um regex
 *    estrito e citados via `qid`. Para browse/mutação de linhas, também
 *    confirmamos que a tabela/coluna existe no schema introspectado — nada de
 *    tocar em catálogos internos do Postgres.
 *  - Valores SEMPRE entram como params posicionais (`$1`, `$2`…), nunca
 *    concatenados. Colunas json/jsonb recebem cast explícito (`$n::jsonb`).
 *  - `statement_timeout` por sessão + teto de linhas (browse e console SQL).
 *  - Tipos de coluna em DDL restritos a um allowlist.
 *
 * A connection string decifrada vem do repositório (worker-side); o CRUD já
 * proíbe apontar pro DB do app, então qualquer connection persistida é segura.
 */
import postgres from "postgres";
import type { DecryptedConnection } from "./repository";
import {
  fetchPostgresSchema,
  invalidateIntrospection,
  type DatabaseSchema,
  type SchemaColumn,
} from "./introspection";

// ── Erro tipado pra mapear status HTTP ──────────────────────────────────
export class StudioError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StudioError";
  }
}

// ── Limites de segurança ────────────────────────────────────────────────
const STATEMENT_TIMEOUT_MS = 15_000;
const CONNECT_TIMEOUT_S = 10;
const MAX_ROW_LIMIT = 500;
const DEFAULT_ROW_LIMIT = 50;
const MAX_CONSOLE_ROWS = 1_000;

// ── Identificadores ─────────────────────────────────────────────────────
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, label = "identificador"): string {
  if (typeof name !== "string" || !IDENT_RE.test(name)) {
    throw new StudioError("invalid_identifier", `${label} inválido: ${JSON.stringify(name)}`);
  }
  return name;
}

/** Cita um identificador já validado pelo regex (sem aspas internas possíveis). */
function qid(name: string, label?: string): string {
  return `"${assertIdent(name, label)}"`;
}

function qualified(schema: string, table: string): string {
  return `${qid(schema, "schema")}.${qid(table, "tabela")}`;
}

// ── Database (multi-db por connection) ──────────────────────────────────
// Uma connection string codifica UM database. Pra operar em outro database do
// mesmo cluster, sobrescrevemos o pathname da URL em runtime (RAM). O nome do
// database NUNCA é interpolado em SQL — só vai no pathname de uma URL, então o
// risco de injeção é só de identificador. Mesmo assim validamos com regex
// estrito antes de qualquer uso (defesa em profundidade).
const DATABASE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/;

/** Valida um nome de database contra o regex estrito. Retorna o nome. */
export function assertDatabase(name: string): string {
  if (typeof name !== "string" || !DATABASE_NAME_RE.test(name)) {
    throw new StudioError("invalid_database", `database inválido: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Retorna a connection string apontando pro `database` informado. Sem
 * `database`, devolve a original (database default da URL). A troca é só no
 * pathname — credenciais, host, porta e querystring são preservados.
 */
export function applyDatabase(connectionString: string, database?: string): string {
  if (!database) return connectionString;
  assertDatabase(database);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new StudioError("invalid_connection_url", "connection string inválida pra troca de database");
  }
  url.pathname = `/${database}`;
  return url.toString();
}

// ── Operadores de filtro (browse) ───────────────────────────────────────
const FILTER_OPS = {
  "=": "=",
  "!=": "!=",
  ">": ">",
  ">=": ">=",
  "<": "<",
  "<=": "<=",
  LIKE: "LIKE",
  ILIKE: "ILIKE",
  "IS NULL": "IS NULL",
  "IS NOT NULL": "IS NOT NULL",
  IN: "IN",
} as const;
export type StudioFilterOp = keyof typeof FILTER_OPS;

export interface StudioFilter {
  column: string;
  op: StudioFilterOp;
  value?: unknown;
}

// ── Tipos de coluna permitidos em DDL ───────────────────────────────────
const ALLOWED_COLUMN_TYPES = new Set([
  "text",
  "varchar",
  "char",
  "integer",
  "int",
  "int4",
  "bigint",
  "int8",
  "smallint",
  "int2",
  "boolean",
  "bool",
  "numeric",
  "decimal",
  "real",
  "double precision",
  "date",
  "timestamp",
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
  "time",
  "uuid",
  "json",
  "jsonb",
  "serial",
  "bigserial",
  "smallserial",
]);

// ── Ações referenciais permitidas em FK (ON DELETE / ON UPDATE) ─────────
const ALLOWED_FK_ACTIONS = new Set([
  "NO ACTION",
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
]);

/** Valida e normaliza uma ação referencial de FK contra o allowlist. */
export function assertFkAction(raw: string): string {
  if (typeof raw !== "string") throw new StudioError("invalid_fk_action", "ação de FK ausente");
  const normalized = raw.trim().toUpperCase().replace(/\s+/g, " ");
  if (!ALLOWED_FK_ACTIONS.has(normalized)) {
    throw new StudioError("invalid_fk_action", `ação de FK não permitida: ${JSON.stringify(raw)}`);
  }
  return normalized;
}

/**
 * Valida um tipo de coluna. Aceita o tipo base + um modificador de tamanho
 * opcional entre parênteses (`varchar(255)`, `numeric(10,2)`). O modificador
 * só pode conter dígitos e vírgula — nada de SQL solto.
 */
export function assertColumnType(raw: string): string {
  if (typeof raw !== "string") throw new StudioError("invalid_type", "tipo de coluna ausente");
  const trimmed = raw.trim().toLowerCase();
  const m = trimmed.match(/^([a-z ]+?)(\((\d+(,\d+)?)\))?$/);
  if (!m) throw new StudioError("invalid_type", `tipo inválido: ${JSON.stringify(raw)}`);
  const base = m[1]!.trim();
  if (!ALLOWED_COLUMN_TYPES.has(base)) {
    throw new StudioError("invalid_type", `tipo não permitido: ${JSON.stringify(base)}`);
  }
  return m[2] ? `${base}${m[2]}` : base;
}

// ── Cliente Postgres com guard-rails ────────────────────────────────────
async function withClient<T>(
  connectionString: string,
  fn: (sql: postgres.Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: CONNECT_TIMEOUT_S,
    onnotice: () => {},
  });
  try {
    // SET não aceita placeholder; o valor é um número literal nosso (seguro).
    await sql.unsafe(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

function ensurePostgres(conn: DecryptedConnection): void {
  if (conn.kind !== "postgres") {
    throw new StudioError("not_supported_for_kind", "Studio só suporta connections postgres.");
  }
}

// ── Validação contra o schema introspectado ─────────────────────────────
interface ResolvedTable {
  schema: string;
  table: string;
  columns: SchemaColumn[];
  columnByName: Map<string, SchemaColumn>;
}

async function resolveTable(
  conn: DecryptedConnection,
  connectionString: string,
  database: string | undefined,
  schemaName: string | undefined,
  tableName: string,
): Promise<{ schema: DatabaseSchema; table: ResolvedTable }> {
  const targetSchema = schemaName ?? "public";
  assertIdent(targetSchema, "schema");
  assertIdent(tableName, "tabela");

  const schema = await fetchPostgresSchema(conn.id, connectionString, { database });
  const match = schema.tables.find((t) => t.schema === targetSchema && t.name === tableName);
  if (!match) {
    throw new StudioError("table_not_found", `tabela ${targetSchema}.${tableName} não encontrada`);
  }
  return {
    schema,
    table: {
      schema: targetSchema,
      table: tableName,
      columns: match.columns,
      columnByName: new Map(match.columns.map((c) => [c.name, c])),
    },
  };
}

function assertColumn(table: ResolvedTable, column: string): SchemaColumn {
  const col = table.columnByName.get(column);
  if (!col) {
    throw new StudioError(
      "column_not_found",
      `coluna ${JSON.stringify(column)} não existe em ${table.schema}.${table.table}`,
    );
  }
  return col;
}

/** Serializa um valor pro placeholder, com cast quando a coluna é json/jsonb. */
function bindForColumn(col: SchemaColumn, value: unknown): { placeholder: string; param: unknown } {
  if (col.jsType === "json") {
    const param = typeof value === "string" ? value : JSON.stringify(value);
    return { placeholder: "::jsonb", param };
  }
  return { placeholder: "", param: value };
}

// ── Coerção de valores de filtro (browse) ───────────────────────────────
function coerceFilterValue(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  if (raw === "") return "";
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Monta a cláusula WHERE parametrizada a partir dos filtros validados. */
function buildWhere(
  table: ResolvedTable,
  filters: StudioFilter[] | undefined,
  params: unknown[],
): string {
  if (!filters || filters.length === 0) return "";
  const clauses: string[] = [];
  for (const f of filters) {
    assertColumn(table, f.column);
    const op = FILTER_OPS[f.op];
    if (!op) throw new StudioError("invalid_operator", `operador inválido: ${f.op}`);
    const col = qid(f.column, "coluna");

    if (f.op === "IS NULL" || f.op === "IS NOT NULL") {
      clauses.push(`${col} ${op}`);
      continue;
    }
    if (f.op === "IN") {
      const list = String(f.value ?? "")
        .split(",")
        .map((s) => coerceFilterValue(s.trim()))
        .filter((s) => s !== "");
      if (list.length === 0) {
        clauses.push("FALSE");
        continue;
      }
      const ph = list.map((v) => {
        params.push(v);
        return `$${params.length}`;
      });
      clauses.push(`${col} IN (${ph.join(", ")})`);
      continue;
    }
    params.push(coerceFilterValue(f.value));
    clauses.push(`${col} ${op} $${params.length}`);
  }
  return clauses.length ? `\nWHERE ${clauses.join(" AND ")}` : "";
}

// ── Operações de dados ──────────────────────────────────────────────────

export interface BrowseInput {
  schema?: string;
  /** Database alvo no cluster. Omitido = database default da connection. */
  database?: string;
  table: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDir?: "asc" | "desc";
  filters?: StudioFilter[];
}

export interface BrowseResult {
  rows: Record<string, unknown>[];
  columns: SchemaColumn[];
  totalCount: number;
  limit: number;
  offset: number;
}

export async function browseRows(
  conn: DecryptedConnection,
  input: BrowseInput,
): Promise<BrowseResult> {
  ensurePostgres(conn);
  const connectionString = applyDatabase(conn.connectionString, input.database);
  const { table } = await resolveTable(conn, connectionString, input.database, input.schema, input.table);

  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? DEFAULT_ROW_LIMIT)), MAX_ROW_LIMIT);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));

  const params: unknown[] = [];
  const where = buildWhere(table, input.filters, params);

  let order = "";
  if (input.orderBy) {
    assertColumn(table, input.orderBy);
    const dir = input.orderDir === "desc" ? "DESC" : "ASC";
    order = `\nORDER BY ${qid(input.orderBy, "coluna")} ${dir}`;
  }

  const rel = qualified(table.schema, table.table);
  const dataSql = `SELECT * FROM ${rel}${where}${order}\nLIMIT ${limit} OFFSET ${offset}`;
  const countSql = `SELECT count(*)::bigint AS n FROM ${rel}${where}`;

  return withClient(connectionString, async (sql) => {
    const rows = (await sql.unsafe(dataSql, params as never[])) as Record<string, unknown>[];
    const countRows = (await sql.unsafe(countSql, params as never[])) as { n: string }[];
    const totalCount = Number(countRows[0]?.n ?? 0);
    return { rows: [...rows], columns: table.columns, totalCount, limit, offset };
  });
}

export interface InsertRowInput {
  schema?: string;
  database?: string;
  table: string;
  values: Record<string, unknown>;
}

export async function insertRow(
  conn: DecryptedConnection,
  input: InsertRowInput,
): Promise<Record<string, unknown>> {
  ensurePostgres(conn);
  const connectionString = applyDatabase(conn.connectionString, input.database);
  const { table } = await resolveTable(conn, connectionString, input.database, input.schema, input.table);

  const entries = Object.entries(input.values ?? {});
  if (entries.length === 0) throw new StudioError("empty_values", "nenhum valor pra inserir");

  const cols: string[] = [];
  const placeholders: string[] = [];
  const params: unknown[] = [];
  for (const [name, value] of entries) {
    const col = assertColumn(table, name);
    cols.push(qid(name, "coluna"));
    const { placeholder, param } = bindForColumn(col, value);
    params.push(param);
    placeholders.push(`$${params.length}${placeholder}`);
  }

  const rel = qualified(table.schema, table.table);
  const query = `INSERT INTO ${rel} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *`;
  return withClient(connectionString, async (sql) => {
    const rows = (await sql.unsafe(query, params as never[])) as Record<string, unknown>[];
    return rows[0] ?? {};
  });
}

export interface UpdateRowInput {
  schema?: string;
  database?: string;
  table: string;
  /** Identidade da linha — tipicamente a PK. Todas as condições são AND. */
  pk: Record<string, unknown>;
  set: Record<string, unknown>;
}

export async function updateRow(
  conn: DecryptedConnection,
  input: UpdateRowInput,
): Promise<Record<string, unknown>> {
  ensurePostgres(conn);
  const connectionString = applyDatabase(conn.connectionString, input.database);
  const { table } = await resolveTable(conn, connectionString, input.database, input.schema, input.table);

  const setEntries = Object.entries(input.set ?? {});
  const pkEntries = Object.entries(input.pk ?? {});
  if (setEntries.length === 0) throw new StudioError("empty_values", "nenhum valor pra atualizar");
  if (pkEntries.length === 0) {
    throw new StudioError("missing_pk", "identidade da linha (pk) obrigatória pra UPDATE");
  }

  const params: unknown[] = [];
  const setClauses = setEntries.map(([name, value]) => {
    const col = assertColumn(table, name);
    const { placeholder, param } = bindForColumn(col, value);
    params.push(param);
    return `${qid(name, "coluna")} = $${params.length}${placeholder}`;
  });
  const whereClauses = pkEntries.map(([name, value]) => {
    const col = assertColumn(table, name);
    if (value === null) return `${qid(name, "coluna")} IS NULL`;
    const { placeholder, param } = bindForColumn(col, value);
    params.push(param);
    return `${qid(name, "coluna")} = $${params.length}${placeholder}`;
  });

  const rel = qualified(table.schema, table.table);
  const query = `UPDATE ${rel} SET ${setClauses.join(", ")} WHERE ${whereClauses.join(" AND ")} RETURNING *`;
  return withClient(connectionString, async (sql) => {
    const rows = (await sql.unsafe(query, params as never[])) as Record<string, unknown>[];
    if (rows.length === 0) throw new StudioError("row_not_found", "nenhuma linha bateu com a pk");
    return rows[0]!;
  });
}

export interface DeleteRowInput {
  schema?: string;
  database?: string;
  table: string;
  pk: Record<string, unknown>;
}

export async function deleteRow(
  conn: DecryptedConnection,
  input: DeleteRowInput,
): Promise<{ deleted: number }> {
  ensurePostgres(conn);
  const connectionString = applyDatabase(conn.connectionString, input.database);
  const { table } = await resolveTable(conn, connectionString, input.database, input.schema, input.table);

  const pkEntries = Object.entries(input.pk ?? {});
  if (pkEntries.length === 0) {
    throw new StudioError("missing_pk", "identidade da linha (pk) obrigatória pra DELETE");
  }

  const params: unknown[] = [];
  const whereClauses = pkEntries.map(([name, value]) => {
    const col = assertColumn(table, name);
    if (value === null) return `${qid(name, "coluna")} IS NULL`;
    const { placeholder, param } = bindForColumn(col, value);
    params.push(param);
    return `${qid(name, "coluna")} = $${params.length}${placeholder}`;
  });

  const rel = qualified(table.schema, table.table);
  const query = `DELETE FROM ${rel} WHERE ${whereClauses.join(" AND ")}`;
  return withClient(connectionString, async (sql) => {
    const result = await sql.unsafe(query, params as never[]);
    return { deleted: result.count ?? 0 };
  });
}

// ── DDL estruturado ─────────────────────────────────────────────────────

export interface DdlColumnDef {
  name: string;
  type: string;
  nullable?: boolean;
  primaryKey?: boolean;
  /** Default cru (ex: `now()`, `0`, `'pending'`). Validado de forma leve. */
  default?: string | null;
}

// Toda variante carrega `database?` opcional — o database alvo no cluster
// (omitido = database default da connection). Threaded em `runDdl`.
export type DdlOp =
  | { op: "create_table"; schema?: string; database?: string; table: string; columns: DdlColumnDef[] }
  | { op: "drop_table"; schema?: string; database?: string; table: string }
  | { op: "rename_table"; schema?: string; database?: string; table: string; to: string }
  | { op: "add_column"; schema?: string; database?: string; table: string; column: DdlColumnDef }
  | { op: "drop_column"; schema?: string; database?: string; table: string; column: string }
  | { op: "rename_column"; schema?: string; database?: string; table: string; column: string; to: string }
  | { op: "create_index"; schema?: string; database?: string; table: string; columns: string[]; unique?: boolean; name?: string }
  | { op: "drop_index"; schema?: string; database?: string; index: string }
  | {
      op: "add_foreign_key";
      schema?: string;
      database?: string;
      table: string;
      columns: string[];
      refSchema?: string;
      refTable: string;
      refColumns: string[];
      name?: string;
      onUpdate?: string;
      onDelete?: string;
    }
  | { op: "drop_constraint"; schema?: string; database?: string; table: string; name: string }
  | { op: "alter_column_type"; schema?: string; database?: string; table: string; column: string; type: string; using?: string };

/**
 * Defaults são o único ponto onde aceitamos SQL "cru" no DDL. Restringimos a
 * literais simples / chamadas de função sem ponto-e-vírgula, parênteses
 * balanceados básicos e sem comentários. Não é um parser completo, mas corta
 * injeção de statements (`;`, `--`, `/*`).
 */
function assertDefault(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length > 200) throw new StudioError("invalid_default", "default muito longo");
  if (/;|--|\/\*|\*\//.test(trimmed)) {
    throw new StudioError("invalid_default", "default contém tokens não permitidos");
  }
  return trimmed;
}

/**
 * Cláusula `USING` do `ALTER COLUMN ... TYPE` — única parte "crua" da conversão
 * de tipo. Mesma proteção do default: sem statement-injection (`;`, `--`,
 * comentários) e tamanho limitado. Não é um parser; o gate é role + audit.
 */
function assertUsing(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new StudioError("invalid_using", "expressão USING vazia");
  if (trimmed.length > 200) throw new StudioError("invalid_using", "expressão USING muito longa");
  if (/;|--|\/\*|\*\//.test(trimmed)) {
    throw new StudioError("invalid_using", "expressão USING contém tokens não permitidos");
  }
  return trimmed;
}

function renderColumnDef(def: DdlColumnDef): string {
  const parts = [qid(def.name, "coluna"), assertColumnType(def.type)];
  if (def.primaryKey) parts.push("PRIMARY KEY");
  if (def.nullable === false) parts.push("NOT NULL");
  if (def.default != null && def.default !== "") parts.push(`DEFAULT ${assertDefault(def.default)}`);
  return parts.join(" ");
}

export function buildDdl(op: DdlOp): string {
  switch (op.op) {
    case "create_table": {
      if (!op.columns || op.columns.length === 0) {
        throw new StudioError("empty_columns", "tabela precisa de ao menos uma coluna");
      }
      const rel = qualified(op.schema ?? "public", op.table);
      const cols = op.columns.map(renderColumnDef).join(",\n  ");
      return `CREATE TABLE ${rel} (\n  ${cols}\n)`;
    }
    case "drop_table":
      return `DROP TABLE ${qualified(op.schema ?? "public", op.table)}`;
    case "rename_table":
      return `ALTER TABLE ${qualified(op.schema ?? "public", op.table)} RENAME TO ${qid(op.to, "tabela")}`;
    case "add_column":
      return `ALTER TABLE ${qualified(op.schema ?? "public", op.table)} ADD COLUMN ${renderColumnDef(op.column)}`;
    case "drop_column":
      return `ALTER TABLE ${qualified(op.schema ?? "public", op.table)} DROP COLUMN ${qid(op.column, "coluna")}`;
    case "rename_column":
      return `ALTER TABLE ${qualified(op.schema ?? "public", op.table)} RENAME COLUMN ${qid(op.column, "coluna")} TO ${qid(op.to, "coluna")}`;
    case "create_index": {
      if (!op.columns || op.columns.length === 0) {
        throw new StudioError("empty_columns", "índice precisa de ao menos uma coluna");
      }
      const rel = qualified(op.schema ?? "public", op.table);
      const cols = op.columns.map((c) => qid(c, "coluna")).join(", ");
      const unique = op.unique ? "UNIQUE " : "";
      const name = op.name
        ? qid(op.name, "índice")
        : qid(`idx_${op.table}_${op.columns.join("_")}`, "índice");
      return `CREATE ${unique}INDEX ${name} ON ${rel} (${cols})`;
    }
    case "drop_index":
      return `DROP INDEX ${qualified(op.schema ?? "public", op.index)}`;
    case "add_foreign_key": {
      if (!op.columns || op.columns.length === 0) {
        throw new StudioError("empty_columns", "FK precisa de ao menos uma coluna");
      }
      if (!op.refColumns || op.refColumns.length === 0) {
        throw new StudioError("empty_columns", "FK precisa de ao menos uma coluna referenciada");
      }
      if (op.columns.length !== op.refColumns.length) {
        throw new StudioError("invalid_fk", "número de colunas da FK não bate com as referenciadas");
      }
      const rel = qualified(op.schema ?? "public", op.table);
      const refRel = qualified(op.refSchema ?? op.schema ?? "public", op.refTable);
      const cols = op.columns.map((c) => qid(c, "coluna")).join(", ");
      const refCols = op.refColumns.map((c) => qid(c, "coluna")).join(", ");
      const name = op.name
        ? qid(op.name, "constraint")
        : qid(`fk_${op.table}_${op.columns.join("_")}`, "constraint");
      const onDelete = op.onDelete ? ` ON DELETE ${assertFkAction(op.onDelete)}` : "";
      const onUpdate = op.onUpdate ? ` ON UPDATE ${assertFkAction(op.onUpdate)}` : "";
      return `ALTER TABLE ${rel} ADD CONSTRAINT ${name} FOREIGN KEY (${cols}) REFERENCES ${refRel} (${refCols})${onDelete}${onUpdate}`;
    }
    case "drop_constraint":
      return `ALTER TABLE ${qualified(op.schema ?? "public", op.table)} DROP CONSTRAINT ${qid(op.name, "constraint")}`;
    case "alter_column_type": {
      const rel = qualified(op.schema ?? "public", op.table);
      const using = op.using ? ` USING ${assertUsing(op.using)}` : "";
      return `ALTER TABLE ${rel} ALTER COLUMN ${qid(op.column, "coluna")} TYPE ${assertColumnType(op.type)}${using}`;
    }
    default: {
      const _exhaustive: never = op;
      throw new StudioError("invalid_op", `operação DDL desconhecida: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export async function runDdl(conn: DecryptedConnection, op: DdlOp): Promise<{ statement: string }> {
  ensurePostgres(conn);
  const connectionString = applyDatabase(conn.connectionString, op.database);
  const statement = buildDdl(op);
  await withClient(connectionString, async (sql) => {
    await sql.unsafe(statement);
  });
  // O schema mudou — invalida o cache de introspection daquele database.
  invalidateIntrospection(conn.id, op.database);
  return { statement };
}

// ── Console SQL cru ─────────────────────────────────────────────────────

export interface RunQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  fields: string[];
}

/**
 * Executa SQL arbitrário (uma única statement). É a aba "SQL" do estúdio —
 * o usuário já é admin e a operação é auditada. Guard-rails: statement_timeout
 * + teto de linhas retornadas. Não tentamos impedir DDL/DML aqui de propósito:
 * é um console de admin. A proteção é o gate de role + audit + timeout.
 */
export async function runQuery(
  conn: DecryptedConnection,
  rawSql: string,
  database?: string,
): Promise<RunQueryResult> {
  ensurePostgres(conn);
  const trimmed = rawSql.trim();
  if (!trimmed) throw new StudioError("empty_query", "query vazia");
  if (trimmed.length > 100_000) throw new StudioError("query_too_long", "query muito longa");

  const connectionString = applyDatabase(conn.connectionString, database);
  return withClient(connectionString, async (sql) => {
    const result = (await sql.unsafe(trimmed)) as unknown as Record<string, unknown>[];
    const all = Array.isArray(result) ? result : [];
    const truncated = all.length > MAX_CONSOLE_ROWS;
    const rows = truncated ? all.slice(0, MAX_CONSOLE_ROWS) : all;
    const fields = rows.length > 0 ? Object.keys(rows[0]!) : [];
    return { rows: [...rows], rowCount: all.length, truncated, fields };
  });
}

// ── Lista de databases do cluster ───────────────────────────────────────

export interface DatabaseInfo {
  name: string;
  /** `true` no database em que a connection está conectada por padrão. */
  current: boolean;
}

/**
 * Lista os databases do cluster (exceto templates e os que não aceitam
 * conexão). Marca qual é o database "atual" (o do pathname da connection).
 */
export async function listDatabases(conn: DecryptedConnection): Promise<DatabaseInfo[]> {
  ensurePostgres(conn);
  return withClient(conn.connectionString, async (sql) => {
    const rows = (await sql.unsafe(
      `SELECT datname AS name, datname = current_database() AS current
       FROM pg_database
       WHERE datistemplate = false AND datallowconn = true
       ORDER BY datname`,
    )) as unknown as { name: string; current: boolean }[];
    return rows.map((r) => ({ name: r.name, current: r.current === true }));
  });
}
