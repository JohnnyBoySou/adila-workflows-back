import { Redis } from "ioredis";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Operações Redis com whitelist de comandos seguros.
 *
 * Config:
 *   - connectionId: string (uuid)   — id de uma database_connection registrada
 *   - operation: "get"|"set"|"del"|"incr"|"decr"|"expire"|"ttl"|"exists"
 *                |"hget"|"hset"|"hdel"|"lpush"|"rpush"|"lpop"|"rpop"|"llen"|"lrange"
 *   - args: unknown[]   — argumentos posicionais do comando (chave, valor, etc)
 *
 * Output:
 *   { operation, result }
 *
 * Comandos perigosos (EVAL, CONFIG, FLUSHDB, SCRIPT, DEBUG…) são rejeitados.
 * URL crua nunca vive na config — só o id da connection nomeada.
 */
const ALLOWED_OPERATIONS = new Set([
  "get",
  "set",
  "del",
  "incr",
  "decr",
  "expire",
  "ttl",
  "exists",
  "hget",
  "hset",
  "hdel",
  "lpush",
  "rpush",
  "lpop",
  "rpop",
  "llen",
  "lrange",
]);

export const redisHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  // `connectionRef` é o canônico (nome lógico ou uuid); `connectionId`
  // é o alias legado preservado por compat.
  const rawRef = (cfg.connectionRef ?? cfg.connectionId) as unknown;
  if (typeof rawRef !== "string" || !rawRef) {
    throw new Error(
      "redis: config.connectionRef é obrigatório (nome lógico ou uuid de uma connection registrada)",
    );
  }
  if (!context.resolveConnection) {
    throw new Error("redis: resolveConnection ausente do contexto — execute via worker");
  }
  const resolved = await context.resolveConnection(rawRef);
  if (!resolved) {
    throw new Error(`redis: connection ${rawRef} não encontrada no workflow`);
  }
  if (resolved.kind !== "redis") {
    throw new Error(`redis: connection ${rawRef} é do tipo ${resolved.kind}, esperado redis`);
  }
  const connectionString = resolved.connectionString;

  const operation = typeof cfg.operation === "string" ? cfg.operation.toLowerCase() : "";
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(`redis: operação "${operation}" não permitida`);
  }

  const args = Array.isArray(cfg.args) ? cfg.args.map((a) => (a == null ? "" : String(a))) : [];

  const client = new Redis(connectionString, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 10_000,
  });

  try {
    await client.connect();
    const command = client[operation as keyof Redis] as (...a: unknown[]) => Promise<unknown>;
    const result = await command.apply(client, args);
    return { output: { operation, result } };
  } finally {
    client.disconnect();
  }
};
