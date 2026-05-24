import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Posta uma mensagem em um Discord Webhook.
 *
 * Config:
 *   webhookUrl: string         — obrigatório
 *   content?:   string         — texto até 2000 chars
 *   embeds?:    unknown[]      — embeds Discord
 *   username?:  string
 *   avatarUrl?: string
 *   tts?:       boolean
 *
 * Output: { status, ok }
 */
export const discordWebhookHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const url = cfg.webhookUrl;
  if (typeof url !== "string" || !url) {
    throw new Error("discord_webhook: config.webhookUrl é obrigatório");
  }
  if (cfg.content == null && cfg.embeds == null) {
    throw new Error("discord_webhook: defina ao menos config.content ou config.embeds");
  }

  const payload: Record<string, unknown> = {};
  if (typeof cfg.content === "string") payload.content = cfg.content;
  if (Array.isArray(cfg.embeds)) payload.embeds = cfg.embeds;
  if (typeof cfg.username === "string") payload.username = cfg.username;
  if (typeof cfg.avatarUrl === "string") payload.avatar_url = cfg.avatarUrl;
  if (typeof cfg.tts === "boolean") payload.tts = cfg.tts;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`discord_webhook: ${res.status} ${text}`);
  }
  return { output: { status: res.status, ok: true } };
};
