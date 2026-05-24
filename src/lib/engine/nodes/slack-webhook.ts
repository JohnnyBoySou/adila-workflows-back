import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Posta uma mensagem em um Slack Incoming Webhook.
 *
 * Config:
 *   webhookUrl: string   — URL do Slack webhook (obrigatório)
 *   text?:      string   — texto simples
 *   blocks?:    unknown  — Block Kit (objeto ou array)
 *   username?:  string
 *   iconEmoji?: string
 *   channel?:   string
 *
 * Output: { status, ok }
 */
export const slackWebhookHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const url = cfg.webhookUrl;
  if (typeof url !== "string" || !url) {
    throw new Error("slack_webhook: config.webhookUrl é obrigatório");
  }
  if (cfg.text == null && cfg.blocks == null) {
    throw new Error("slack_webhook: defina ao menos config.text ou config.blocks");
  }

  const payload: Record<string, unknown> = {};
  if (typeof cfg.text === "string") payload.text = cfg.text;
  if (cfg.blocks != null) payload.blocks = cfg.blocks;
  if (typeof cfg.username === "string") payload.username = cfg.username;
  if (typeof cfg.iconEmoji === "string") payload.icon_emoji = cfg.iconEmoji;
  if (typeof cfg.channel === "string") payload.channel = cfg.channel;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`slack_webhook: ${res.status} ${text}`);
  }
  return { output: { status: res.status, ok: true, response: text } };
};
