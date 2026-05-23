import { connection } from "./redis";

type RateLimitOptions = {
  key: string;
  limit: number;
  windowSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetIn: number;
};

/**
 * Rate limit por janela fixa em Redis: INCR + EXPIRE na primeira hit da janela.
 * Simples, atômico o suficiente para o uso atual (abuso óbvio em endpoints públicos).
 */
export async function rateLimit({
  key,
  limit,
  windowSeconds,
}: RateLimitOptions): Promise<RateLimitResult> {
  const redisKey = `rl:${key}`;
  const count = await connection.incr(redisKey);
  if (count === 1) {
    await connection.expire(redisKey, windowSeconds);
  }
  const ttl = await connection.ttl(redisKey);
  const resetIn = ttl >= 0 ? ttl : windowSeconds;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn,
  };
}
