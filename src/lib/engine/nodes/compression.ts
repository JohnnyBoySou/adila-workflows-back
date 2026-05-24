import { gunzipSync, gzipSync, deflateSync, inflateSync } from "node:zlib";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Compressão/descompressão de dados (gzip/deflate).
 *
 * Config:
 *   operation: "compress" | "decompress"
 *   algorithm?: "gzip" | "deflate"        — default "gzip"
 *   value: string                          — entrada
 *   inputEncoding?:  "utf8" | "base64" | "hex"   — default depende da op
 *   outputEncoding?: "utf8" | "base64" | "hex"   — default depende da op
 *
 * Defaults razoáveis:
 *   compress:   input=utf8,  output=base64
 *   decompress: input=base64, output=utf8
 *
 * Output: { value, originalSize, finalSize }
 */
type Enc = "utf8" | "base64" | "hex";

export const compressionHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;
  const algorithm = cfg.algorithm === "deflate" ? "deflate" : "gzip";
  if (typeof cfg.value !== "string") {
    throw new Error("compression: config.value deve ser string");
  }

  const isCompress = op === "compress";
  const inputEnc = (cfg.inputEncoding as Enc | undefined) ?? (isCompress ? "utf8" : "base64");
  const outputEnc = (cfg.outputEncoding as Enc | undefined) ?? (isCompress ? "base64" : "utf8");

  const inputBuf = Buffer.from(cfg.value, inputEnc);
  let outputBuf: Buffer;

  if (op === "compress") {
    outputBuf = algorithm === "gzip" ? gzipSync(inputBuf) : deflateSync(inputBuf);
  } else if (op === "decompress") {
    outputBuf = algorithm === "gzip" ? gunzipSync(inputBuf) : inflateSync(inputBuf);
  } else {
    throw new Error("compression: config.operation deve ser 'compress' ou 'decompress'");
  }

  return {
    output: {
      value: outputBuf.toString(outputEnc),
      originalSize: inputBuf.length,
      finalSize: outputBuf.length,
    },
  };
};
