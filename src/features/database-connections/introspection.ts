import postgres from "postgres";

/**
 * Introspection de schema (Postgres-only) — usado pra alimentar autocomplete
 * Monaco no frontend (Drizzle ORM + SQL editor).
 *
 * Estratégia:
 *   - Lê `information_schema` num round-trip único (tabelas + colunas + PKs).
 *   - Filtra schemas internos do Postgres (`pg_catalog`, `information_schema`).
 *   - Cache em memória por `(connectionId, database)` com TTL de 5 minutos.
 *     Uma connection pode apontar pra vários databases do mesmo cluster (o
 *     caller troca o database sobrescrevendo o pathname da URL), então o cache
 *     isola cada um. Invalidar via `invalidateIntrospection(id[, database])`.
 *
 * Limites de segurança:
 *   - Connection timeout de 8s (evita travar a request inteira).
 *   - Connection string é a já decifrada do repositório — o caller é HTTP
 *     autenticado e workflow-scoped; nunca exposta pro browser.
 */

export interface SchemaColumn {
  name: string;
  /** Tipo do Postgres (`text`, `int4`, `timestamptz`…). */
  dataType: string;
  /** Tipo "lógico" pra UI (`string`, `number`, `boolean`, `date`, `json`, `unknown`). */
  jsType: "string" | "number" | "boolean" | "date" | "json" | "unknown";
  nullable: boolean;
  isPrimaryKey: boolean;
  default: string | null;
}

export interface SchemaTable {
  schema: string;
  name: string;
  columns: SchemaColumn[];
}

/** Ação referencial de uma FK (`ON DELETE` / `ON UPDATE`). */
export type ForeignKeyAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface SchemaForeignKey {
  /** Nome da constraint (usado pra dropar). */
  name: string;
  /** Tabela que referencia (lado da FK). */
  schema: string;
  table: string;
  columns: string[];
  /** Tabela referenciada (lado da PK/unique). */
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: ForeignKeyAction;
  onDelete: ForeignKeyAction;
}

export interface DatabaseSchema {
  tables: SchemaTable[];
  /** Relações FK entre tabelas — alimenta o diagrama de schema (ER) na UI. */
  relationships: SchemaForeignKey[];
  fetchedAt: number;
}

// ── Mapeamento Postgres → tipo "lógico" ──────────────────────────────
function mapJsType(pgType: string): SchemaColumn["jsType"] {
  const t = pgType.toLowerCase();
  if (
    t.startsWith("int") ||
    t === "bigint" ||
    t === "smallint" ||
    t === "real" ||
    t === "double precision" ||
    t === "numeric" ||
    t === "decimal"
  )
    return "number";
  if (t === "boolean" || t === "bool") return "boolean";
  if (t.startsWith("timestamp") || t === "date" || t === "time") return "date";
  if (t === "json" || t === "jsonb") return "json";
  if (t === "text" || t.startsWith("varchar") || t.startsWith("char") || t === "uuid")
    return "string";
  return "unknown";
}

// ── Mapeamento do código de ação referencial do pg_constraint ────────
// `confdeltype`/`confupdtype` são chars: a=NO ACTION, r=RESTRICT,
// c=CASCADE, n=SET NULL, d=SET DEFAULT.
function mapFkAction(code: string): ForeignKeyAction {
  switch (code) {
    case "r":
      return "RESTRICT";
    case "c":
      return "CASCADE";
    case "n":
      return "SET NULL";
    case "d":
      return "SET DEFAULT";
    default:
      return "NO ACTION";
  }
}

// ── Cache simples em memória ─────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, DatabaseSchema>();

// Chave composta `(connectionId, database)`. Uma connection pode apontar pra
// vários databases do mesmo cluster; cada um tem schema próprio e precisa de
// entrada isolada no cache. `database` undefined == database default da URL.
function cacheKey(connectionId: string, database?: string): string {
  return `${connectionId}::${database ?? ""}`;
}

/**
 * Invalida o cache de introspection.
 *   - Com `database`: remove só a entrada daquele database.
 *   - Sem `database`: remove todas as entradas da connection (qualquer
 *     database) — usado quando a própria connection string muda/é removida.
 */
