import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Avalia uma expressão matemática num sandbox restrito. Aceita números,
 * operadores `+ - * / % **`, parênteses, e funções de `Math`. Variáveis
 * podem ser passadas em `vars` e usadas pelo nome.
 *
 * Config:
 *   - expression: string  ex: "sqrt(a*a + b*b)"
 *   - vars?: Record<string, number>
 *
 * Segurança: a expressão é validada contra um regex allowlist antes do
 * `new Function`. Apenas identificadores em `Math` ou em `vars` são
 * permitidos — qualquer outra coisa rejeita.
 */
const SAFE_RE = /^[\s0-9+\-*/%().,a-zA-Z_]+$/;

export const mathHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const expression = String(cfg.expression ?? "").trim();
  if (!expression) throw new Error("math: `expression` é obrigatório");
  if (!SAFE_RE.test(expression)) {
    throw new Error("math: expressão contém caracteres não permitidos");
  }

  const vars =
    cfg.vars && typeof cfg.vars === "object" ? (cfg.vars as Record<string, unknown>) : {};
  const identifiers = expression.match(/[a-zA-Z_]\w*/g) ?? [];
  const mathKeys = new Set(Object.getOwnPropertyNames(Math));
  const varKeys = new Set(Object.keys(vars));
  for (const id of identifiers) {
    if (!mathKeys.has(id) && !varKeys.has(id)) {
      throw new Error(`math: identificador "${id}" não permitido`);
    }
  }

  const varNames = Object.keys(vars);
  const varValues = varNames.map((k) => Number(vars[k]));
  try {
    const fn = new Function("Math", ...varNames, `"use strict"; return (${expression});`);
    const result = fn(Math, ...varValues);
    if (typeof result !== "number" || !Number.isFinite(result)) {
      return { output: { value: null, error: "resultado não numérico" } };
    }
    return { output: { value: result } };
  } catch (err) {
    throw new Error(`math: ${(err as Error).message}`);
  }
};
