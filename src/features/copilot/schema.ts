import { t } from "elysia";

export const conversationParams = t.Object({ id: t.String({ format: "uuid" }) });

export const listConversationsQuery = t.Object({
  // Ausente = threads gerais (workflowId null). Setado = threads do workflow.
  workflowId: t.Optional(t.String({ format: "uuid" })),
});

export const putSettingsBody = t.Object({
  provider: t.Optional(t.Union([t.Literal("openai"), t.Literal("anthropic")])),
  // string = define a chave; null/"" = limpa; ausente = mantém.
  apiKey: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])),
  model: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
});

export const createConversationBody = t.Object({
  workflowId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
  title: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
});

export const renameConversationBody = t.Object({
  title: t.String({ minLength: 1, maxLength: 200 }),
});

// Resumo do grafo atual, montado no front a partir do canvas.
// Limites de tamanho evitam inflar o system prompt (custo/abuso — "denial-of-wallet").
const graphSummary = t.Object({
  nodes: t.Array(
    t.Object({
      id: t.String({ maxLength: 100 }),
      type: t.String({ maxLength: 100 }),
      title: t.Optional(t.String({ maxLength: 200 })),
    }),
    { maxItems: 300 },
  ),
  edges: t.Array(
    t.Object({
      from: t.String({ maxLength: 100 }),
      to: t.String({ maxLength: 100 }),
      label: t.Optional(t.String({ maxLength: 100 })),
    }),
    { maxItems: 600 },
  ),
});

// UIMessage do AI SDK chega com `parts` heterogêneos — validação permissiva.
// `role` é restrito a user/assistant: o cliente NUNCA envia "system" (o system
// prompt é construído no backend) — sem isso, abriria injeção via mensagem persistida.
const uiMessage = t.Object(
  {
    id: t.Optional(t.String()),
    role: t.Union([t.Literal("user"), t.Literal("assistant")]),
    parts: t.Array(t.Any(), { maxItems: 200 }),
  },
  { additionalProperties: true },
);

export const sendMessageBody = t.Object({
  message: uiMessage,
  graphSummary: t.Optional(graphSummary),
});

// Resolução de uma tool-call human-in-the-loop (propose_changes), sem chamar o modelo.
export const resolveToolBody = t.Object({
  toolCallId: t.String({ minLength: 1, maxLength: 200 }),
  output: t.Object({
    status: t.Union([t.Literal("applied"), t.Literal("discarded")]),
    appliedCount: t.Optional(t.Number()),
  }),
});

export type PutSettingsBody = typeof putSettingsBody.static;
export type CreateConversationBody = typeof createConversationBody.static;
export type SendMessageBody = typeof sendMessageBody.static;
export type ResolveToolBody = typeof resolveToolBody.static;
