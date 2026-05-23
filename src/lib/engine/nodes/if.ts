import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Condicional. Avalia uma expressão e ramifica via labels de aresta.
 *
 * Config (suportado):
 *   - left: any  (templatable)
 *   - op: "eq"|"neq"|"truthy"|"falsy"|"gt"|"gte"|"lt"|"lte"|"contains"
 *   - right?: any (templatable, ignorado em truthy/falsy)
 *
 * Comportamento: define `nextLabel = "true" | "false"`, então a definition
 * deve ter duas arestas saindo deste nó com esses labels.
 */
function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "truthy":
      return Boolean(left);
    case "falsy":
      return !left;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "contains":
      if (Array.isArray(left)) return left.includes(right);
      if (typeof left === "string") return left.includes(String(right));
      return false;
    default:
      throw new Error(`if: operador "${op}" não suportado`);
  }
}

export const ifHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = typeof cfg.op === "string" ? cfg.op : "truthy";
  const result = compare(op, cfg.left, cfg.right);
  return {
    output: { left: cfg.left, op, right: cfg.right, result },
    nextLabel: result ? "true" : "false",
  };
};
