import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Operações sobre arrays — equivalente ao `n8n-nodes-base.itemLists`.
 *
 * Config (discriminado por `operation`):
 *   - filter     → items + field + op (eq|neq|gt|gte|lt|lte|contains|truthy|falsy) + value?
 *   - sort       → items + field? + order ("asc"|"desc")
 *   - slice      → items + start? + end?
 *   - distinct   → items + field?
 *   - length     → items
 *   - reverse    → items
 *
 * `field` aceita dot-path (ex: `user.email`) pra navegar dentro de cada item.
 */
type Item = unknown;

function fieldValue(item: Item, field?: string): unknown {
  if (!field) return item;
  return resolvePath(item, field);
}

const COMPARATORS: Record<string, (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? "").includes(String(b ?? "")),
  truthy: (a) => Boolean(a),
  falsy: (a) => !a,
};

function compareForSort(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

export const itemListsHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;
  const items = Array.isArray(cfg.items) ? (cfg.items as Item[]) : [];

  if (op === "length") {
    return { output: { length: items.length } };
  }

  if (op === "reverse") {
    return { output: { items: [...items].reverse() } };
  }

  if (op === "filter") {
    const cmp = COMPARATORS[String(cfg.op ?? "eq")];
    if (!cmp) throw new Error(`item_lists filter: op "${String(cfg.op)}" inválido`);
    const field = typeof cfg.field === "string" ? cfg.field : undefined;
    const value = cfg.value;
    const out = items.filter((it) => cmp(fieldValue(it, field), value));
    return { output: { items: out, length: out.length } };
  }

  if (op === "sort") {
    const field = typeof cfg.field === "string" ? cfg.field : undefined;
    const desc = cfg.order === "desc";
    const out = [...items].sort((a, b) => {
      const cmp = compareForSort(fieldValue(a, field), fieldValue(b, field));
      return desc ? -cmp : cmp;
    });
    return { output: { items: out } };
  }

  if (op === "slice") {
    const start = typeof cfg.start === "number" ? cfg.start : 0;
    const end = typeof cfg.end === "number" ? cfg.end : undefined;
    const out = items.slice(start, end);
    return { output: { items: out, length: out.length } };
  }

  if (op === "distinct") {
    const field = typeof cfg.field === "string" ? cfg.field : undefined;
    const seen = new Set<string>();
    const out: Item[] = [];
    for (const it of items) {
      // Key serializável; preserva equivalência por valor escalar e por shape p/ objetos.
      const key = JSON.stringify(fieldValue(it, field) ?? null);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return { output: { items: out, length: out.length } };
  }

  throw new Error(`item_lists: operation "${String(op)}" não suportada`);
};
