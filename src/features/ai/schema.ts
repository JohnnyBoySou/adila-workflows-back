import { t } from "elysia";

/**
 * Body do `POST /ai/preview-chat`. Espelha 1:1 a config aceita pelo node
 * `ai_chat` (engine/nodes/ai-chat.ts) — usado pelo painel custom do
 * frontend pra rodar um teste rápido sem precisar disparar um workflow
 * inteiro. Não suporta templating server-side: o front já resolve `{{ … }}`
 * com pinned-data antes de chamar.
 */
export const previewChatBody = t.Object({
  provider: t.Optional(
    t.Union([t.Literal("anthropic"), t.Literal("openai")], { default: "anthropic" }),
  ),
  model: t.String({ minLength: 1, maxLength: 200 }),
  prompt: t.String({ minLength: 1, maxLength: 50_000 }),
  system: t.Optional(t.String({ maxLength: 20_000 })),
  temperature: t.Optional(t.Number({ minimum: 0, maximum: 2 })),
  maxOutputTokens: t.Optional(t.Number({ minimum: 1, maximum: 16_000 })),
});

export type PreviewChatBody = typeof previewChatBody.static;
