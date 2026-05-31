import postgres from "postgres";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Memória de chat persistida em Postgres — equivalente ao `memoryPostgresChat` do n8n.
 *
 * Aponta pra um Postgres *externo* (não o DB do app). Tabela responsável pelo
 * usuário; esperamos colunas (session_id text, role text, content text, created_at timestamptz).
 *
 * Config:
 *   - connectionRef: string            — UUID (legado) OU nome lógico ("db_main").
 *                                        Resolvido via context.resolveConnection
 *                                        (worker/dry-run); a URL crua nunca aparece aqui.
 *   - connectionId: string             — alias legado de connectionRef (compat).
 *   - table?: string  — default "chat_messages"
 *   - sessionId: string
 *   - operation: "load" | "append"
 *
 *   modo load:
 *     - limit?: number  — default 20 (últimas N mensagens)
 *
 *   modo append:
 *     - role: "user" | "assistant" | "system"
 *     - content: string
 *
 * Output:
 *   - load:   { messages: Array<{ role, content, createdAt }> }
 *   - append: { appended: true }
 */
const TIMEOUT_SECONDS = 15;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALLOWED_ROLES = new Set(["user", "assistant", "system"]);

export const chatMemoryHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  // `connectionRef` é o canônico (nome lógico ou uuid); `connectionId` é o
  // alias legado preservado por compat. A URL crua nunca aparece na config —
  // só a referência, resolvida via `context.resolveConnection`.
  const rawRef = (cfg.connectionRef ?? cfg.connectionId) as unknown;
  if (typeof rawRef !== "string" || !rawRef) {
    throw new Error(
      "chat_memory: config.connectionRef é obrigatório (nome lógico ou uuid de uma connection registrada)",
    );
  }
  if (!context.resolveConnection) {
    throw new Error("chat_memory: resolveConnection ausente do contexto — execute via worker");
  }
  const resolved = await context.resolveConnection(rawRef);
  if (!resolved) {
    throw new Error(`chat_memory: connection ${rawRef} não encontrada no workflow`);
  }
  if (resolved.kind !== "postgres") {
    throw new Error(
      `chat_memory: connection ${rawRef} é do tipo ${resolved.kind}, esperado postgres`,
    );
  }
  const connectionString = resolved.connectionString;
  if (connectionString === context.env?.DATABASE_URL) {
    throw new Error("chat_memory: connection não pode apontar pro DB do app");
  }

  const table = typeof cfg.table === "string" && cfg.table ? cfg.table : "chat_messages";
  if (!TABLE_RE.test(table)) {
    throw new Error("chat_memory: nome de tabela inválido");
  }

  const sessionId = cfg.sessionId;
  if (typeof sessionId !== "string" || !sessionId) {
    throw new Error("chat_memory: config.sessionId é obrigatório");
  }

  const operation = cfg.operation;
  if (operation !== "load" && operation !== "append") {
    throw new Error("chat_memory: operation precisa ser 'load' ou 'append'");
  }

  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: TIMEOUT_SECONDS,
    onnotice: () => {},
  });

  try {
    if (operation === "load") {
      const limitRaw = cfg.limit;
      const limit = Math.min(
        typeof limitRaw === "number" && limitRaw > 0 ? Math.floor(limitRaw) : 20,
        500,
      );
      const rows = await sql.unsafe(
        `SELECT role, content, created_at
         FROM "${table}"
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT ${limit}`,
        [sessionId] as never[],
      );
      // Devolve em ordem cronológica (mais antiga primeiro) — formato útil pra LLMs.
      // Devolve em ordem cronológica (mais antiga primeiro) — formato útil pra LLMs.
      // Spread-then-reverse pra não mutar o array que postgres-js devolve.
      const messages = [...(rows as Array<Record<string, unknown>>)].reverse().map((r) => ({
        role: r.role,
        content: r.content,
        createdAt: r.created_at,
      }));
      return { output: { messages } };
    }

    // append
    const role = String(cfg.role);
    if (!ALLOWED_ROLES.has(role)) {
      throw new Error(`chat_memory append: role inválido (${role})`);
    }
    const content = cfg.content;
    if (typeof content !== "string") {
      throw new Error("chat_memory append: `content` precisa ser string");
    }
    await sql.unsafe(`INSERT INTO "${table}" (session_id, role, content) VALUES ($1, $2, $3)`, [
      sessionId,
      role,
      content,
    ] as never[]);
    return { output: { appended: true } };
  } finally {
    await sql.end({ timeout: 1 });
  }
};
