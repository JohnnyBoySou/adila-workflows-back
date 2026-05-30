/**
 * Interpolador de templates `{{ path.to.value }}`.
 *
 * Usado em todas as configs de nó pra referenciar dados do contexto:
 *
 *     "URL = {{ input.url }} key = {{ env.API_KEY }}"
 *     "msg do passo anterior: {{ steps.node-1.text }}"
 *
 * Quando o template é a string inteira (`"{{ steps.x.data }}"`), devolve
 * o valor cru (objeto, número, etc). Caso contrário, interpola como string.
 */
import type { ExecutionContext } from "./types";

const TEMPLATE_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const WHOLE_TEMPLATE_RE = /^\{\{\s*([^}]+?)\s*\}\}$/;

/** Navega `obj` por `path`. Aceita notação ponto (`a.b.c`), índices numéricos
 *  (`a.0.b`) E colchetes com strings (`a['key com espaço'].b`).
 *  Útil pra chaves com caracteres especiais (acentos, espaços, símbolos). */
export function resolvePath(obj: unknown, path: string): unknown {
  // Tokeniza: separa por `.` E extrai `['...']` ou `["..."]` como tokens próprios.
  const tokens: string[] = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === "[") {
      const close = path.indexOf("]", i);
      if (close < 0) break;
      let inner = path.slice(i + 1, close);
      // Remove aspas se houver: 'foo' → foo, "foo" → foo
      inner = inner.replace(/^['"]|['"]$/g, "");
      tokens.push(inner);
      i = close + 1;
      if (path[i] === ".") i++;
    } else {
      const next = Math.min(
        ...[path.indexOf(".", i), path.indexOf("[", i)].filter((n) => n >= 0),
        path.length,
      );
      const token = path.slice(i, next);
      if (token) tokens.push(token);
      i = next;
      if (path[i] === ".") i++;
    }
  }

  let current: unknown = obj;
  for (const part of tokens) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveExpression(expr: string, ctx: ExecutionContext): unknown {
  // Aceita aliases n8n diretamente, pra workflows importados de versões
  // antigas do importer que não rewrote tudo:
  //   $json.X       → prev.X
  //   $json['X']    → prev['X']
  //   $node["N"].json.X → steps.<...>.X (não suportado aqui — rewriter resolve)
  let normalized = expr;
  if (normalized.startsWith("$json.")) {
    normalized = "prev." + normalized.slice(6);
  } else if (normalized.startsWith("$json[")) {
    normalized = "prev" + normalized.slice(5);
  }

  // Permitimos prefixos: input, vars, env, steps, prev.
  const direct = resolvePath(ctx, normalized);
  if (direct !== undefined) return direct;

  // Fallback automático: `prev.X` ou `input.X` undefined → tenta o outro,
  // depois tenta `vars.X`. Motivo: o importer n8n traduz `$json.X` (item
  // atual fluindo) ora pra `prev.X`, ora pra `input.X`, mas o nó upstream
  // pode ter sido um set_variable que joga X em `vars`. Sem esse fallback,
  // qualquer template depois de filter/code/redis/etc. quebra porque o
  // `prev` muda de shape (ex.: filter retorna `{items:[]}`).
  for (const alt of crossPrefixes(normalized)) {
    const v = resolvePath(ctx, alt);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Gera variantes do path trocando o prefixo entre prev/input/vars. */
function crossPrefixes(path: string): string[] {
  const PREFIXES = ["prev.", "prev[", "input.", "input["];
  const alts: string[] = [];
  for (const p of PREFIXES) {
    if (path.startsWith(p)) {
      const rest = path.slice(p.length);
      const sep = p.endsWith(".") ? "." : "[";
      for (const target of ["prev", "input", "vars"]) {
        if (path.startsWith(target)) continue;
        alts.push(`${target}${sep}${rest}`);
      }
    }
  }
  return alts;
}

/**
 * Renderiza um valor qualquer aplicando templates recursivamente.
 *
 * - Strings: substitui `{{...}}`; se for um template "puro" devolve o
 *   valor cru (preserva tipo).
 * - Arrays/objetos: recursão.
 * - Resto: passa direto.
 */
export function renderTemplate(value: unknown, ctx: ExecutionContext): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_TEMPLATE_RE);
    if (whole) return resolveExpression(whole[1]!, ctx);
    return value.replace(TEMPLATE_RE, (_, expr: string) => {
      const resolved = resolveExpression(expr.trim(), ctx);
      if (resolved == null) return "";
      return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderTemplate(v, ctx);
    }
    return out;
  }
  return value;
}
