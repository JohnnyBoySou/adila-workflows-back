import { Redis } from "ioredis";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Operações Redis com whitelist de comandos seguros.
 *
 * Config:
 *   - connectionString: string (templatable; ex: `{{ env.MY_REDIS_URL }}`)
 *   - operation: "get"|"set"|"del"|"incr"|"decr"|"expire"|"ttl"|"exists"|"hget"|"hset"|"hdel"
 *   - args: unknown[]   — argumentos posicionais do comando (chave, valor, etc)
 *
 * Output:
 *   { operation, result }
 *
 * Comandos perigosos (EVAL, CONFIG, FLUSHDB, SCRIPT, DEBUG…) são rejeitados.
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

  const connectionString = cfg.connectionString;
  if (typeof connectionString !== "string" || !connectionString) {
    throw new Error("redis: config.connectionString é obrigatório");
  }

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
