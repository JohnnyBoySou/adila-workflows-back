import { createOpenAI, openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Gera embeddings via Vercel AI SDK. Suporta dois "provedores":
 *
 *   provider: "openai"     — usa SDK OpenAI oficial. apiKey vem de OPENAI_API_KEY (env do run).
 *   provider: "custom"     — qualquer endpoint OpenAI-compatible (Ollama, LM Studio, vLLM,
 *                            Together, Groq, etc). Requer baseUrl. apiKey opcional
 *                            (templatable; muitos locais não exigem).
 *
 * Config comum:
 *   - provider?: "openai" | "custom"  — default "openai"
 *   - model?: string                   — default "text-embedding-3-small" (openai)
 *   - text?: string                    — modo single
 *   - texts?: string[]                 — modo batch
 *
 * Custom:
 *   - baseUrl: string                  — ex: "http://localhost:11434/v1" (Ollama)
 *   - apiKey?: string                  — opcional, templatable ({{env.X}})
 *
 * Output:
 *   - single: { embedding: number[], dimensions, model, usage? }
 *   - batch:  { embeddings: number[][], dimensions, count, model, usage? }
 */
const DEFAULT_MODEL = "text-embedding-3-small";

type EmbeddingProvider = "openai" | "custom";

function resolveProvider(cfg: Record<string, unknown>, env: Record<string, string> | undefined) {
  const provider: EmbeddingProvider = cfg.provider === "custom" ? "custom" : "openai";
  const modelName = typeof cfg.model === "string" && cfg.model ? cfg.model : DEFAULT_MODEL;

  if (provider === "openai") {
    const apiKey = env?.OPENAI_API_KEY;
    if (!apiKey) throw new Error("embeddings: env OPENAI_API_KEY não definido");
    // SDK oficial lê process.env. Injetamos o key do run.
    process.env.OPENAI_API_KEY = apiKey;
    return { model: openai.embedding(modelName), modelName };
  }

  // custom — OpenAI-compatible
  const baseURL = typeof cfg.baseUrl === "string" && cfg.baseUrl ? cfg.baseUrl : "";
  if (!baseURL) throw new Error("embeddings (custom): config.baseUrl é obrigatório");
  const apiKey = typeof cfg.apiKey === "string" && cfg.apiKey ? cfg.apiKey : "no-key";
  const client = createOpenAI({ baseURL, apiKey });
  return { model: client.embedding(modelName), modelName };
}

export const embeddingsHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const { model, modelName } = resolveProvider(cfg, context.env);

  if (Array.isArray(cfg.texts)) {
    const values = cfg.texts.map((t) => String(t));
    const { embeddings, usage } = await embedMany({ model, values });
    return {
      output: {
        embeddings,
        dimensions: embeddings[0]?.length ?? 0,
        count: embeddings.length,
        model: modelName,
        ...(usage && { usage }),
      },
    };
  }

  if (typeof cfg.text !== "string" || !cfg.text) {
    throw new Error("embeddings: informe `text` ou `texts`");
  }

  const { embedding, usage } = await embed({ model, value: cfg.text });
  return {
    output: {
      embedding,
      dimensions: embedding.length,
      model: modelName,
      ...(usage && { usage }),
    },
  };
};
