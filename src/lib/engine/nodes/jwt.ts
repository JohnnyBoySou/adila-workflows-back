import { SignJWT, jwtVerify, decodeJwt } from "jose";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Assina, verifica ou decodifica JSON Web Tokens (HS256/HS384/HS512).
 *
 * Config:
 *   operation: "sign" | "verify" | "decode"   — obrigatório
 *   token?:    string                          — para verify/decode
 *   payload?:  Record<string, unknown>         — para sign
 *   secret?:   string                          — para sign/verify (HS*)
 *   algorithm?: "HS256"|"HS384"|"HS512"        — default HS256
 *   expiresIn?: string                         — ex: "1h", "10m" (sign)
 *   issuer?:   string
 *   audience?: string
 *
 * Output:
 *   sign:    { token }
 *   verify:  { valid, payload, header }
 *   decode:  { payload, header }
 */
export const jwtHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;
  const alg =
    cfg.algorithm === "HS384" || cfg.algorithm === "HS512" ? cfg.algorithm : "HS256";

  if (op === "decode") {
    if (typeof cfg.token !== "string") throw new Error("jwt.decode: config.token é obrigatório");
    const payload = decodeJwt(cfg.token);
    return { output: { payload, header: parseHeader(cfg.token) } };
  }

  if (op === "sign") {
    if (!cfg.payload || typeof cfg.payload !== "object") {
      throw new Error("jwt.sign: config.payload é obrigatório");
    }
    if (typeof cfg.secret !== "string" || !cfg.secret) {
      throw new Error("jwt.sign: config.secret é obrigatório");
    }
    let signer = new SignJWT(cfg.payload as Record<string, unknown>).setProtectedHeader({ alg });
    signer = signer.setIssuedAt();
    if (typeof cfg.expiresIn === "string" && cfg.expiresIn)
      signer = signer.setExpirationTime(cfg.expiresIn);
    if (typeof cfg.issuer === "string") signer = signer.setIssuer(cfg.issuer);
    if (typeof cfg.audience === "string") signer = signer.setAudience(cfg.audience);
    const token = await signer.sign(new TextEncoder().encode(cfg.secret));
    return { output: { token } };
  }

  if (op === "verify") {
    if (typeof cfg.token !== "string") throw new Error("jwt.verify: config.token é obrigatório");
    if (typeof cfg.secret !== "string" || !cfg.secret) {
      throw new Error("jwt.verify: config.secret é obrigatório");
    }
    try {
      const { payload, protectedHeader } = await jwtVerify(
        cfg.token,
        new TextEncoder().encode(cfg.secret),
        {
          ...(typeof cfg.issuer === "string" && { issuer: cfg.issuer }),
          ...(typeof cfg.audience === "string" && { audience: cfg.audience }),
        },
      );
      return { output: { valid: true, payload, header: protectedHeader } };
    } catch (err) {
      return {
        output: { valid: false, error: (err as Error).message },
      };
    }
  }

  throw new Error("jwt: config.operation deve ser 'sign', 'verify' ou 'decode'");
};

function parseHeader(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[0];
  if (!seg) return null;
  try {
    const padded = seg.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}
