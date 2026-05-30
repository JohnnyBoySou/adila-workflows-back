import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Filtra dado. Dois modos:
 *
 * **Modo n8n (single value)** — quando o config tem `left` ou só `op`:
 *   Avalia condition contra UM item (estilo n8n filter node).
 *   - Se passa: output = `prev` (preserva o item atual pro downstream)
 *   - Se falha: output = `prev` ainda, mas nextLabel="false" — permite
 *     ramificar via aresta labeled, ou continua se aresta única.
 *
 * **Modo array** — quando o config tem `items` (array):
 *   array.filter — comportamento legado.
 *
 * Config:
 *   left?: any (templatable)
 *   op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"contains"|"truthy"|"falsy"|"notEmpty"|"isEmpty"
 *   right?: any (templatable, ignorado em ops unárias)
 *   field?: dot-path (modo array — campo dentro de cada item)
 *   value?: alias de `right` (modo array)
 *   items?: unknown[] (modo array)
 */
const COMPARATORS: Record<string, (a: unknown, b: unknown) => boolean> = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => Number(a) > Number(b),
  gte: (a, b) => Number(a) >= Number(b),
  lt: (a, b) => Number(a) < Number(b),
  lte: (a, b) => Number(a) <= Number(b),
  contains: (a, b) => String(a ?? "").includes(String(b ?? "")),
  truthy: (a) => Boolean(a) && !isEmptyVal(a),
  falsy: (a) => !a || isEmptyVal(a),
  notEmpty: (a) => !isEmptyVal(a),
  isEmpty: (a) => isEmptyVal(a),
};

function isEmptyVal(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export const filterHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = String(cfg.op ?? "truthy");
  const cmp = COMPARATORS[op];
  if (!cmp) throw new Error(`filter: op "${op}" inválido`);

  // Modo array (legado): cfg.items é array — comporta como array.filter.
  if (Array.isArray(cfg.items)) {
    const field = typeof cfg.field === "string" ? cfg.field : undefined;
    const value = cfg.value;
    const out = cfg.items.filter((it) => cmp(field ? resolvePath(it, field) : it, value));
    return { output: { items: out, length: out.length } };
  }

  // Modo n8n single-item — avalia condition contra `cfg.left` (templatable).
  // Preserva o item atual (`context.prev`) no output pra downstream conseguir
  // continuar referenciando `{{ prev.X }}` ou `{{ input.X }}` sem precisar
  // de fallback. nextLabel ramifica se houver aresta "true"/"false".
  const left = cfg.left;
  const right = cfg.right ?? cfg.value;
  const passed = cmp(left, right);
  const item =
    context.prev && typeof context.prev === "object"
      ? (context.prev as Record<string, unknown>)
      : {};
  // Output explicita o veredicto + traz o item junto, pra UI exibir e o
  // downstream conseguir referenciar `prev.X` (preserva os campos do item).
  return {
    output: { _filter: { passed, op, left, right }, ...item },
    nextLabel: passed ? "true" : "false",
  };
};
