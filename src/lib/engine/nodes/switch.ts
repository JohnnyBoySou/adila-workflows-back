import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Switch n-ário. Avalia `value` e seleciona o `label` do primeiro case
 * que casar; cai no `default` (label "default" se omitido) caso contrário.
 *
 * Config:
 *   - value: any (templatable)
 *   - cases: Array<{ match: any, label: string }>
 *   - default?: string (default: "default")
 *
 * Comportamento: define `nextLabel = <label do case>`. As arestas saindo
 * deste nó devem ter labels correspondentes (e idealmente uma "default").
 */
interface SwitchCase {
  match: unknown;
  label: string;
}

function isCase(c: unknown): c is SwitchCase {
  return (
    !!c &&
    typeof c === "object" &&
    "label" in c &&
    typeof (c as Record<string, unknown>).label === "string"
  );
}

export const switchHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const value = cfg.value;
  const cases = Array.isArray(cfg.cases) ? cfg.cases.filter(isCase) : [];
  const defaultLabel = typeof cfg.default === "string" ? cfg.default : "default";

  for (const c of cases) {
    if (value === c.match) {
      return { output: { value, matched: c.label }, nextLabel: c.label };
    }
  }
  return { output: { value, matched: defaultLabel }, nextLabel: defaultLabel };
};
