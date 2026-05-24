import { renderTemplate, resolvePath } from "../template";
import type { ExecutionContext, NodeHandler } from "../types";

/**
 * Mapper sem código — reescreve a forma do dado via mapa declarativo.
 *
 * Substitui o caso "preciso só renomear/extrair campos antes do próximo nó"
 * que hoje obriga o usuário a abrir o nó `code`. As expressões aqui são as
 * mesmas `{{ path }}` que toda config aceita; o diferencial é a forma de
 * descrever a saída por *shape* em vez de imperativo.
 *
 * Config:
 *   mode: "object" | "array"   default "object"
 *
 *   mapping: Record<string, string | unknown>
 *     Para cada chave do output, o valor é um path dot-notation aplicado
 *     ao item de entrada (em `mode:"array"`) ou ao contexto inteiro
 *     (em `mode:"object"`). Qualquer outro tipo passa por renderTemplate.
 *
 *   source?: unknown   (apenas em mode:"array")
 *     Array a ser mapeado item a item. Cada item vira `it` no path.
 *     Aceita templates: `"{{ steps.fetch.items }}"`.
 *
 *   include_source?: boolean    (default false)
 *     Em mode:"object", inclui o input original em `_source`.
 *
 * Exemplos:
 *
 *   mode: object
 *   mapping: {
 *     "id":    "input.user.id",
 *     "name":  "input.user.name",
 *     "total": "steps.sum.value"
 *   }
 *
 *   mode: array
 *   source: "{{ steps.fetch.items }}"
 *   mapping: {
 *     "id":   "it.id",
 *     "name": "it.attributes.name"
 *   }
 */
export const transformHandler: NodeHandler = async ({ node, context }) => {
  const mode = String(node.config.mode ?? "object");
  const rawMapping = node.config.mapping;
  if (!rawMapping || typeof rawMapping !== "object") {
    throw new Error("transform: config.mapping é obrigatório");
  }
  const mapping = rawMapping as Record<string, unknown>;

  if (mode === "object") {
    const out = applyMapping(mapping, context, context as unknown as Record<string, unknown>);
    if (node.config.include_source) out._source = context.input;
    return { output: out };
  }

  if (mode === "array") {
    const rawSource = renderTemplate(node.config.source, context);
    const source = Array.isArray(rawSource) ? rawSource : [];
    const items = source.map((it) => {
      const scope = { ...(context as unknown as Record<string, unknown>), it };
      return applyMapping(mapping, context, scope);
    });
    return { output: { items, length: items.length } };
  }

  throw new Error(`transform: mode "${mode}" não suportado`);
};

/**
 * Aplica um mapping. Strings começando com prefixos conhecidos
 * (`input.`, `vars.`, `env.`, `steps.`, `it.`) são resolvidas via path no
 * `scope`; qualquer outra coisa é tratada como template `{{ }}` puro.
 *
 * - `scope` é o objeto sobre o qual o path string é resolvido (inclui `it`
 *   no modo array). `context` é usado pra `renderTemplate` em valores não-path.
 */
function applyMapping(
  mapping: Record<string, unknown>,
  context: ExecutionContext,
  scope: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, expr] of Object.entries(mapping)) {
    if (typeof expr === "string" && isPathExpression(expr)) {
      out[key] = resolvePath(scope, expr);
    } else {
      out[key] = renderTemplate(expr, context);
    }
  }
  return out;
}

const PATH_PREFIXES = ["input.", "vars.", "env.", "steps.", "it.", "it"];
function isPathExpression(s: string): boolean {
  if (s.includes("{{") || s.includes(" ")) return false;
  return PATH_PREFIXES.some((p) => s === p || s.startsWith(p));
}
