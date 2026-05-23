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
 *   - connectionString: string (templatable)
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

  const connectionString = cfg.connectionString;
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("chat_memory: config.connectionString é obrigatório");
  }
  if (connectionString === context.env?.DATABASE_URL) {
    throw new Error("chat_memory: connectionString não pode apontar pro DB do app");
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
