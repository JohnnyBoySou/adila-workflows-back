import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Combina dois arrays.
 *
 * Config:
 *   - a: unknown[]
 *   - b: unknown[]
 *   - mode: "append" | "merge_by_key"
 *   - key?: dot-path (obrigatório para merge_by_key)
 *
 * merge_by_key: para cada item de `a`, procura match em `b` pela key e faz
 * shallow merge (b sobrescreve a). Itens de `b` sem match são acrescentados.
 */
export const mergeHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const a = Array.isArray(cfg.a) ? cfg.a : [];
  const b = Array.isArray(cfg.b) ? cfg.b : [];
  const mode = String(cfg.mode ?? "append");

  if (mode === "append") {
    const items = [...a, ...b];
    return { output: { items, length: items.length } };
  }

  if (mode === "merge_by_key") {
    const key = cfg.key;
    if (typeof key !== "string" || !key) {
      throw new Error("merge merge_by_key: `key` é obrigatório");
    }
    const byKey = new Map<string, Record<string, unknown>>();
    for (const item of b) {
      if (item && typeof item === "object") {
        const k = JSON.stringify(resolvePath(item, key) ?? null);
        byKey.set(k, item as Record<string, unknown>);
      }
    }
    const consumed = new Set<string>();
    const out: unknown[] = [];
    for (const item of a) {
      if (item && typeof item === "object") {
        const k = JSON.stringify(resolvePath(item, key) ?? null);
        const match = byKey.get(k);
        if (match) {
          consumed.add(k);
          out.push({ ...(item as Record<string, unknown>), ...match });
        } else {
          out.push(item);
        }
      } else {
        out.push(item);
      }
    }
    for (const [k, item] of byKey) {
      if (!consumed.has(k)) out.push(item);
    }
    return { output: { items: out, length: out.length } };
  }

  throw new Error(`merge: mode "${mode}" não suportado`);
};
