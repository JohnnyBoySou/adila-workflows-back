import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Fisher–Yates shuffle. Determinístico se `seed` (number) é dado.
 *
 * Config:
 *   - items: unknown[]
 *   - seed?: number
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const shuffleHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const items = Array.isArray(cfg.items) ? [...cfg.items] : [];
  const rng = typeof cfg.seed === "number" ? mulberry32(cfg.seed) : Math.random;
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return { output: { items, length: items.length } };
};
