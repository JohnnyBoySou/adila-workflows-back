import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Ordena um array por campo.
 *
 * Config:
 *   - items: unknown[]
 *   - field?: dot-path; default ordena pelo próprio item
 *   - order?: "asc"|"desc" (default "asc")
 */
function compareForSort(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export const sortHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const items = Array.isArray(cfg.items) ? [...cfg.items] : [];
  const field = typeof cfg.field === "string" ? cfg.field : undefined;
  const desc = cfg.order === "desc";
  items.sort((a, b) => {
    const c = compareForSort(field ? resolvePath(a, field) : a, field ? resolvePath(b, field) : b);
    return desc ? -c : c;
  });
  return { output: { items, length: items.length } };
};
