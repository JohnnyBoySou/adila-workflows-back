import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Marca o output deste step como a resposta a ser devolvida ao caller HTTP
 * que disparou o webhook (quando o trigger está em `responseMode: 'sync'`).
 *
 * O webhook router, após esperar o run finalizar, procura o último step de
 * tipo `respond_to_webhook` no run, lê este `output.__webhookResponse` e
 * devolve como HTTP response. Se nenhum existir, devolve o `run.output` cru.
 *
 * Em modo async (default do trigger) este handler é inofensivo — só preserva
 * a estrutura no log do step pra debug.
 *
 * Config:
 *   - status?: number  — default 200
 *   - headers?: Record<string, string>
 *   - body: unknown    — qualquer JSON; templatável
 */
const DEFAULT_STATUS = 200;

export const respondToWebhookHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  const status =
    typeof cfg.status === "number" && cfg.status >= 100 && cfg.status < 600
      ? Math.floor(cfg.status)
      : DEFAULT_STATUS;

  const headers: Record<string, string> = {};
  if (cfg.headers && typeof cfg.headers === "object") {
    for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
      headers[k] = String(v);
    }
  }

  // body é qualquer coisa; se não foi setado, fica null pra sinalizar "sem body".
  const body = "body" in cfg ? cfg.body : null;

  return {
    output: {
      __webhookResponse: { status, headers, body },
    },
  };
};
