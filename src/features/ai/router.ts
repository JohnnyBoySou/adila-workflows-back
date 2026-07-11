import { Elysia } from "elysia";
import { generateText } from "ai";
import { anthropic, openai } from "../../lib/ai";
import { requireOrganization } from "../../lib/auth-middleware";
import { rateLimit } from "../../lib/rate-limit";
import { logger } from "../../lib/logger";
import { previewChatBody } from "./schema";

/**
 * Endpoints utilitários de IA — usados pelo dialog de configuração dos nós
 * IA no editor de workflows pra "testar prompt" sem criar um run completo.
 *
 *   POST /ai/preview-chat   — chama `generateText` com a mesma config do nó
 *                             `ai_chat`. Retorna `{ text, finishReason, usage }`.
 *
 * Cuidados:
 *   - Auth obrigatória (organization). Sem fallback público.
 *   - Rate-limit agressivo por (user, modelo) — LLM custa $$$, é o pé na porta
 *     contra abuso e contra erros do front que poderiam disparar em loop.
 *   - Não persiste nada (não vai pro audit, não cria run). Edição preview ≠ execução.
 */
const PREVIEW_LIMIT_PER_MIN = 15;

export const aiRouter = new Elysia({ prefix: "/ai" })
  .use(requireOrganization)

  .post(
    "/preview-chat",
    async ({ body, user, status, set }) => {
      // Rate-limit por usuário — não inclui org porque o custo da chave é do user.
      const rl = await rateLimit({
        key: `ai-preview:${user.id}`,
        limit: PREVIEW_LIMIT_PER_MIN,
        windowSeconds: 60,
      });
      if (!rl.allowed) {
        set.headers["Retry-After"] = String(rl.resetIn);
        return status(429, {
          error: "rate_limited",
          message: `Limite de ${PREVIEW_LIMIT_PER_MIN} testes/min atingido. Tente em ${rl.resetIn}s.`,
        });
      }

      const provider = body.provider ?? "anthropic";
      const model = provider === "openai" ? openai(body.model) : anthropic(body.model);

      try {
        const started = Date.now();
        const result = await generateText({
          model,
          prompt: body.prompt,
          system: body.system,
          temperature: body.temperature,
          maxOutputTokens: body.maxOutputTokens,
        });
        const elapsedMs = Date.now() - started;

        logger.info(
          {
            userId: user.id,
            provider,
            model: body.model,
            elapsedMs,
            finishReason: result.finishReason,
            usage: result.usage,
          },
          "ai-preview ok",
        );

        return {
          text: result.text,
          finishReason: result.finishReason,
          usage: result.usage,
          elapsedMs,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { userId: user.id, provider, model: body.model, err: msg },
          "ai-preview failed",
        );
        // 400 (não 500) — quase sempre é credencial faltando, modelo inválido
        // ou quota do provider. O front exibe a mensagem direto.
        return status(400, { error: "ai_call_failed", message: msg });
      }
    },
    {
      body: previewChatBody,
      detail: {
        tags: ["ai"],
        summary: "Preview de chamada ao LLM (testa prompt sem criar run)",
      },
    },
  );
