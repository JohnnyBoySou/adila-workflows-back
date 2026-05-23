/**
 * Criptografia simétrica para secrets em repouso.
 *
 * AES-256-GCM com IV de 96 bits gerado aleatoriamente por chamada e tag de 128 bits.
 * Formato do payload: `enc:v1:<base64(iv || tag || ciphertext)>`.
 * O prefixo `enc:v1:` é o discriminador — permite reconhecer valores cifrados e
 * preservar compatibilidade com rows legadas em texto puro até o back-fill rodar.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = "enc:v1:";

let cachedKey: Buffer | null = null;
function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = Buffer.from(env.ENCRYPTION_KEY, "base64");
  if (raw.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY deve ser 32 bytes em base64 (got ${raw.length}). Gere com: openssl rand -base64 32`,
    );
  }
  cachedKey = raw;
  return cachedKey;
}

export function isEncrypted(value: string): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encrypt(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decrypt(payload: string): string {
  if (!isEncrypted(payload)) return payload; // compat com texto puro legado
  const buf = Buffer.from(payload.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}
