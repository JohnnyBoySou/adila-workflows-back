import { aiChatHandler } from "./ai-chat";
import { endHandler } from "./end";
import { httpRequestHandler } from "./http-request";
import { ifHandler } from "./if";
import { noopHandler } from "./noop";
import { postgresHandler } from "./postgres";
import { redisHandler } from "./redis";
import { setVariableHandler } from "./set-variable";
import { startHandler } from "./start";
import { switchHandler } from "./switch";
import { waitHandler } from "./wait";
import type { NodeHandler, NodeType } from "../types";

/** Tabela de despacho — type → handler. */
export const nodeHandlers: Record<NodeType, NodeHandler> = {
  start: startHandler,
  end: endHandler,
  set_variable: setVariableHandler,
  http_request: httpRequestHandler,
  ai_chat: aiChatHandler,
  if: ifHandler,
  noop: noopHandler,
  wait: waitHandler,
  switch: switchHandler,
  postgres: postgresHandler,
  redis: redisHandler,
};
