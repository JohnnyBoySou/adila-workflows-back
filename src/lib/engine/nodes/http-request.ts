import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Faz uma requisição HTTP via fetch nativo do Bun.
 *
 * Config (todos os strings passam por `renderTemplate`):
 *
 *   url:           string                                — obrigatório
 *   method?:       "GET"|"POST"|"PUT"|"PATCH"|"DELETE"|"HEAD"   (default GET)
 *   queryParams?:  Record<string, string>                — anexados como ?k=v
 *   headers?:      Record<string, string>                — sobrescreve auth/body
 *   body?:         { mode, content, rawContentType? }    — modos abaixo
 *                  | string | object                      — shape legado
 *   auth?:         { type: "none"|"basic"|"bearer"|"api_key"|"oauth2", … }
 *   timeoutMs?:    number                                 — default 30000
 *   retry?:        { count: number, delayMs?: number }    — só em 5xx/timeout
 *   followRedirects?: boolean                             — default true
 *   skipSslVerify?:  boolean                              — atalho p/ Bun's verbose
 *   proxy?:        string                                 — repassado em proxy: …
 *
 * Modos de body:
 *   json:      content = obj/string. Content-Type application/json.
 *   form:      content = Record<string,string>. application/x-www-form-urlencoded.
 *   raw:       content = string. Content-Type = body.rawContentType ?? text/plain.
 *   multipart: content = Record<string,string>. multipart/form-data via FormData.
 *
 * Tipos de auth:
 *   basic:    Authorization: Basic base64(username:password)
 *   bearer:   Authorization: Bearer <token>
 *   api_key:  Em "header" → headers[apiKeyName]=apiKeyValue;
 *             em "query"  → queryParams[apiKeyName]=apiKeyValue.
 *   oauth2:   Authorization: Bearer <oauthToken>   (token pronto, sem fluxo)
 *
 * Output:
 *   { status, ok, headers, body, attempts }   body = JSON parseado quando possível
 */
const DEFAULT_TIMEOUT = 30_000;
const DEFAULT_RETRY_DELAY = 500;

type BodyMode = "json" | "form" | "raw" | "multipart";
type AuthType = "none" | "basic" | "bearer" | "api_key" | "oauth2";

interface NormalizedBody {
  mode: BodyMode;
  content?: unknown;
  rawContentType?: string;
}

interface NormalizedAuth {
  type: AuthType;
  username?: string;
  password?: string;
  token?: string;
  apiKeyName?: string;
  apiKeyValue?: string;
  apiKeyIn?: "header" | "query";
  oauthToken?: string;
}

