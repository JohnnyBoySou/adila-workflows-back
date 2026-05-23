import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Chunkifica texto em pedaços com overlap — pré-processamento pra embeddings/RAG.
 *
 * Equivalente ao `documentDefaultDataLoader` do n8n (modo `text`). Para PDFs
 * ou outros formatos binários, o usuário deve pré-extrair o texto fora do
 * workflow (ou via um `code` node) — esse handler trabalha só em string.
 *
 * Config:
 *   - text: string (templatable)
 *   - chunkSize?: number  — default 1000 chars
 *   - chunkOverlap?: number  — default 200 chars (precisa ser < chunkSize)
 *   - metadata?: Record<string, unknown>  — anexado a cada chunk
 *
 * Output:
 *   - { chunks: Array<{ content, index, metadata }> }
 */
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_OVERLAP = 200;
const MAX_CHUNKS = 5000;

export const documentLoaderHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  const text = cfg.text;
  if (typeof text !== "string") {
    throw new Error("document_loader: config.text precisa ser string");
  }

  const chunkSize =
    typeof cfg.chunkSize === "number" && cfg.chunkSize > 0
      ? Math.floor(cfg.chunkSize)
      : DEFAULT_CHUNK_SIZE;
  const overlapRaw =
    typeof cfg.chunkOverlap === "number" && cfg.chunkOverlap >= 0
      ? Math.floor(cfg.chunkOverlap)
      : DEFAULT_OVERLAP;
  const overlap = Math.min(overlapRaw, chunkSize - 1);

  const metadata =
    cfg.metadata && typeof cfg.metadata === "object"
      ? (cfg.metadata as Record<string, unknown>)
      : {};

  if (text.length === 0) {
    return { output: { chunks: [] } };
  }

  const stride = chunkSize - overlap;
  const chunks: Array<{ content: string; index: number; metadata: Record<string, unknown> }> = [];
  for (let start = 0, i = 0; start < text.length; start += stride, i++) {
    if (i >= MAX_CHUNKS) {
      throw new Error(
        `document_loader: excede ${MAX_CHUNKS} chunks — aumente chunkSize ou divida o texto`,
      );
    }
    chunks.push({
      content: text.slice(start, start + chunkSize),
      index: i,
      metadata,
    });
  }

  return { output: { chunks } };
};
