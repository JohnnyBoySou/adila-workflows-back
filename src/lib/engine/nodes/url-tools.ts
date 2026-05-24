import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Operações sobre URLs e query strings (stdlib URL/URLSearchParams).
 *
 * Config:
 *   operation: "parse" | "build" | "encode" | "decode" | "parse_query" | "build_query"
 *   url?:      string
 *   parts?:    { protocol, hostname, port, pathname, search, hash }
 *   query?:    Record<string, string | number | boolean>
 *   value?:    string                — para encode/decode
 *
 * Output: varia por operação (sempre objeto).
 */
export const urlToolsHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;

  if (op === "parse") {
    if (typeof cfg.url !== "string") throw new Error("url_tools.parse: config.url é obrigatório");
    const u = new URL(cfg.url);
    return {
      output: {
        href: u.href,
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        pathname: u.pathname,
        search: u.search,
        hash: u.hash,
        searchParams: Object.fromEntries(u.searchParams.entries()),
      },
    };
  }

  if (op === "build") {
    const parts = (cfg.parts as Record<string, unknown> | undefined) ?? {};
    const protocol = String(parts.protocol ?? "https:");
    const hostname = String(parts.hostname ?? "");
    if (!hostname) throw new Error("url_tools.build: parts.hostname é obrigatório");
    const base = `${protocol}//${hostname}${parts.port ? `:${parts.port}` : ""}`;
    const u = new URL(typeof parts.pathname === "string" ? parts.pathname : "/", base);
    if (cfg.query && typeof cfg.query === "object") {
      for (const [k, v] of Object.entries(cfg.query as Record<string, unknown>)) {
        if (v == null) continue;
        u.searchParams.append(k, String(v));
      }
    }
    if (typeof parts.hash === "string") u.hash = parts.hash;
    return { output: { url: u.toString() } };
  }

  if (op === "encode") {
    if (typeof cfg.value !== "string") throw new Error("url_tools.encode: config.value é obrigatório");
    return { output: { value: encodeURIComponent(cfg.value) } };
  }

  if (op === "decode") {
    if (typeof cfg.value !== "string") throw new Error("url_tools.decode: config.value é obrigatório");
    return { output: { value: decodeURIComponent(cfg.value) } };
  }

  if (op === "parse_query") {
    const src = typeof cfg.value === "string" ? cfg.value : typeof cfg.url === "string" ? cfg.url : "";
    const qs = src.includes("?") ? src.slice(src.indexOf("?") + 1) : src;
    const params = new URLSearchParams(qs);
    return { output: { query: Object.fromEntries(params.entries()) } };
  }

  if (op === "build_query") {
    const params = new URLSearchParams();
    if (cfg.query && typeof cfg.query === "object") {
      for (const [k, v] of Object.entries(cfg.query as Record<string, unknown>)) {
        if (v == null) continue;
        params.append(k, String(v));
      }
    }
    return { output: { query: params.toString() } };
  }

  throw new Error(
    "url_tools: config.operation inválida (parse, build, encode, decode, parse_query, build_query)",
  );
};
