import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Define variável(eis) no `context.vars` (mutável durante o run).
 *
 * Dois modos suportados:
 *
 *   single: { name: string, value: any (templatable) }
 *   multi:  { variables: { foo: any, bar: any, ... } }   ← todos templatáveis
 *
 * O `multi` é o formato usado pelo importer de n8n (que traz N assignments).
 */
export const setVariableHandler: NodeHandler = async ({ node, context }) => {
  if (node.config.variables && typeof node.config.variables === "object") {
    const rendered = renderTemplate(node.config.variables, context) as Record<string, unknown>;
    return { vars: rendered, output: rendered };
  }

  const name = node.config.name;
  if (typeof name !== "string" || !name) {
    throw new Error("set_variable: informe `name` ou `variables`");
  }
  const value = renderTemplate(node.config.value, context);
  return { vars: { [name]: value }, output: { name, value } };
};
