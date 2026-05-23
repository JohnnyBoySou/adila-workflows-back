import postgres from "postgres";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Executa uma query no Postgres.
 *
 * Config:
 *   - connectionString: string (templatable; tipicamente `{{ env.MY_DB_URL }}`)
 *   - query: string                   — SQL com placeholders $1, $2…
 *   - params?: unknown[]              — valores parametrizados (anti-SQLi)
 *
 * Output:
 *   { rows, rowCount }
 *
 * Nota de segurança: rejeitamos a connection string padrão da aplicação
 * pra evitar privilege escalation (workflows não devem ler tabelas do produto).
 * Configure uma DATABASE_URL separada como env var do workflow.
 */
const TIMEOUT_SECONDS = 30;

export const postgresHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  const connectionString = cfg.connectionString;
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("postgres: config.connectionString é obrigatório");
  }
  // Hard barrier: nunca falar com o banco do próprio produto.
  if (connectionString === context.env?.DATABASE_URL) {
    throw new Error("postgres: connectionString não pode apontar pro DB do app");
  }

  const query = cfg.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("postgres: config.query é obrigatório");
  }
  const params = Array.isArray(cfg.params) ? cfg.params : [];

  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: TIMEOUT_SECONDS,
    onnotice: () => {}, // silencia NOTICEs
  });

  try {
    const rows = (await sql.unsafe(query, params as never[])) as Record<string, unknown>[];
    return { output: { rows: [...rows], rowCount: rows.length } };
  } finally {
    await sql.end({ timeout: 1 });
  }
};
