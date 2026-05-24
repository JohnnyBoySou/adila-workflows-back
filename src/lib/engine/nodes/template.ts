import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Renderiza um template `{{ path }}` arbitrário e expõe o resultado.
 * Útil quando o nó downstream espera uma única string montada.
 *
 * Config:
 *   template: string   — texto com `{{ ... }}` (obrigatório)
 *   outputKey?: string — chave de saída (default "text")
 *
 * Output: { [outputKey]: string }
 */
export const templateHandler: NodeHandler = async ({ node, context }) => {
  const tpl = node.config.template;
  if (typeof tpl !== "string") {
    throw new Error("template: config.template é obrigatório");
  }
  const rendered = renderTemplate(tpl, context);
  const key =
    typeof node.config.outputKey === "string" && node.config.outputKey
      ? node.config.outputKey
      : "text";
  return { output: { [key]: typeof rendered === "string" ? rendered : String(rendered) } };
};
