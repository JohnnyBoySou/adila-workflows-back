import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Converte entre YAML e objeto.
 *
 * Config:
 *   operation: "parse" | "stringify"   — obrigatório
 *   value:     string | unknown        — entrada
 *
 * Output:
 *   parse:     { data }
 *   stringify: { yaml }
 */
export const yamlHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;
  if (op !== "parse" && op !== "stringify") {
    throw new Error("yaml: config.operation deve ser 'parse' ou 'stringify'");
  }
  if (op === "parse") {
    if (typeof cfg.value !== "string") {
      throw new Error("yaml.parse: config.value deve ser string");
    }
    return { output: { data: parseYaml(cfg.value) } };
  }
  return { output: { yaml: stringifyYaml(cfg.value) } };
};
