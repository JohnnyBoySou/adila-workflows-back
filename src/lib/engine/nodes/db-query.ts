import postgres from "postgres";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";
import { compileBuilder, isBuilderConfig } from "./query-builder/compile";

/**
 * Nó `db_query` — query builder visual dedicado (Postgres).
 *
 * Diferente do nó `postgres` (que aceita SQL cru, ORM Drizzle, ou builder),
 * este é exclusivamente o montador visual: a config carrega um `builder`
 * (`BuilderConfig`) e o worker re-compila pra `{ sql, params }` em runtime —
 * fonte de verdade autoritativa, sem depender do SQL snapshot do editor.
 *
 * Config:
 *   - connectionRef: string   — nome lógico ("db_main") OU uuid (legado).
 *   - connectionId?: string   — alias legado de connectionRef.
 *   - builder: BuilderConfig  — op + tabela + colunas + filtros + set + order.
 *
 * Fluxo:
 *   1. `renderTemplate(node.config)` resolve `{{ input.x }}` dentro dos valores
 *      de filtros/SET (nunca nos identificadores).
 *   2. `compileBuilder` produz SQL parametrizado.
 *   3. Executa via `sql.unsafe(sql, params)` — valores sempre bindados.
 *
 * Segurança: idêntica ao nó postgres — a URL crua nunca aparece na config,
 * só a referência resolvida via `context.resolveConnection` (worker-only); a
 * connection é proibida de apontar pro DB do app (checado no CRUD + aqui).
 */
const TIMEOUT_SECONDS = 30;

export const dbQueryHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  const rawRef = (cfg.connectionRef ?? cfg.connectionId) as unknown;
  if (typeof rawRef !== "string" || !rawRef) {
    throw new Error(
      "db_query: config.connectionRef é obrigatório (nome lógico ou uuid de uma connection registrada)",
    );
  }
  if (!context.resolveConnection) {
    throw new Error("db_query: resolveConnection ausente do contexto — execute via worker");
  }

  const resolved = await context.resolveConnection(rawRef);
  if (!resolved) {
    throw new Error(`db_query: connection ${rawRef} não encontrada no workflow`);
  }
  if (resolved.kind !== "postgres") {
    throw new Error(`db_query: connection ${rawRef} é do tipo ${resolved.kind}, esperado postgres`);
  }
  const connectionString = resolved.connectionString;
  if (connectionString === context.env?.DATABASE_URL) {
    throw new Error("db_query: connection não pode apontar pro DB do app");
  }

  if (!isBuilderConfig(cfg.builder)) {
    throw new Error("db_query: config.builder é obrigatório (desenhe a query no editor)");
  }

  const { sql: query, params } = compileBuilder(cfg.builder);

  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: TIMEOUT_SECONDS,
    onnotice: () => {},
  });

  try {
    const rows = (await sql.unsafe(query, params as never[])) as Record<string, unknown>[];
    return { output: { rows: [...rows], rowCount: rows.length, query } };
  } finally {
    await sql.end({ timeout: 1 });
  }
};
