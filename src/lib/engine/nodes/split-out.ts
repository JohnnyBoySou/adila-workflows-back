import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Explode um array em itens individuais. Quando `field` é dado, lê o array
 * de dentro de cada item e expande cada elemento como item próprio (achatando).
 *
 * Config:
 *   - items: unknown[]
 *   - field?: dot-path para um array dentro de cada item; sem ele apenas
 *     repassa items como flat array
 */
export const splitOutHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const items = Array.isArray(cfg.items) ? cfg.items : [];
  const field = typeof cfg.field === "string" ? cfg.field : undefined;

  if (!field) {
    return { output: { items, length: items.length } };
  }

  const out: unknown[] = [];
  for (const it of items) {
    const inner = resolvePath(it, field);
    if (Array.isArray(inner)) {
      for (const child of inner) out.push(child);
    } else if (inner !== undefined) {
      out.push(inner);
    }
  }
  return { output: { items: out, length: out.length } };
};
