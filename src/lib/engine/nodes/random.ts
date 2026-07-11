import { randomBytes, randomInt } from "node:crypto";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Gera valores aleatórios.
 *
 * Config:
 *   type: "integer" | "float" | "string" | "bytes" | "pick" | "boolean"
 *   min?: number              — integer (default 0)
 *   max?: number              — integer (default 100, exclusivo)
 *   length?: number           — string/bytes (default 16)
 *   alphabet?: string         — string (default alfanumérico)
 *   encoding?: "hex" | "base64" | "base64url"  — bytes (default hex)
 *   items?: unknown[]         — pick (obrigatório)
 *
 * Output: { value }
 */
const DEFAULT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const randomHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const type = cfg.type;

  if (type === "integer") {
    const min = typeof cfg.min === "number" ? Math.floor(cfg.min) : 0;
    const max = typeof cfg.max === "number" ? Math.floor(cfg.max) : 100;
    if (max <= min) throw new Error("random.integer: max deve ser > min");
    return { output: { value: randomInt(min, max) } };
  }

  if (type === "float") {
    const min = typeof cfg.min === "number" ? cfg.min : 0;
    const max = typeof cfg.max === "number" ? cfg.max : 1;
    return { output: { value: min + Math.random() * (max - min) } };
  }

  if (type === "boolean") {
    return { output: { value: Math.random() < 0.5 } };
  }

  if (type === "string") {
    const length =
      typeof cfg.length === "number" && cfg.length > 0 ? Math.min(cfg.length, 4096) : 16;
    const alphabet =
      typeof cfg.alphabet === "string" && cfg.alphabet.length > 0 ? cfg.alphabet : DEFAULT_ALPHABET;
    const bytes = randomBytes(length);
    let out = "";
    for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
    return { output: { value: out } };
  }

  if (type === "bytes") {
    const length =
      typeof cfg.length === "number" && cfg.length > 0 ? Math.min(cfg.length, 4096) : 16;
    const enc = cfg.encoding === "base64" || cfg.encoding === "base64url" ? cfg.encoding : "hex";
    return { output: { value: randomBytes(length).toString(enc as BufferEncoding) } };
  }

  if (type === "pick") {
    if (!Array.isArray(cfg.items) || cfg.items.length === 0) {
      throw new Error("random.pick: config.items deve ser array não vazio");
    }
    const idx = randomInt(0, cfg.items.length);
    return { output: { value: cfg.items[idx] } };
  }

  throw new Error("random: config.type inválido (integer/float/string/bytes/pick/boolean)");
};
