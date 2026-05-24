import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Aborta o run com mensagem custom — gate de validação.
 *
 * O executor trata erro de qualquer handler como falha do run; este nó
 * existe pra dar uma mensagem clara e curada (vs. erro genérico de outro
 * passo). Use depois de um `if` quando uma condição inválida deve
 * encerrar a execução.
 *
 * Config:
 *   - message: string                (obrigatório, templatável)
 *   - details?: Record<string, unknown>
 *       Anexado ao erro (vira parte do `error.cause` no step gravado,
 *       acessível via UI de runs).
 */
export const stopAndErrorHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const message = cfg.message;
  if (typeof message !== "string" || !message) {
    throw new Error("stop_and_error: config.message é obrigatório");
  }
  const err = new Error(message);
  if (cfg.details && typeof cfg.details === "object") {
    (err as Error & { details?: unknown }).details = cfg.details;
  }
  throw err;
};