export const httpRequestHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const url = cfg.url;
  if (typeof url !== "string" || !url) {
    throw new Error("http_request: config.url é obrigatório");
  }

  const method =
    typeof cfg.method === "string" && cfg.method.trim() !== "" ? cfg.method.toUpperCase() : "GET";
  const noBody = method === "GET" || method === "HEAD";

  // ── Headers + Query base ────────────────────────────────────────────────
  const headers: Record<string, string> = {};
  const queryParams: Record<string, string> = {};

  copyStringRecord(cfg.queryParams, queryParams);

  // ── Auth (pode escrever em headers/queryParams) ─────────────────────────
  const auth = normalizeAuth(cfg.auth);
  applyAuth(auth, headers, queryParams);

  // Headers do usuário sobrescrevem o que auth produziu — explícito ganha.
  copyStringRecord(cfg.headers, headers);

  // ── Body ────────────────────────────────────────────────────────────────
  let body: RequestInit["body"];
  if (!noBody && cfg.body !== undefined) {
    const built = buildBody(cfg.body, headers);
    body = built.body;
  }

  // ── URL final com query string ──────────────────────────────────────────
  const finalUrl = applyQueryParams(url, queryParams);

  // ── Opções de transporte ────────────────────────────────────────────────
  const timeoutMs = typeof cfg.timeoutMs === "number" ? cfg.timeoutMs : DEFAULT_TIMEOUT;
  const followRedirects = cfg.followRedirects !== false;
  const skipSslVerify = cfg.skipSslVerify === true;
  const proxy = typeof cfg.proxy === "string" && cfg.proxy.length > 0 ? cfg.proxy : undefined;

  const retry = normalizeRetry(cfg.retry);

  // ── Loop de retry ───────────────────────────────────────────────────────
  let lastError: unknown;
  for (let attempt = 1; attempt <= retry.count + 1; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      // Bun aceita `proxy` e `tls.rejectUnauthorized` no fetch — passagem
      // opcional, sem falhar em runtimes que não suportarem.
      const init: RequestInit & {
        proxy?: string;
        tls?: { rejectUnauthorized?: boolean };
      } = {
        method,
        headers,
        body,
        signal: ctrl.signal,
        redirect: followRedirects ? "follow" : "manual",
      };
      if (proxy) init.proxy = proxy;
      if (skipSslVerify) init.tls = { rejectUnauthorized: false };

      const res = await fetch(finalUrl, init);

      // Retry só em 5xx — 4xx é resposta legítima.
      if (res.status >= 500 && attempt <= retry.count) {
        await delay(retry.delayMs);
        continue;
      }

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
          attempts: attempt,
        },
      };
    } catch (err) {
      lastError = err;
      // AbortError (timeout) e erros de rede entram no retry budget.
      if (attempt <= retry.count) {
        await delay(retry.delayMs);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Defesa: o loop sempre retorna ou lança; só chega aqui em caso de retry
  // budget zerado por causa de 5xx repetidos.
  throw lastError instanceof Error
    ? lastError
    : new Error("http_request: falhou após esgotar retries");
};

/* -------------------------------------------------------------------------- */
/* Normalizadores                                                              */
/* -------------------------------------------------------------------------- */

function normalizeAuth(raw: unknown): NormalizedAuth {
  if (!raw || typeof raw !== "object") return { type: "none" };
  const r = raw as Record<string, unknown>;
  const type =
    r.type === "basic" ||
    r.type === "bearer" ||
    r.type === "api_key" ||
    r.type === "oauth2" ||
    r.type === "none"
      ? r.type
      : "none";
  return {
    type,
    ...(typeof r.username === "string" && { username: r.username }),
    ...(typeof r.password === "string" && { password: r.password }),
    ...(typeof r.token === "string" && { token: r.token }),
    ...(typeof r.apiKeyName === "string" && { apiKeyName: r.apiKeyName }),
    ...(typeof r.apiKeyValue === "string" && { apiKeyValue: r.apiKeyValue }),
    ...((r.apiKeyIn === "header" || r.apiKeyIn === "query") && { apiKeyIn: r.apiKeyIn }),
    ...(typeof r.oauthToken === "string" && { oauthToken: r.oauthToken }),
  };
}

function normalizeRetry(raw: unknown): { count: number; delayMs: number } {
  if (!raw || typeof raw !== "object") return { count: 0, delayMs: DEFAULT_RETRY_DELAY };
  const r = raw as Record<string, unknown>;
  const count = typeof r.count === "number" && r.count > 0 ? Math.min(Math.floor(r.count), 10) : 0;
  const delayMs =
    typeof r.delayMs === "number" && r.delayMs >= 0 ? Math.floor(r.delayMs) : DEFAULT_RETRY_DELAY;
  return { count, delayMs };
}

/**
 * Normaliza o body em qualquer formato suportado (legado ou novo). Em modos
 * que carregam Content-Type implícito (json/form/multipart), só define o
 * header se o usuário ainda não tiver fixado.
 */
function buildBody(
  raw: unknown,
  headers: Record<string, string>,
): { body: RequestInit["body"] } {
  // Shape novo: { mode, content, rawContentType? }
  if (raw && typeof raw === "object" && "mode" in raw) {
    const b = raw as Partial<NormalizedBody>;
    const mode = (b.mode ?? "json") as BodyMode;
    switch (mode) {
      case "json":
        return buildJsonBody(b.content, headers);
      case "form":
        return buildFormBody(b.content, headers);
      case "multipart":
        return buildMultipartBody(b.content, headers);
      case "raw":
        return buildRawBody(b.content, b.rawContentType, headers);
      default:
        return buildJsonBody(b.content, headers);
    }
  }

  // Shape legado: string vai como texto puro; objeto vira JSON.
  if (typeof raw === "string") {
    return { body: raw };
  }
  return buildJsonBody(raw, headers);
}

function buildJsonBody(
  content: unknown,
  headers: Record<string, string>,
): { body: RequestInit["body"] } {
  if (content === undefined || content === null || content === "") return { body: undefined };
  setContentTypeIfAbsent(headers, "application/json");
  if (typeof content === "string") return { body: content };
  return { body: JSON.stringify(content) };
}

function buildFormBody(
  content: unknown,
  headers: Record<string, string>,
): { body: RequestInit["body"] } {
  const params = new URLSearchParams();
  if (content && typeof content === "object") {
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
      if (v == null) continue;
      params.append(k, String(v));
    }
  }
  setContentTypeIfAbsent(headers, "application/x-www-form-urlencoded");
  return { body: params };
}

