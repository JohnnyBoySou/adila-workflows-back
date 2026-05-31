import postgres from "postgres";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Vector store backed by pgvector (extensão Postgres).
 *
 * Aponta pra um Postgres *externo* (não o DB do app), igual ao handler `postgres`.
 * Espera-se que a tabela exista com colunas (content text, embedding vector(N),
 * metadata jsonb). Esquema responsável pelo usuário — flexibilidade > convenção.
 *
 * Config:
 *   - connectionRef: string            — UUID (legado) OU nome lógico ("db_main").
 *                                        Resolvido via context.resolveConnection
 *                                        (worker/dry-run); a URL crua nunca aparece aqui.
 *   - connectionId: string             — alias legado de connectionRef (compat).
 *   - table?: string  — default "documents"
 *   - operation: "insert" | "search"
 *
 *   modo insert:
 *     - content: string
 *     - embedding: number[]
 *     - metadata?: Record<string, unknown>
 *
 *   modo search:
 *     - embedding: number[]
 *     - topK?: number  — default 5
 *     - filter?: Record<string, unknown>  — match exato em metadata
 *
 * Output:
 *   - insert: { id, inserted: true }
 *   - search: { matches: Array<{ id, content, metadata, distance }> }
 */
const TIMEOUT_SECONDS = 30;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const vectorStoreHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  // `connectionRef` é o canônico (nome lógico ou uuid); `connectionId` é o
  // alias legado preservado por compat. A URL crua nunca aparece na config —
  // só a referência, resolvida via `context.resolveConnection`. pgvector é
  // Postgres, então a connection pode ser do tipo "pgvector" (novo, canônico
  // pra vector store) ou "postgres" (compat com nós antigos).
  const rawRef = (cfg.connectionRef ?? cfg.connectionId) as unknown;
  if (typeof rawRef !== "string" || !rawRef) {
    throw new Error(
      "vector_store: config.connectionRef é obrigatório (nome lógico ou uuid de uma connection registrada)",
    );
  }
  if (!context.resolveConnection) {
    throw new Error("vector_store: resolveConnection ausente do contexto — execute via worker");
  }
  const resolved = await context.resolveConnection(rawRef);
  if (!resolved) {
    throw new Error(`vector_store: connection ${rawRef} não encontrada no workflow`);
  }
  if (resolved.kind !== "postgres" && resolved.kind !== "pgvector") {
    throw new Error(
      `vector_store: connection ${rawRef} é do tipo ${resolved.kind}, esperado pgvector/postgres`,
    );
  }
  const connectionString = resolved.connectionString;
  if (connectionString === context.env?.DATABASE_URL) {
    throw new Error("vector_store: connection não pode apontar pro DB do app");
  }

  const table = typeof cfg.table === "string" && cfg.table ? cfg.table : "documents";
  if (!TABLE_RE.test(table)) {
    throw new Error("vector_store: nome de tabela inválido");
  }

  const operation = cfg.operation;
  if (operation !== "insert" && operation !== "search") {
    throw new Error("vector_store: operation precisa ser 'insert' ou 'search'");
  }

  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: TIMEOUT_SECONDS,
    onnotice: () => {},
  });

  try {
    if (operation === "insert") {
      const content = cfg.content;
      const embedding = cfg.embedding;
      if (typeof content !== "string") {
        throw new Error("vector_store insert: `content` precisa ser string");
      }
      if (!Array.isArray(embedding)) {
        throw new Error("vector_store insert: `embedding` precisa ser number[]");
      }
      const metadata = cfg.metadata && typeof cfg.metadata === "object" ? cfg.metadata : {};

      const vectorLiteral = `[${(embedding as number[]).join(",")}]`;
      const rows = await sql.unsafe(
        `INSERT INTO "${table}" (content, embedding, metadata)
         VALUES ($1, $2::vector, $3::jsonb)
         RETURNING id`,
        [content, vectorLiteral, JSON.stringify(metadata)] as never[],
      );
      const id = (rows as unknown as Array<{ id: unknown }>)[0]?.id;
      return { output: { id, inserted: true } };
    }

    // search
    const queryEmbedding = cfg.embedding;
    if (!Array.isArray(queryEmbedding)) {
      throw new Error("vector_store search: `embedding` precisa ser number[]");
    }
    const topKRaw = cfg.topK;
    const topK = Math.min(
      typeof topKRaw === "number" && topKRaw > 0 ? Math.floor(topKRaw) : 5,
      100,
    );
    const vectorLiteral = `[${(queryEmbedding as number[]).join(",")}]`;

    // Filter por metadata: keys validadas como identifier-safe (jsonb ->> 'key').
    let whereClause = "";
    const params: unknown[] = [vectorLiteral];
    if (cfg.filter && typeof cfg.filter === "object") {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(cfg.filter as Record<string, unknown>)) {
        if (!TABLE_RE.test(k)) continue;
        params.push(String(v));
        parts.push(`metadata->>'${k}' = $${params.length}`);
      }
      if (parts.length > 0) whereClause = `WHERE ${parts.join(" AND ")}`;
    }

    const rows = await sql.unsafe(
      `SELECT id, content, metadata, embedding <-> $1::vector AS distance
       FROM "${table}"
       ${whereClause}
       ORDER BY embedding <-> $1::vector
       LIMIT ${topK}`,
      params as never[],
    );
    return { output: { matches: [...(rows as Record<string, unknown>[])] } };
  } finally {
    await sql.end({ timeout: 1 });
  }
};
