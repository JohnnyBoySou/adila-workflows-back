import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Filtra um array mantendo apenas itens que casam com a regra.
 *
 * Config:
 *   - items: unknown[]
 *   - field?: dot-path dentro de cada item (default: o próprio item)
 *   - op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"truthy"|"falsy"
 *   - value?: comparado contra fieldValue (não usado em truthy/falsy)
 */
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

export const filterHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const items = Array.isArray(cfg.items) ? cfg.items : [];
  const cmp = COMPARATORS[String(cfg.op ?? "truthy")];
  if (!cmp) throw new Error(`filter: op "${String(cfg.op)}" inválido`);
  const field = typeof cfg.field === "string" ? cfg.field : undefined;
  const value = cfg.value;
  const out = items.filter((it) => cmp(field ? resolvePath(it, field) : it, value));
  return { output: { items: out, length: out.length } };
};
