import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Conversor XML básico — parser e builder próprios, sem dependências.
 * Cobre o caso comum: tags aninhadas, texto e atributos simples; ignora
 * CDATA e namespaces (atributos com `:` são mantidos como nome literal).
 *
 * Config:
 *   - operation: "parse" | "build"
 *   - parse: value: string         → { data }
 *   - build: data: object, root?   → { text }
 */

type XmlNode = { tag: string; attrs: Record<string, string>; children: XmlNode[]; text?: string };

function parseXml(src: string): XmlNode | null {
  const stripped = src.replace(/<\?xml[^?]*\?>/g, "").trim();
  const tokenRe = /<\/?([\w:-]+)([^>]*?)\/?>|([^<]+)/g;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(stripped))) {
    const [full, tag, attrsRaw, text] = m;
    if (text !== undefined) {
      const t = text.trim();
      if (t && stack.length) {
        const top = stack[stack.length - 1];
        top.text = (top.text ?? "") + t;
      }
      continue;
    }
    if (full.startsWith("</")) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (attrsRaw ?? "").matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
      attrs[a[1]] = a[2];
    }
    const node: XmlNode = { tag, attrs, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    if (!full.endsWith("/>")) stack.push(node);
  }
  return root;
}

function toPlain(node: XmlNode): unknown {
  if (node.children.length === 0 && !Object.keys(node.attrs).length) {
    return node.text ?? "";
  }
  const out: Record<string, unknown> = {};
  if (Object.keys(node.attrs).length) out["@attrs"] = node.attrs;
  if (node.text) out["#text"] = node.text;
  for (const child of node.children) {
    const value = toPlain(child);
    const existing = out[child.tag];
    if (existing === undefined) out[child.tag] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[child.tag] = [existing, value];
  }
  return out;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildXml(tag: string, value: unknown): string {
  if (value === null || value === undefined) return `<${tag}/>`;
  if (typeof value !== "object") return `<${tag}>${escapeXml(String(value))}</${tag}>`;
  if (Array.isArray(value)) return value.map((v) => buildXml(tag, v)).join("");
  const obj = value as Record<string, unknown>;
  const attrsRaw = obj["@attrs"];
  let attrs = "";
  if (attrsRaw && typeof attrsRaw === "object") {
    for (const [k, v] of Object.entries(attrsRaw as Record<string, unknown>)) {
      attrs += ` ${k}="${escapeXml(String(v))}"`;
    }
  }
  let inner = "";
  if (typeof obj["#text"] === "string") inner += escapeXml(obj["#text"]);
  for (const [k, v] of Object.entries(obj)) {
    if (k === "@attrs" || k === "#text") continue;
    inner += buildXml(k, v);
  }
  return inner ? `<${tag}${attrs}>${inner}</${tag}>` : `<${tag}${attrs}/>`;
}

export const xmlHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;

  if (op === "parse") {
    const root = parseXml(String(cfg.value ?? ""));
    if (!root) return { output: { data: null } };
    return { output: { data: { [root.tag]: toPlain(root) } } };
  }

  if (op === "build") {
    const root = typeof cfg.root === "string" && cfg.root ? cfg.root : "root";
    return {
      output: { text: `<?xml version="1.0" encoding="UTF-8"?>${buildXml(root, cfg.data)}` },
    };
  }

  throw new Error(`xml: operation "${String(op)}" não suportada`);
};
