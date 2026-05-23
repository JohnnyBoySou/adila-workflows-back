import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Faz uma requisição HTTP via fetch nativo do Bun.
 *
 * Config:
 *   - url: string (templatable)
 *   - method?: "GET"|"POST"|... (default GET)
 *   - headers?: Record<string, string> (templatable)
 *   - body?: any (objeto vira JSON; string vai como texto)
 *   - timeoutMs?: number (default 30000)
 *
 * Output:
 *   { status, ok, headers, body }   (body é JSON parseado quando possível)
 */
const DEFAULT_TIMEOUT = 30_000;

export const httpRequestHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const url = cfg.url;
  if (typeof url !== "string" || !url) {
    throw new Error("http_request: config.url é obrigatório");
  }

  const method = typeof cfg.method === "string" ? cfg.method.toUpperCase() : "GET";
  const headers: Record<string, string> = {};
  if (cfg.headers && typeof cfg.headers === "object") {
    for (const [k, v] of Object.entries(cfg.headers as Record<string, unknown>)) {
      if (v != null) headers[k] = String(v);
    }
  }

  let body: string | undefined;
  if (cfg.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof cfg.body === "string") {
      body = cfg.body;
    } else {
      body = JSON.stringify(cfg.body);
      headers["content-type"] ??= "application/json";
    }
  }

  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // mantém como texto
    }
    return {
      output: {
        status: res.status,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        body: parsed,
      },
    };
  } finally {
    clearTimeout(timer);
  }
};
