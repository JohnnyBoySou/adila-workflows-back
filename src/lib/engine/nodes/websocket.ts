import WebSocket from "ws";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Cliente WebSocket one-shot: conecta, envia mensagem, opcionalmente espera resposta(s), fecha.
 *
 * Modelo step-based (workflow não tem long-lived sockets); use o trigger
 * dedicado se precisar escutar continuamente.
 *
 * Config:
 *   url: string                          — obrigatório (ws:// ou wss://)
 *   message?: string | object            — payload (object vira JSON)
 *   headers?: Record<string,string>      — headers do handshake
 *   waitForResponse?: boolean            — default false
 *   responseCount?: number               — quantas mensagens coletar (default 1)
 *   timeoutMs?: number                   — default 10000
 *   protocols?: string | string[]
 *
 * Output: { sent, responses, closed }
 */
const DEFAULT_TIMEOUT = 10_000;

export const websocketHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const url = cfg.url;
  if (typeof url !== "string" || !url) {
    throw new Error("websocket: config.url é obrigatório");
  }
  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT;
  const wantResponse = cfg.waitForResponse === true;
  const responseCount =
    typeof cfg.responseCount === "number" && cfg.responseCount > 0
      ? Math.min(Math.floor(cfg.responseCount), 100)
      : 1;

  return await new Promise((resolve, reject) => {
    const responses: unknown[] = [];
    let sent = false;
    const ws = new WebSocket(url, cfg.protocols as string | string[] | undefined, {
      headers: (cfg.headers as Record<string, string> | undefined) ?? undefined,
    });

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`websocket: timeout após ${timeoutMs}ms`));
    }, timeoutMs);

    const finish = () => {
      clearTimeout(timer);
      ws.close();
      resolve({ output: { sent, responses, closed: true } });
    };

    ws.on("open", () => {
      if (cfg.message !== undefined) {
        const payload =
          typeof cfg.message === "string" ? cfg.message : JSON.stringify(cfg.message);
        ws.send(payload);
        sent = true;
      }
      if (!wantResponse) finish();
    });

    ws.on("message", (data) => {
      const text = data.toString("utf8");
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // mantém texto
      }
      responses.push(parsed);
      if (responses.length >= responseCount) finish();
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
};
