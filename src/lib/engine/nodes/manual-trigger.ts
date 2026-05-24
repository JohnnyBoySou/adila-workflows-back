import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Trigger manual — "rodar agora" pelo botão Play do editor.
 *
 * Funcionalmente igual ao `start`, mas exposto como entry separado pra
 * combinar com triggers reais (schedule, webhook) num mesmo workflow:
 * o usuário aciona manualmente sem precisar mexer no cron / webhook.
 *
 * Config:
 *   - defaultInput?: Record<string, unknown>
 *       Payload usado quando o run é disparado sem body (clique no Play
 *       sem custom input). Templatável — pode referenciar `env`, etc.
 *
 * Output: { input } — ecoado pra downstream e gravado no step.
 */
export const manualTriggerHandler: NodeHandler = async ({ node, context }) => {
  const hasInput = context.input && Object.keys(context.input).length > 0;
  if (hasInput) return { output: { input: context.input } };

  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const defaults =
    cfg.defaultInput && typeof cfg.defaultInput === "object"
      ? (cfg.defaultInput as Record<string, unknown>)
      : {};
  // Pré-popula `context.input` pra downstream usar `{{ input.x }}` mesmo
  // quando o disparo veio sem body.
  Object.assign(context.input, defaults);
  return { output: { input: context.input } };
};
