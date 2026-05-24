import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Envia mensagem via Bot API do Telegram (sendMessage).
 *
 * Config:
 *   botToken: string                                   — obrigatório
 *   chatId:   string | number                          — obrigatório
 *   text:     string                                   — obrigatório
 *   parseMode?: "Markdown" | "MarkdownV2" | "HTML"
 *   disableNotification?: boolean
 *   disableWebPagePreview?: boolean
 *
 * Output: { ok, messageId, result }
 */
export const telegramSendHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const token = cfg.botToken;
  const chatId = cfg.chatId;
  const text = cfg.text;
  if (typeof token !== "string" || !token) {
    throw new Error("telegram_send: config.botToken é obrigatório");
  }
  if (typeof chatId !== "string" && typeof chatId !== "number") {
    throw new Error("telegram_send: config.chatId é obrigatório");
  }
  if (typeof text !== "string" || !text) {
    throw new Error("telegram_send: config.text é obrigatório");
  }

  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (typeof cfg.parseMode === "string") payload.parse_mode = cfg.parseMode;
  if (typeof cfg.disableNotification === "boolean")
    payload.disable_notification = cfg.disableNotification;
  if (typeof cfg.disableWebPagePreview === "boolean")
    payload.disable_web_page_preview = cfg.disableWebPagePreview;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !body?.ok) {
    throw new Error(`telegram_send: ${res.status} ${JSON.stringify(body)}`);
  }
  const result = body.result as Record<string, unknown> | undefined;
  return {
    output: {
      ok: true,
      messageId: result?.message_id ?? null,
      result: result ?? null,
    },
  };
};
