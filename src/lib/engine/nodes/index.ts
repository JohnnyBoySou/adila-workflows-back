import { aggregateHandler } from "./aggregate";
import { aiChatHandler } from "./ai-chat";
import { chatMemoryHandler } from "./chat-memory";
import { codeHandler } from "./code";
import { containerHandler } from "./container";
import { cryptoHandler } from "./crypto-node";
import { dateTimeHandler } from "./date-time";
import { documentLoaderHandler } from "./document-loader";
import { embeddingsHandler } from "./embeddings";
import { endHandler } from "./end";
import { executeWorkflowHandler } from "./execute-workflow";
import { httpRequestHandler } from "./http-request";
import { ifHandler } from "./if";
import { itemListsHandler } from "./item-lists";
import { noopHandler } from "./noop";
import { postgresHandler } from "./postgres";
import { redisHandler } from "./redis";
import { respondToWebhookHandler } from "./respond-to-webhook";
import { setVariableHandler } from "./set-variable";
import { splitInBatchesHandler } from "./split-in-batches";
import { startHandler } from "./start";
import { stickyNoteHandler } from "./sticky-note";
import { switchHandler } from "./switch";
import { vectorStoreHandler } from "./vector-store";
import { waitHandler } from "./wait";
import { webhookTriggerHandler } from "./webhook-trigger";
import type { NodeHandler, NodeType } from "../types";

/** Tabela de despacho — type → handler. */
export const nodeHandlers: Record<NodeType, NodeHandler> = {
  start: startHandler,
  webhook_trigger: webhookTriggerHandler,
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
  code: codeHandler,
  split_in_batches: splitInBatchesHandler,
  embeddings: embeddingsHandler,
  vector_store: vectorStoreHandler,
  chat_memory: chatMemoryHandler,
  document_loader: documentLoaderHandler,
  sticky_note: stickyNoteHandler,
  container: containerHandler,
  respond_to_webhook: respondToWebhookHandler,
  date_time: dateTimeHandler,
  crypto: cryptoHandler,
  item_lists: itemListsHandler,
  aggregate: aggregateHandler,
  execute_workflow: executeWorkflowHandler,
};
