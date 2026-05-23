import { generateText } from "ai";
import { anthropic, openai } from "../../ai";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Chama um modelo LLM via Vercel AI SDK.
 *
 * Config:
 *   - provider: "anthropic" | "openai"  (default: "anthropic")
 *   - model: string                     (ex: "claude-sonnet-4-6")
 *   - prompt: string                    (templatable)
 *   - system?: string                   (templatable)
 *   - temperature?: number
 *   - maxOutputTokens?: number
 *
 * Output: { text, finishReason, usage }
 */
export const aiChatHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  const provider = typeof cfg.provider === "string" ? cfg.provider : "anthropic";
  const modelId = cfg.model;
  if (typeof modelId !== "string" || !modelId) {
    throw new Error("ai_chat: config.model é obrigatório");
  }
  const prompt = cfg.prompt;
  if (typeof prompt !== "string" || !prompt) {
    throw new Error("ai_chat: config.prompt é obrigatório");
  }

  const model = provider === "openai" ? openai(modelId) : anthropic(modelId);

  const result = await generateText({
    model,
    prompt,
    system: typeof cfg.system === "string" ? cfg.system : undefined,
    temperature: typeof cfg.temperature === "number" ? cfg.temperature : undefined,
    maxOutputTokens: typeof cfg.maxOutputTokens === "number" ? cfg.maxOutputTokens : undefined,
  });

  return {
    output: {
      text: result.text,
      finishReason: result.finishReason,
      usage: result.usage,
    },
  };
};
