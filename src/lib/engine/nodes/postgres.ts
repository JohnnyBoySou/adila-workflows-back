import { drizzle } from "drizzle-orm/postgres-js";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql as sqlTag,
} from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import postgres from "postgres";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Executa uma query no Postgres.
 *
 * Modos:
 *   - "sql" (default): query parametrizada via $1, $2…
 *   - "orm": expõe `db` (Drizzle), `sql`, helpers e column builders no sandbox.
 *
 * Config (sql):
 *   - connectionRef: string            — UUID (legado) OU nome lógico ("db_main").
 *                                        Nome resolve com fallback de env no worker.
 *   - connectionId: string             — alias legado de connectionRef (compat).
 *   - query: string                    — SQL com placeholders $1, $2…
 *   - params?: unknown[]               — valores parametrizados
 *
 * Config (orm):
 *   - connectionRef: string            — idem acima
 *   - code: string                     — corpo da função; tem acesso a `db`, `sql`,
 *                                        `ctx`, helpers e column builders
 *   - timeoutMs?: number               — timeout (default 5000, máx 30000)
 *
 * Segurança:
 *   - URL crua nunca aparece na config — só a referência. Resolução é feita
 *     via `context.resolveConnection` (worker-only). Em dry-runs sem worker
 *     o handler falha cedo com mensagem clara.
 *   - A connection nomeada é proibida de apontar pro DB do app (checado já no
 *     CRUD), então a verificação aqui é defesa em profundidade.
 */
const TIMEOUT_SECONDS = 30;
const DEFAULT_ORM_TIMEOUT_MS = 5000;
const MAX_ORM_TIMEOUT_MS = 30_000;

export const postgresHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  // `connectionRef` é o canônico (nome lógico ou uuid); `connectionId` é o
  // alias legado preservado por compat de workflows criados antes do rename.
  const rawRef = (cfg.connectionRef ?? cfg.connectionId) as unknown;
  if (typeof rawRef !== "string" || !rawRef) {
    throw new Error(
      "postgres: config.connectionRef é obrigatório (nome lógico ou uuid de uma connection registrada)",
    );
  }
  if (!context.resolveConnection) {
    throw new Error("postgres: resolveConnection ausente do contexto — execute via worker");
  }

  const resolved = await context.resolveConnection(rawRef);
  if (!resolved) {
    throw new Error(`postgres: connection ${rawRef} não encontrada no workflow`);
  }
  if (resolved.kind !== "postgres") {
    throw new Error(`postgres: connection ${rawRef} é do tipo ${resolved.kind}, esperado postgres`);
  }
  const connectionString = resolved.connectionString;
  if (connectionString === context.env?.DATABASE_URL) {
    throw new Error("postgres: connection não pode apontar pro DB do app");
  }

  const mode = typeof cfg.mode === "string" ? cfg.mode : "sql";

  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: TIMEOUT_SECONDS,
    onnotice: () => {},
  });

  try {
    if (mode === "orm") {
      return await runOrmMode(sql, cfg, context);
    }
    return await runSqlMode(sql, cfg);
  } finally {
    await sql.end({ timeout: 1 });
  }
};

async function runSqlMode(sql: ReturnType<typeof postgres>, cfg: Record<string, unknown>) {
  const query = cfg.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("postgres: config.query é obrigatório");
  }
  const params = Array.isArray(cfg.params) ? cfg.params : [];

  const rows = (await sql.unsafe(query, params as never[])) as Record<string, unknown>[];
  return { output: { rows: [...rows], rowCount: rows.length } };
}

interface OrmContext {
  input: Record<string, unknown>;
  vars: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  env: Record<string, string>;
}

async function runOrmMode(
  pgClient: ReturnType<typeof postgres>,
  cfg: Record<string, unknown>,
  context: { input: unknown; vars: unknown; steps: unknown; env: Record<string, string> },
) {
  const code = cfg.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("postgres: config.code é obrigatório no modo ORM");
  }

  const timeoutRaw = cfg.timeoutMs;
  const timeoutMs = Math.min(
    typeof timeoutRaw === "number" && timeoutRaw > 0 ? timeoutRaw : DEFAULT_ORM_TIMEOUT_MS,
    MAX_ORM_TIMEOUT_MS,
  );

  const db = drizzle(pgClient);

  // Helpers expostos ao sandbox. Lista fechada — qualquer global não-nativo
  // que o usuário queira tem que entrar aqui explicitamente.
  const helpers = {
    db,
    sql: sqlTag,
    eq,
    and,
    or,
    not,
    ne,
    gt,
    gte,
    lt,
    lte,
    like,
    inArray,
    isNull,
    isNotNull,
    desc,
    asc,
    pgTable,
    text,
    integer,
    boolean,
    timestamp,
    uuid,
    jsonb,
    serial,
  };

  const ctx: OrmContext = {
    input: (context.input as Record<string, unknown>) ?? {},
    vars: (context.vars as Record<string, unknown>) ?? {},
    steps: (context.steps as Record<string, Record<string, unknown>>) ?? {},
    env: context.env ?? {},
  };

  const helperKeys = Object.keys(helpers);
  let fn: (
    ctx: OrmContext,
    ...helpers: unknown[]
  ) => Promise<unknown> | unknown;
  try {
    fn = new Function(
      "ctx",
      ...helperKeys,
      `"use strict"; return (async () => { ${code} })();`,
    ) as never;
  } catch (err) {
    throw new Error(`postgres: erro de sintaxe — ${(err as Error).message}`, { cause: err });
  }

  const exec = Promise.resolve().then(() =>
    fn(ctx, ...helperKeys.map((k) => helpers[k as keyof typeof helpers])),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`postgres: timeout após ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    const result = await Promise.race([exec, timeout]);
    if (result === null || result === undefined) return { output: {} };
    if (typeof result === "object" && !Array.isArray(result)) {
      return { output: result as Record<string, unknown> };
    }
    return { output: { result } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
