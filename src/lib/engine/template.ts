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

/** Navega `obj` por `path` (ex: "a.b.0.c"); devolve undefined se quebrar. */
export function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveExpression(expr: string, ctx: ExecutionContext): unknown {
  // Permitimos prefixos: input, vars, env, steps.
  return resolvePath(ctx, expr);
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
