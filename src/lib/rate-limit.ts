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
 *
 * Defesa contra chave sem TTL: se o processo morrer entre o INCR e o EXPIRE (ou o
 * Redis reiniciar), a chave ficaria sem expiração e bloquearia o usuário para sempre.
 * Por isso reaplicamos o TTL sempre que ele estiver ausente (`ttl < 0`), não só na
 * primeira hit — `expire` existe em todas as versões do Redis.
 */
export async function rateLimit({
  key,
  limit,
  windowSeconds,
}: RateLimitOptions): Promise<RateLimitResult> {
  const redisKey = `rl:${key}`;
  const count = await connection.incr(redisKey);
  const ttl = await connection.ttl(redisKey);
  // ttl === -1 → chave existe sem expiração (perdeu o TTL); -2 → inexistente.
  if (ttl < 0) {
    await connection.expire(redisKey, windowSeconds);
  }
  const resetIn = ttl >= 0 ? ttl : windowSeconds;
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn,
  };
}
