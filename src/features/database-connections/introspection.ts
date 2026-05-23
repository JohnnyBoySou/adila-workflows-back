import postgres from "postgres";

/**
 * Introspection de schema (Postgres-only) — usado pra alimentar autocomplete
 * Monaco no frontend (Drizzle ORM + SQL editor).
 *
 * Estratégia:
 *   - Lê `information_schema` num round-trip único (tabelas + colunas + PKs).
 *   - Filtra schemas internos do Postgres (`pg_catalog`, `information_schema`).
 *   - Cache em memória por `connectionId` com TTL de 5 minutos. Invalidar
 *     manualmente via `invalidateIntrospection(id)` quando a connection muda.
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

export interface DatabaseSchema {
  tables: SchemaTable[];
  fetchedAt: number;
}

// ── Mapeamento Postgres → tipo "lógico" ──────────────────────────────
function mapJsType(pgType: string): SchemaColumn["jsType"] {
  const t = pgType.toLowerCase();
  if (t.startsWith("int") || t === "bigint" || t === "smallint" || t === "real" || t === "double precision" || t === "numeric" || t === "decimal") return "number";
  if (t === "boolean" || t === "bool") return "boolean";
  if (t.startsWith("timestamp") || t === "date" || t === "time") return "date";
  if (t === "json" || t === "jsonb") return "json";
  if (t === "text" || t.startsWith("varchar") || t.startsWith("char") || t === "uuid") return "string";
  return "unknown";
}

// ── Cache simples em memória ─────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, DatabaseSchema>();

export function invalidateIntrospection(connectionId: string) {
  cache.delete(connectionId);
}

export async function fetchPostgresSchema(
  connectionId: string,
  connectionString: string,
  opts: { force?: boolean } = {},
): Promise<DatabaseSchema> {
  const cached = cache.get(connectionId);
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
      const key = `${r.table_schema}.${r.table_name}`;
      let table = tableMap.get(key);
      if (!table) {
        table = { schema: r.table_schema, name: r.table_name, columns: [] };
        tableMap.set(key, table);
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

    const result: DatabaseSchema = {
      tables: Array.from(tableMap.values()),
      fetchedAt: Date.now(),
    };
    cache.set(connectionId, result);
    return result;
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}
