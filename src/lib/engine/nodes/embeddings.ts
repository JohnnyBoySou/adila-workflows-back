import { openai } from "@ai-sdk/openai";
import { embed, embedMany } from "ai";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Gera embeddings via OpenAI usando a Vercel AI SDK.
 *
 * Config:
 *   - model?: string  — default "text-embedding-3-small" (1536 dims)
 *   - text?: string   — modo single: gera 1 vetor
 *   - texts?: string[] — modo batch: gera N vetores
 *
 * Output:
 *   - single: { embedding: number[], dimensions, usage? }
 *   - batch:  { embeddings: number[][], dimensions, usage? }
 *
 * A chave da OpenAI vem de `OPENAI_API_KEY` do env do run (já decriptada).
 */
const DEFAULT_MODEL = "text-embedding-3-small";

export const embeddingsHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const modelName = typeof cfg.model === "string" && cfg.model ? cfg.model : DEFAULT_MODEL;

  // A SDK lê OPENAI_API_KEY do process.env; injetamos do env do run.
  const apiKey = context.env?.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("embeddings: env OPENAI_API_KEY não definido");
  }
  process.env.OPENAI_API_KEY = apiKey;

  const model = openai.embedding(modelName);

  if (Array.isArray(cfg.texts)) {
    const values = cfg.texts.map((t) => String(t));
    const { embeddings, usage } = await embedMany({ model, values });
    return {
      output: {
        embeddings,
        dimensions: embeddings[0]?.length ?? 0,
        count: embeddings.length,
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
      ...(usage && { usage }),
    },
  };
};
