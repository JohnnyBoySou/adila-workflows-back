import { createHash, createHmac, randomUUID } from "node:crypto";
import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Primitivas criptográficas — equivalente ao `n8n-nodes-base.crypto`.
 *
 * Config (discriminado por `operation`):
 *   - hash      → algorithm ("md5"|"sha1"|"sha256"|"sha512") + value + encoding?
 *   - hmac      → algorithm + value + secret + encoding?
 *   - uuid      → v4 (nenhum input)
 *   - random    → bytes (default 16) + encoding ("hex"|"base64")
 *   - base64    → mode ("encode"|"decode") + value
 *
 * encoding default: "hex". Tudo síncrono.
 *
 * Nome do arquivo é `crypto-node.ts` pra evitar shadow com o módulo nativo.
 */
const HASH_ALGOS = new Set(["md5", "sha1", "sha256", "sha512"]);
const HEX_OR_BASE64 = new Set(["hex", "base64"]);

/** Encoding de saída: default "hex"; valor inválido também cai em "hex". */
function resolveEncoding(raw: unknown): "hex" | "base64" {
  const enc = String(raw ?? "hex");
  return HEX_OR_BASE64.has(enc) ? (enc as "hex" | "base64") : "hex";
}

export const cryptoHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;

  if (op === "hash") {
    const algo = String(cfg.algorithm ?? "sha256");
    if (!HASH_ALGOS.has(algo)) throw new Error(`crypto hash: algoritmo "${algo}" não suportado`);
    const value = String(cfg.value ?? "");
    const enc = resolveEncoding(cfg.encoding);
    return { output: { digest: createHash(algo).update(value).digest(enc) } };
  }

  if (op === "hmac") {
    const algo = String(cfg.algorithm ?? "sha256");
    if (!HASH_ALGOS.has(algo)) throw new Error(`crypto hmac: algoritmo "${algo}" não suportado`);
    const value = String(cfg.value ?? "");
    const secret = cfg.secret;
    if (typeof secret !== "string" || !secret) {
      throw new Error("crypto hmac: `secret` é obrigatório");
    }
    const enc = resolveEncoding(cfg.encoding);
    return { output: { digest: createHmac(algo, secret).update(value).digest(enc) } };
  }

  if (op === "uuid") {
    return { output: { uuid: randomUUID() } };
  }

  if (op === "random") {
    const bytesRaw = Number(cfg.bytes);
    const bytes =
      Number.isFinite(bytesRaw) && bytesRaw > 0 ? Math.min(Math.floor(bytesRaw), 256) : 16;
    const enc = resolveEncoding(cfg.encoding);
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    const value =
      enc === "base64" ? Buffer.from(buf).toString("base64") : Buffer.from(buf).toString("hex");
    return { output: { value, bytes } };
  }

  if (op === "base64") {
    const mode = String(cfg.mode ?? "encode");
    const value = String(cfg.value ?? "");
    if (mode === "encode")
      return { output: { value: Buffer.from(value, "utf8").toString("base64") } };
    if (mode === "decode")
      return { output: { value: Buffer.from(value, "base64").toString("utf8") } };
    throw new Error(`crypto base64: mode "${mode}" inválido`);
  }

  throw new Error(`crypto: operation "${String(op)}" não suportada`);
};
