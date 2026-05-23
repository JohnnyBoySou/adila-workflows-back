import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Reduções e agrupamentos — equivalente ao `n8n-nodes-base.aggregate`.
 *
 * Config (discriminado por `operation`):
 *   - count    → items                         → { count }
 *   - sum      → items + field                 → { sum }
 *   - avg      → items + field                 → { avg, count, sum }
 *   - min      → items + field                 → { min }
 *   - max      → items + field                 → { max }
 *   - group_by → items + by (field) + aggs?    → { groups: [{ key, count, ...aggs }] }
 *
 * `aggs` é um objeto `{ alias: { op, field } }`. Suporta count/sum/avg/min/max por grupo.
 */
type Item = Record<string, unknown> | unknown;

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function getField(item: Item, field: string): unknown {
  return field === "" ? item : resolvePath(item, field);
}

interface AggSpec {
  op: "count" | "sum" | "avg" | "min" | "max";
  field?: string;
}

function applyAgg(items: Item[], spec: AggSpec): number {
  if (spec.op === "count") return items.length;
  if (!spec.field) return 0;
  const values = items.map((it) => num(getField(it, spec.field!)));
  if (spec.op === "sum") return values.reduce((a, b) => a + b, 0);
  if (spec.op === "avg")
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
  if (spec.op === "min") return values.length === 0 ? 0 : Math.min(...values);
  if (spec.op === "max") return values.length === 0 ? 0 : Math.max(...values);
  return 0;
}

export const aggregateHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;
  const items = Array.isArray(cfg.items) ? (cfg.items as Item[]) : [];

  if (op === "count") {
    return { output: { count: items.length } };
  }

  const field = typeof cfg.field === "string" ? cfg.field : "";

  if (op === "sum" || op === "avg" || op === "min" || op === "max") {
    if (!field) throw new Error(`aggregate ${op}: config.field é obrigatório`);
    const value = applyAgg(items, { op, field });
    if (op === "avg") {
      const sum = applyAgg(items, { op: "sum", field });
      return { output: { avg: value, count: items.length, sum } };
    }
    return { output: { [op]: value } };
  }

  if (op === "group_by") {
    const by = typeof cfg.by === "string" ? cfg.by : "";
    if (!by) throw new Error("aggregate group_by: config.by é obrigatório");
    const aggs =
      cfg.aggs && typeof cfg.aggs === "object" ? (cfg.aggs as Record<string, AggSpec>) : {};

    // Bucket por chave serializável (preserva null e tipos).
    const buckets = new Map<string, { key: unknown; items: Item[] }>();
    for (const it of items) {
      const keyValue = getField(it, by);
      const keyStr = JSON.stringify(keyValue ?? null);
      let bucket = buckets.get(keyStr);
      if (!bucket) {
        bucket = { key: keyValue, items: [] };
        buckets.set(keyStr, bucket);
      }
      bucket.items.push(it);
    }

    const groups = [...buckets.values()].map((b) => {
      const row: Record<string, unknown> = { key: b.key, count: b.items.length };
      for (const [alias, spec] of Object.entries(aggs)) {
        if (!spec || typeof spec !== "object" || !spec.op) continue;
        row[alias] = applyAgg(b.items, spec);
      }
      return row;
    });

    return { output: { groups, length: groups.length } };
  }

  throw new Error(`aggregate: operation "${String(op)}" não suportada`);
};
