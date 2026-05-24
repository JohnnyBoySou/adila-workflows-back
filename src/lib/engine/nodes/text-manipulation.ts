import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Operações de string.
 *
 * Config (discriminado por `operation`):
 *   - replace        → value, search, replacement, regex?: bool, flags?: "g"|"gi"|...
 *   - split          → value, separator, limit?: number          → { parts }
 *   - join           → items: unknown[], separator                → { text }
 *   - upper / lower / trim → value
 *   - length         → value                                      → { length }
 *   - substring      → value, start: number, end?: number         → { text }
 *   - regex_match    → value, pattern, flags?                     → { matches, first }
 *   - pad            → value, length: number, side?: "left"|"right", fill?: " "
 */
export const textManipulationHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = String(cfg.operation ?? "");
  const value = String(cfg.value ?? "");

  if (op === "replace") {
    const search = String(cfg.search ?? "");
    const replacement = String(cfg.replacement ?? "");
    if (cfg.regex) {
      const flags = typeof cfg.flags === "string" ? cfg.flags : "g";
      return { output: { text: value.replace(new RegExp(search, flags), replacement) } };
    }
    return { output: { text: value.split(search).join(replacement) } };
  }

  if (op === "split") {
    const sep = String(cfg.separator ?? "");
    const limit = typeof cfg.limit === "number" ? cfg.limit : undefined;
    return { output: { parts: value.split(sep, limit) } };
  }

  if (op === "join") {
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    const sep = String(cfg.separator ?? "");
    return { output: { text: items.map((v) => (v == null ? "" : String(v))).join(sep) } };
  }

  if (op === "upper") return { output: { text: value.toUpperCase() } };
  if (op === "lower") return { output: { text: value.toLowerCase() } };
  if (op === "trim") return { output: { text: value.trim() } };
  if (op === "length") return { output: { length: value.length } };

  if (op === "substring") {
    const start = Number(cfg.start ?? 0);
    const end = cfg.end === undefined ? undefined : Number(cfg.end);
    return { output: { text: value.substring(start, end) } };
  }

  if (op === "regex_match") {
    const pattern = String(cfg.pattern ?? "");
    if (!pattern) throw new Error("text_manipulation regex_match: `pattern` é obrigatório");
    const flags = typeof cfg.flags === "string" ? cfg.flags : "g";
    const re = new RegExp(pattern, flags);
    const matches = flags.includes("g")
      ? Array.from(value.matchAll(re), (m) => m[0])
      : ((value.match(re) ?? []) as string[]);
    return { output: { matches, first: matches[0] ?? null, length: matches.length } };
  }

  if (op === "pad") {
    const len = Math.max(0, Number(cfg.length ?? 0));
    const fill = typeof cfg.fill === "string" && cfg.fill ? cfg.fill : " ";
    const text = cfg.side === "right" ? value.padEnd(len, fill) : value.padStart(len, fill);
    return { output: { text } };
  }

  throw new Error(`text_manipulation: operation "${op}" não suportada`);
};
