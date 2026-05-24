import { PDFParse } from "pdf-parse";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Extrai texto e metadados de um PDF (in-memory).
 *
 * Config (uma das fontes obrigatória):
 *   url?:    string                       — baixa via fetch
 *   base64?: string                       — conteúdo do PDF em base64
 *
 * Output: { text, pages, info, metadata }
 */
export const pdfExtractHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  let buffer: Buffer;
  if (typeof cfg.base64 === "string" && cfg.base64) {
    buffer = Buffer.from(cfg.base64, "base64");
  } else if (typeof cfg.url === "string" && cfg.url) {
    const res = await fetch(cfg.url);
    if (!res.ok) throw new Error(`pdf_extract: download falhou ${res.status}`);
    buffer = Buffer.from(await res.arrayBuffer());
  } else {
    throw new Error("pdf_extract: defina config.url ou config.base64");
  }

  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const [textResult, infoResult] = await Promise.all([parser.getText(), parser.getInfo()]);
    return {
      output: {
        text: textResult.text,
        pages: textResult.total ?? textResult.pages?.length ?? null,
        info: infoResult.info ?? null,
        metadata: infoResult.metadata ?? null,
      },
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
};
