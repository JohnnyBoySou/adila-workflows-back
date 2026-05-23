import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Nó de saída. Renderiza `config.output` (qualquer template) e usa esse
 * objeto como output final do run (ver executor → `finalOutput`).
 *
 * Sem config: devolve o último `steps` visitado.
 */
export const endHandler: NodeHandler = async ({ node, context }) => {
  const rendered = renderTemplate(node.config.output ?? {}, context);
  return {
    output:
      rendered && typeof rendered === "object" && !Array.isArray(rendered)
        ? (rendered as Record<string, unknown>)
        : { value: rendered },
  };
};