function buildMultipartBody(
  content: unknown,
  headers: Record<string, string>,
): { body: RequestInit["body"] } {
  const form = new FormData();
  if (content && typeof content === "object") {
    for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
      if (v == null) continue;
      // Em runtime de servidor, file uploads via Blob requerem o engine ter
      // resolvido o template pra Blob — string segue como string field.
      if (v instanceof Blob) form.append(k, v);
      else form.append(k, String(v));
    }
  }
  // Multipart precisa do boundary auto — não setamos Content-Type manual
  // (deixar undefined faz o fetch montar com boundary correto).
  delete headers["content-type"];
  return { body: form };
}

function buildRawBody(
  content: unknown,
  contentType: string | undefined,
  headers: Record<string, string>,
): { body: RequestInit["body"] } {
  if (content === undefined || content === null) return { body: undefined };
  if (contentType && contentType.length > 0) {
    setContentTypeIfAbsent(headers, contentType);
  }
  return { body: typeof content === "string" ? content : String(content) };
}

/* -------------------------------------------------------------------------- */
/* Auth                                                                        */
/* -------------------------------------------------------------------------- */

function applyAuth(
  auth: NormalizedAuth,
  headers: Record<string, string>,
  queryParams: Record<string, string>,
) {
  switch (auth.type) {
    case "basic": {
      const user = auth.username ?? "";
      const pass = auth.password ?? "";
      const encoded = Buffer.from(`${user}:${pass}`).toString("base64");
      headers["authorization"] = `Basic ${encoded}`;
      return;
    }
    case "bearer": {
      if (auth.token) headers["authorization"] = `Bearer ${auth.token}`;
      return;
    }
    case "api_key": {
      if (!auth.apiKeyName || !auth.apiKeyValue) return;
      if (auth.apiKeyIn === "query") queryParams[auth.apiKeyName] = auth.apiKeyValue;
      else headers[auth.apiKeyName] = auth.apiKeyValue;
      return;
    }
    case "oauth2": {
      if (auth.oauthToken) headers["authorization"] = `Bearer ${auth.oauthToken}`;
      return;
    }
    case "none":
    default:
      return;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function copyStringRecord(raw: unknown, into: Record<string, string>) {
  if (!raw || typeof raw !== "object") return;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null) continue;
    into[k] = String(v);
  }
}

function setContentTypeIfAbsent(headers: Record<string, string>, value: string) {
  if (!headers["content-type"] && !headers["Content-Type"]) {
    headers["content-type"] = value;
  }
}

function applyQueryParams(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return url;
  // Preserva qualquer query existente na URL — se houver "?", anexa com "&".
  const separator = url.includes("?") ? "&" : "?";
  const qs = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return `${url}${separator}${qs}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
