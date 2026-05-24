import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Deduplica itens. Key opcional por dot-path; sem ela compara o item inteiro
 * por JSON.stringify.
 *
 * Config:
 *   - items: unknown[]
 *   - field?: string
 */
export const removeDuplicatesHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const items = Array.isArray(cfg.items) ? cfg.items : [];
  const field = typeof cfg.field === "string" ? cfg.field : undefined;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const it of items) {
    const key = JSON.stringify(field ? resolvePath(it, field) : it) ?? "null";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return { output: { items: out, length: out.length, removed: items.length - out.length } };
};
