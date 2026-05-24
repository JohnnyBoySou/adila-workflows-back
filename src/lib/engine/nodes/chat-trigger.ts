import type { NodeHandler } from "../types";

/**
 * Disparo por mensagem em janela de chat embutida.
 *
 * Rota HTTP/SSE expõe o chat público em `/chats/:token`; cada mensagem
 * enfileira um run com input `{ message, sessionId, userId?, history[] }`.
 *
 * Config:
 *   - greeting?: string
 *   - allowFileUpload?: boolean
 *   - persistHistory?: boolean
 */
export const chatTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { message: context.input },
});
