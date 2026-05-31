/**
 * Compilador do query builder visual (nó `db_query`) — fonte de verdade do
 * worker. Recebe um `BuilderConfig` (desenhado no frontend) e produz
 * `{ sql, params }` parametrizado pra rodar via `sql.unsafe(sql, params)`.
 *
 * Espelha o `compileBuilder` do frontend (postgres-panel / DbQueryPanel),
 * mas é o lado autoritativo: o handler re-compila em runtime a partir do
 * `builder` config (após `renderTemplate` resolver os `{{ }}`), em vez de
 * confiar no SQL snapshot gravado no editor. Isso elimina drift e mantém
 * os valores sempre bindados ($1, $2…) — nunca concatenados.
 *
 * Segurança:
 *   - Identificadores (tabela/colunas) passam por `quoteIdent` — citados com
 *     aspas duplas e com `"` internos escapados. O handler ainda valida os
 *     nomes contra o schema introspectado antes de compilar (defesa dupla).
 *   - Valores entram exclusivamente como placeholders parametrizados.
 */

export type BuilderOp = "select" | "insert" | "update" | "delete";

export type BuilderOperator =
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "LIKE"
  | "ILIKE"
  | "IS NULL"
  | "IS NOT NULL"
  | "IN";

export interface BuilderFilter {
  id: string;
  column: string;
  op: BuilderOperator;
  /** Valor literal já resolvido (template `{{ }}` aplicado antes de compilar). */
  value: string | number | boolean | null;
}

export interface BuilderSetValue {
  id: string;
  column: string;
  value: string | number | boolean | null;
}

export interface BuilderConfig {
  op: BuilderOp;
  table?: string;
  columns?: string[];
  setValues?: BuilderSetValue[];
  filters?: BuilderFilter[];
  orderBy?: { column: string; direction: "asc" | "desc" } | null;
  limit?: number | null;
  offset?: number | null;
  returning?: boolean;
}

export const BUILDER_OPERATORS: BuilderOperator[] = [
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "LIKE",
  "ILIKE",
  "IN",
  "IS NULL",
  "IS NOT NULL",
];

export function isBuilderConfig(v: unknown): v is BuilderConfig {
  return !!v && typeof v === "object" && "op" in (v as Record<string, unknown>);
}

export function operatorNeedsValue(op: BuilderOperator): boolean {
  return op !== "IS NULL" && op !== "IS NOT NULL";
}

/**
 * Cita identificadores no padrão Postgres. Nomes simples (`[a-z_][a-z0-9_]*`)
 * passam crus; o resto é citado com aspas duplas e `"` internos duplicados.
 * Nunca produz SQL injetável a partir do nome — no pior caso vira um
 * identificador citado inválido que o Postgres rejeita.
 */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

/**
 * Coage um valor cru (string do editor ou já-tipado) ao tipo de bind certo.
 * Strings numéricas viram number, "true"/"false" viram boolean, "null" vira
 * null. Valores não-string passam direto.
 */
function coerce(raw: BuilderFilter["value"]): unknown {
  if (typeof raw !== "string") return raw;
  const s = raw.trim();
  if (s === "") return "";
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return raw;
}

/** Constrói `{ sql, params }` a partir do BuilderConfig. */
export function compileBuilder(cfg: BuilderConfig): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  if (!cfg.table) throw new Error("db_query: builder.table é obrigatório");

  const t = quoteIdent(cfg.table);

  const renderWhere = (): string => {
    const filters = (cfg.filters ?? []).filter((f) => f.column);
    if (filters.length === 0) return "";
    const parts = filters.map((f) => {
      const col = quoteIdent(f.column);
      if (f.op === "IS NULL") return `${col} IS NULL`;
      if (f.op === "IS NOT NULL") return `${col} IS NOT NULL`;
      if (f.op === "IN") {
        const items = String(f.value ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (items.length === 0) return "FALSE"; // IN vazio nunca casa
        const placeholders: string[] = [];
        for (const it of items) {
          params.push(coerce(it));
          placeholders.push(`$${params.length}`);
        }
        return `${col} IN (${placeholders.join(", ")})`;
      }
      params.push(coerce(f.value ?? ""));
      return `${col} ${f.op} $${params.length}`;
    });
    return `\nWHERE ${parts.join("\n  AND ")}`;
  };

  if (cfg.op === "select") {
    const cols =
      cfg.columns && cfg.columns.length > 0 ? cfg.columns.map(quoteIdent).join(", ") : "*";
    let sql = `SELECT ${cols}\nFROM ${t}`;
    sql += renderWhere();
    if (cfg.orderBy?.column) {
      sql += `\nORDER BY ${quoteIdent(cfg.orderBy.column)} ${cfg.orderBy.direction.toUpperCase()}`;
    }
    if (cfg.limit && cfg.limit > 0) sql += `\nLIMIT ${Math.floor(cfg.limit)}`;
    if (cfg.offset && cfg.offset > 0) sql += `\nOFFSET ${Math.floor(cfg.offset)}`;
    return { sql, params };
  }

  if (cfg.op === "insert") {
    const rows = (cfg.setValues ?? []).filter((s) => s.column);
    if (rows.length === 0) throw new Error("db_query: insert exige ao menos um valor");
    const cols = rows.map((r) => quoteIdent(r.column)).join(", ");
    const placeholders = rows
      .map((r) => {
        params.push(coerce(r.value ?? ""));
        return `$${params.length}`;
      })
      .join(", ");
    let sql = `INSERT INTO ${t} (${cols})\nVALUES (${placeholders})`;
    if (cfg.returning !== false) sql += `\nRETURNING *`;
    return { sql, params };
  }

  if (cfg.op === "update") {
    const rows = (cfg.setValues ?? []).filter((s) => s.column);
    if (rows.length === 0) throw new Error("db_query: update exige ao menos um SET");
    const sets = rows
      .map((r) => {
        params.push(coerce(r.value ?? ""));
        return `${quoteIdent(r.column)} = $${params.length}`;
      })
      .join(", ");
    let sql = `UPDATE ${t}\nSET ${sets}`;
    sql += renderWhere();
    if (cfg.returning !== false) sql += `\nRETURNING *`;
    return { sql, params };
  }

  // delete
  let sql = `DELETE FROM ${t}`;
  sql += renderWhere();
  if (cfg.returning !== false) sql += `\nRETURNING *`;
  return { sql, params };
}
