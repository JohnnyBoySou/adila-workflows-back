import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { convertToModelMessages, stepCountIs, streamText, type UIMessage } from "ai";
import { Elysia } from "elysia";
import { requireOrganization } from "../../lib/auth-middleware";
import { logger } from "../../lib/logger";
import { rateLimit } from "../../lib/rate-limit";
import { buildSystemPrompt } from "./prompt";
import { copilotRepository } from "./repository";
import {
  conversationParams,
  createConversationBody,
  listConversationsQuery,
  putSettingsBody,
  renameConversationBody,
  resolveToolBody,
  sendMessageBody,
} from "./schema";
import { copilotTools } from "./tools";

/** Quantos passos de tool-loop o agente pode dar por turno. */
const MAX_STEPS = 5;
/** Janela de rate-limit do chat: N mensagens por minuto por usuário. */
const CHAT_RATE_LIMIT = 30;

/** Mascara a chave do provider para exposição segura na API (nunca em claro). */
function maskKey(plain: string | null): string | null {
  if (!plain) return null;
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 3)}••••${plain.slice(-4)}`;
}

function settingsView(
  provider: string,
  model: string,
  decryptedKey: string | null,
): { provider: string; model: string; hasKey: boolean; keyHint: string | null } {
  return {
    provider,
    model,
    hasKey: Boolean(decryptedKey),
    keyHint: maskKey(decryptedKey),
  };
}

export const copilotRouter = new Elysia({ prefix: "/copilot" })
  .use(requireOrganization)

  // ── Settings (BYOK) ──────────────────────────────────────────────────
  .get("/settings", async ({ organizationId }) => {
    const row = await copilotRepository.getSettings(organizationId);
    const key = await copilotRepository.getApiKey(organizationId);
    return settingsView(row?.provider ?? "openai", row?.model ?? "gpt-4.1", key);
  })

  .put(
    "/settings",
    async ({ organizationId, role, body, status }) => {
      if (role !== "owner" && role !== "admin") {
        return status(403, { error: "forbidden", message: "Apenas owner/admin podem configurar a chave." });
      }
      const row = await copilotRepository.upsertSettings(organizationId, {
        provider: body.provider,
        apiKey: body.apiKey,
        model: body.model,
      });
      const key = row.apiKeyEncrypted ? await copilotRepository.getApiKey(organizationId) : null;
      return settingsView(row.provider, row.model, key);
    },
    { body: putSettingsBody },
  )

  // ── Conversas ────────────────────────────────────────────────────────
  .get(
    "/conversations",
    async ({ organizationId, user, query }) => {
      const workflowId = query.workflowId ?? null;
      return copilotRepository.listConversations(organizationId, user.id, workflowId);
    },
    { query: listConversationsQuery },
  )

  .post(
    "/conversations",
    async ({ organizationId, user, body }) => {
      return copilotRepository.createConversation({
        organizationId,
        userId: user.id,
        workflowId: body.workflowId ?? null,
        title: body.title ?? "Nova conversa",
      });
    },
    { body: createConversationBody },
  )

  .patch(
    "/conversations/:id",
    async ({ organizationId, user, params, body, status }) => {
      const convo = await copilotRepository.getConversation(organizationId, user.id, params.id);
      if (!convo) return status(404, { error: "not_found" });
      const updated = await copilotRepository.renameConversation(params.id, body.title);
      return updated ?? convo;
    },
    { params: conversationParams, body: renameConversationBody },
  )

  .delete(
    "/conversations/:id",
    async ({ organizationId, user, params, status }) => {
      const convo = await copilotRepository.getConversation(organizationId, user.id, params.id);
      if (!convo) return status(404, { error: "not_found" });
      await copilotRepository.deleteConversation(params.id);
      return { ok: true };
    },
    { params: conversationParams },
  )

  .get(
    "/conversations/:id/messages",
    async ({ organizationId, user, params, status }) => {
      const convo = await copilotRepository.getConversation(organizationId, user.id, params.id);
      if (!convo) return status(404, { error: "not_found" });
      const rows = await copilotRepository.listMessages(params.id);
      // Formato consumível pelo `useChat` (UIMessage: id, role, parts).
      return rows.map((m) => ({ id: m.id, role: m.role, parts: m.parts }));
    },
    { params: conversationParams },
  )

  // ── Chat com streaming (human-in-the-loop via propose_changes) ───────
  .post(
    "/conversations/:id/messages",
    async ({ organizationId, user, params, body, status, set }) => {
      const convo = await copilotRepository.getConversation(organizationId, user.id, params.id);
      if (!convo) return status(404, { error: "not_found" });

      const rl = await rateLimit({
        key: `copilot:${user.id}`,
        limit: CHAT_RATE_LIMIT,
        windowSeconds: 60,
      });
      if (!rl.allowed) {
        set.headers["Retry-After"] = String(rl.resetIn);
        return status(429, { error: "rate_limited", message: "Muitas mensagens. Tente em instantes." });
      }

      const settings = await copilotRepository.getSettings(organizationId);
      const apiKey = await copilotRepository.getApiKey(organizationId);
      if (!apiKey) {
        return status(400, {
          error: "no_api_key",
          message: "Configure a chave do GPT nas configurações do Noud antes de conversar.",
        });
      }

      const providerName = settings?.provider ?? "openai";
      const modelId = settings?.model ?? "gpt-4.1";
      const provider =
        providerName === "anthropic" ? createAnthropic({ apiKey }) : createOpenAI({ apiKey });

      // Histórico do DB + nova mensagem do usuário (padrão de persistência do AI SDK).
      const prior = await copilotRepository.listMessages(params.id);
      const incoming = body.message as unknown as UIMessage;
      const uiMessages = [
        ...prior.map((m) => ({ id: m.id, role: m.role, parts: m.parts })),
        incoming,
      ] as UIMessage[];

      // Persiste a mensagem do usuário imediatamente.
      await copilotRepository.addMessage({
        conversationId: params.id,
        role: incoming.role,
        parts: incoming.parts,
      });

      const modelMessages = await convertToModelMessages(uiMessages);
      const result = streamText({
        model: provider(modelId),
        system: buildSystemPrompt(body.graphSummary),
        messages: modelMessages,
        tools: copilotTools,
        stopWhen: stepCountIs(MAX_STEPS),
      });

      return result.toUIMessageStreamResponse({
        onError: (error) => {
          // Detalhe completo só no servidor — a mensagem do provider pode conter
          // dados sensíveis (prefixo de chave, identificadores de conta, corpo HTTP).
          logger.error({ err: error, conversationId: params.id }, "copilot provider error");
          const raw = error instanceof Error ? error.message : "";
          if (/invalid.*key|unauthorized|authentication|api key/i.test(raw)) {
            return "Chave de API inválida ou sem permissão. Verifique as configurações do Noud.";
          }
          if (/rate.?limit|quota|429/i.test(raw)) {
            return "O provedor de IA limitou as requisições. Tente novamente em instantes.";
          }
          return "Falha ao chamar o modelo de IA. Tente novamente.";
        },
        onFinish: async ({ responseMessage }) => {
          await copilotRepository.addMessage({
            conversationId: params.id,
            role: responseMessage.role,
            parts: responseMessage.parts,
          });
          await copilotRepository.touchConversation(params.id);
        },
      });
    },
    { params: conversationParams, body: sendMessageBody },
  )

  // ── Resolução da proposta (human-in-the-loop, sem chamar o modelo) ───
  // Persiste o estado "aplicado/descartado" da tool-call para que, ao recarregar,
  // a proposta não reapareça pendente (evita reaplicar e duplicar nós no canvas).
  .post(
    "/conversations/:id/tool-result",
    async ({ organizationId, user, params, body, status }) => {
      const convo = await copilotRepository.getConversation(organizationId, user.id, params.id);
      if (!convo) return status(404, { error: "not_found" });

      const ok = await copilotRepository.resolveToolPart(params.id, body.toolCallId, body.output);
      if (!ok) return status(404, { error: "tool_call_not_found" });

      await copilotRepository.touchConversation(params.id);
      return { ok: true };
    },
    { params: conversationParams, body: resolveToolBody },
  );
