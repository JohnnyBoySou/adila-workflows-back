import { aggregateHandler } from "./aggregate";
import { aiAgentHandler } from "./ai-agent";
import { aiChatHandler } from "./ai-chat";
import { chatMemoryHandler } from "./chat-memory";
import { chatTriggerHandler } from "./chat-trigger";
import { codeHandler } from "./code";
import { compareDatasetsHandler } from "./compare-datasets";
import { compressionHandler } from "./compression";
import { containerHandler } from "./container";
import { cryptoHandler } from "./crypto-node";
import { csvHandler } from "./csv";
import { dateTimeHandler } from "./date-time";
import { discordWebhookHandler } from "./discord-webhook";
import { documentLoaderHandler } from "./document-loader";
import { editFieldsHandler } from "./edit-fields";
import { emailSendHandler } from "./email-send";
import { emailTriggerHandler } from "./email-trigger";
import { embeddingsHandler } from "./embeddings";
import { endHandler } from "./end";
import { errorTriggerHandler } from "./error-trigger";
import { executeWorkflowHandler } from "./execute-workflow";
import { filterHandler } from "./filter";
import { formTriggerHandler } from "./form-trigger";
import { htmlExtractHandler } from "./html-extract";
import { httpRequestHandler } from "./http-request";
import { ifHandler } from "./if";
import { intervalTriggerHandler } from "./interval-trigger";
import { itemListsHandler } from "./item-lists";
import { jsonHandler } from "./json";
import { manualTriggerHandler } from "./manual-trigger";
import { jwtHandler } from "./jwt";
import { limitHandler } from "./limit";
import { markdownHandler } from "./markdown";
import { mathHandler } from "./math";
import { mergeHandler } from "./merge";
import { noopHandler } from "./noop";
import { pdfExtractHandler } from "./pdf-extract";
import { postgresHandler } from "./postgres";
import { postgresTriggerHandler } from "./postgres-trigger";
import { randomHandler } from "./random";
import { redisHandler } from "./redis";
import { redisTriggerHandler } from "./redis-trigger";
import { removeDuplicatesHandler } from "./remove-duplicates";
import { renameKeysHandler } from "./rename-keys";
import { respondToWebhookHandler } from "./respond-to-webhook";
import { rssTriggerHandler } from "./rss-trigger";
import { s3Handler } from "./s3";
import { scheduleTriggerHandler } from "./schedule-trigger";
import { setVariableHandler } from "./set-variable";
import { shuffleHandler } from "./shuffle";
import { slackWebhookHandler } from "./slack-webhook";
import { sortHandler } from "./sort";
import { splitInBatchesHandler } from "./split-in-batches";
import { splitOutHandler } from "./split-out";
import { startHandler } from "./start";
import { stickyNoteHandler } from "./sticky-note";
import { stopAndErrorHandler } from "./stop-and-error";
import { switchHandler } from "./switch";
import { telegramSendHandler } from "./telegram-send";
import { templateHandler } from "./template";
import { textManipulationHandler } from "./text-manipulation";
import { transformHandler } from "./transform";
import { urlToolsHandler } from "./url-tools";
import { uuidHandler } from "./uuid";
import { vectorStoreHandler } from "./vector-store";
import { waitHandler } from "./wait";
import { webhookTriggerHandler } from "./webhook-trigger";
import { websocketHandler } from "./websocket";
import { workflowCalledTriggerHandler } from "./workflow-called-trigger";
import { xmlHandler } from "./xml";
import { yamlHandler } from "./yaml";
import type { NodeHandler, NodeType } from "../types";

/** Tabela de despacho — type → handler. */
export const nodeHandlers: Record<NodeType, NodeHandler> = {
  start: startHandler,
  manual_trigger: manualTriggerHandler,
  webhook_trigger: webhookTriggerHandler,
  end: endHandler,
  set_variable: setVariableHandler,
  http_request: httpRequestHandler,
  ai_chat: aiChatHandler,
  ai_agent: aiAgentHandler,
  stop_and_error: stopAndErrorHandler,
  transform: transformHandler,
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
  filter: filterHandler,
  sort: sortHandler,
  limit: limitHandler,
  remove_duplicates: removeDuplicatesHandler,
  merge: mergeHandler,
  split_out: splitOutHandler,
  compare_datasets: compareDatasetsHandler,
  rename_keys: renameKeysHandler,
  edit_fields: editFieldsHandler,
  json: jsonHandler,
  xml: xmlHandler,
  csv: csvHandler,
  html_extract: htmlExtractHandler,
  markdown: markdownHandler,
  text_manipulation: textManipulationHandler,
  math: mathHandler,
  shuffle: shuffleHandler,
  // Triggers — handlers passthrough; o disparo real (scheduler, IMAP, etc.)
  // fica fora do engine. Eles apenas expõem `input` aos nós downstream.
  schedule_trigger: scheduleTriggerHandler,
  interval_trigger: intervalTriggerHandler,
  email_trigger: emailTriggerHandler,
  form_trigger: formTriggerHandler,
  chat_trigger: chatTriggerHandler,
  error_trigger: errorTriggerHandler,
  workflow_called_trigger: workflowCalledTriggerHandler,
  rss_trigger: rssTriggerHandler,
  postgres_trigger: postgresTriggerHandler,
  redis_trigger: redisTriggerHandler,
  // Quick-win actions
  email_send: emailSendHandler,
  slack_webhook: slackWebhookHandler,
  discord_webhook: discordWebhookHandler,
  telegram_send: telegramSendHandler,
  template: templateHandler,
  yaml: yamlHandler,
  jwt: jwtHandler,
  url_tools: urlToolsHandler,
  uuid: uuidHandler,
  random: randomHandler,
  compression: compressionHandler,
  s3: s3Handler,
  pdf_extract: pdfExtractHandler,
  websocket: websocketHandler,
};
