import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Extração rasa de HTML por seletor. Para evitar dependências, suportamos
 * apenas seletores simples: tag, `#id`, `.class`, `tag.class`, `tag#id`.
 * Para casos complexos, use um nó de código com `cheerio` no futuro.
 *
 * Config:
 *   - value: string             HTML de entrada
 *   - selector: string          seletor simples
 *   - attribute?: string        se dado, retorna o valor do atributo; senão innerText
 *   - all?: boolean             true → matches[], false → primeiro
 */
type SimpleSelector = { tag?: string; id?: string; class?: string };

function parseSelector(sel: string): SimpleSelector {
  const out: SimpleSelector = {};
  const m = sel.trim().match(/^([a-zA-Z][\w-]*)?(?:#([\w-]+))?(?:\.([\w-]+))?$/);
  if (!m) throw new Error(`html_extract: seletor "${sel}" não suportado`);
  if (m[1]) out.tag = m[1].toLowerCase();
  if (m[2]) out.id = m[2];
  if (m[3]) out.class = m[3];
  return out;
}

function findMatches(html: string, sel: SimpleSelector): { open: string; inner: string }[] {
  const tagPattern = sel.tag ?? "[a-zA-Z][\\w-]*";
  const re = new RegExp(`<(${tagPattern})\\b([^>]*)>([\\s\\S]*?)</\\1>`, "gi");
  const out: { open: string; inner: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const [, , attrs, inner] = m;
    if (sel.id) {
      const im = attrs.match(/\bid\s*=\s*"([^"]*)"/i);
      if (!im || im[1] !== sel.id) continue;
    }
    if (sel.class) {
      const cm = attrs.match(/\bclass\s*=\s*"([^"]*)"/i);
      if (!cm || !cm[1].split(/\s+/).includes(sel.class)) continue;
    }
    out.push({ open: attrs, inner });
  }
  return out;
}

function innerText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function attrValue(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return m?.[1];
}

export const htmlExtractHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const html = String(cfg.value ?? "");
  const selectorRaw = cfg.selector;
  if (typeof selectorRaw !== "string" || !selectorRaw) {
    throw new Error("html_extract: `selector` é obrigatório");
  }
  const sel = parseSelector(selectorRaw);
  const attribute = typeof cfg.attribute === "string" ? cfg.attribute : undefined;
  const matches = findMatches(html, sel);

  const values = matches.map((m) =>
    attribute ? (attrValue(m.open, attribute) ?? null) : innerText(m.inner),
  );

  if (cfg.all) return { output: { matches: values, length: values.length } };
  return { output: { value: values[0] ?? null, length: values.length } };
};