export function invalidateIntrospection(connectionId: string, database?: string) {
  if (database !== undefined) {
    cache.delete(cacheKey(connectionId, database));
    return;
  }
  const prefix = `${connectionId}::`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export async function fetchPostgresSchema(
  connectionId: string,
  connectionString: string,
  opts: { force?: boolean; database?: string } = {},
): Promise<DatabaseSchema> {
  const key = cacheKey(connectionId, opts.database);
  const cached = cache.get(key);
  if (!opts.force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached;
  }

  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 8,
    idle_timeout: 1,
    onnotice: () => {},
  });

  try {
    // Single round-trip: pega colunas, junta com PKs por column_name.
    const rows = await client<
      {
        table_schema: string;
        table_name: string;
        column_name: string;
        data_type: string;
        is_nullable: "YES" | "NO";
        column_default: string | null;
        is_primary_key: boolean;
      }[]
    >`
      SELECT
        c.table_schema,
        c.table_name,
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        COALESCE(pk.is_pk, false) AS is_primary_key
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT
          tc.table_schema,
          tc.table_name,
          kcu.column_name,
          true AS is_pk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk
        ON pk.table_schema = c.table_schema
       AND pk.table_name = c.table_name
       AND pk.column_name = c.column_name
      WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
        AND c.table_schema NOT LIKE 'pg_%'
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `;

    // Agrupa por (schema, table).
    const tableMap = new Map<string, SchemaTable>();
    for (const r of rows) {
      const tableKey = `${r.table_schema}.${r.table_name}`;
      let table = tableMap.get(tableKey);
      if (!table) {
        table = { schema: r.table_schema, name: r.table_name, columns: [] };
        tableMap.set(tableKey, table);
      }
      table.columns.push({
        name: r.column_name,
        dataType: r.data_type,
        jsType: mapJsType(r.data_type),
        nullable: r.is_nullable === "YES",
        isPrimaryKey: r.is_primary_key,
        default: r.column_default,
      });
    }

    // Foreign keys — via pg_constraint pra suportar FK composta e preservar a
    // ordem das colunas (unnest WITH ORDINALITY). information_schema.referential
    // não garante ordem em FK de múltiplas colunas.
    const fkRows = await client<
      {
        name: string;
        schema: string;
        table: string;
        ref_schema: string;
        ref_table: string;
        on_update: string;
        on_delete: string;
        columns: string[];
        ref_columns: string[];
      }[]
    >`
      SELECT
        con.conname AS name,
        ns.nspname  AS schema,
        cl.relname  AS table,
        nsf.nspname AS ref_schema,
        clf.relname AS ref_table,
        con.confupdtype AS on_update,
        con.confdeltype AS on_delete,
        (
          SELECT array_agg(att.attname ORDER BY u.ord)
          FROM unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
          JOIN pg_attribute att
            ON att.attrelid = con.conrelid AND att.attnum = u.attnum
        ) AS columns,
        (
          SELECT array_agg(att.attname ORDER BY u.ord)
          FROM unnest(con.confkey) WITH ORDINALITY AS u(attnum, ord)
          JOIN pg_attribute att
            ON att.attrelid = con.confrelid AND att.attnum = u.attnum
        ) AS ref_columns
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
      JOIN pg_class clf ON clf.oid = con.confrelid
      JOIN pg_namespace nsf ON nsf.oid = clf.relnamespace
      WHERE con.contype = 'f'
        AND ns.nspname NOT IN ('pg_catalog', 'information_schema')
        AND ns.nspname NOT LIKE 'pg_%'
      ORDER BY ns.nspname, cl.relname, con.conname
    `;

    const relationships: SchemaForeignKey[] = fkRows.map((r) => ({
      name: r.name,
      schema: r.schema,
      table: r.table,
      columns: [...(r.columns ?? [])],
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumns: [...(r.ref_columns ?? [])],
      onUpdate: mapFkAction(r.on_update),
      onDelete: mapFkAction(r.on_delete),
    }));

    const result: DatabaseSchema = {
      tables: Array.from(tableMap.values()),
      relationships,
      fetchedAt: Date.now(),
    };
    cache.set(key, result);
    return result;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
