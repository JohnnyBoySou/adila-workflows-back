import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Mantém apenas os primeiros N itens (ou os últimos, com `from: "end"`).
 *
 * Config:
 *   - items: unknown[]
 *   - count: number
 *   - from?: "start" | "end" (default "start")
 */
export const limitHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const items = Array.isArray(cfg.items) ? cfg.items : [];
  const countRaw = Number(cfg.count);
  const count = Number.isFinite(countRaw) && countRaw >= 0 ? Math.floor(countRaw) : 0;
  const out = cfg.from === "end" ? items.slice(-count) : items.slice(0, count);
  return { output: { items: out, length: out.length } };
};
