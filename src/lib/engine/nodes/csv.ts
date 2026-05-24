import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * CSV/TSV parse e build. Implementação RFC-4180 enxuta:
 * suporta aspas duplas com escape "", quebras de linha dentro de campos
 * aspeados e delimitador configurável.
 *
 * Config (discriminado por `operation`):
 *   - parse → value: string, delimiter?: ",", headers?: bool=true
 *             headers=true → items: Record<string,string>[]
 *             headers=false → rows: string[][]
 *   - build → items: Record<string, unknown>[], delimiter?: ","
 *             headers inferidas da união das chaves de items
 */
function parseCsv(src: string, delim: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function escapeField(v: unknown, delim: string): string {
  const s = v == null ? "" : String(v);
  if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export const csvHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;
  const delim = typeof cfg.delimiter === "string" && cfg.delimiter ? cfg.delimiter : ",";

  if (op === "parse") {
    const rows = parseCsv(String(cfg.value ?? ""), delim);
    const headers = cfg.headers !== false;
    if (!headers) return { output: { rows, length: rows.length } };
    if (rows.length === 0) return { output: { items: [], length: 0 } };
    const [head, ...body] = rows;
    const items = body.map((r) => {
      const o: Record<string, string> = {};
      for (let i = 0; i < head.length; i++) o[head[i]] = r[i] ?? "";
      return o;
    });
    return { output: { items, length: items.length, headers: head } };
  }

  if (op === "build") {
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    const keySet = new Set<string>();
    for (const it of items) {
      if (it && typeof it === "object") for (const k of Object.keys(it)) keySet.add(k);
    }
    const headers = Array.from(keySet);
    const lines = [headers.map((h) => escapeField(h, delim)).join(delim)];
    for (const it of items) {
      const obj = (it ?? {}) as Record<string, unknown>;
      lines.push(headers.map((h) => escapeField(obj[h], delim)).join(delim));
    }
    return { output: { text: lines.join("\n"), headers } };
  }

  throw new Error(`csv: operation "${String(op)}" não suportada`);
};
