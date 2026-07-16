import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Avalia uma expressão matemática num sandbox restrito. Aceita números,
 * operadores `+ - * / % **`, parênteses, e funções de `Math` — tanto sem
 * prefixo (`sqrt(16)`, `PI`) quanto prefixadas (`Math.sqrt(16)`). Variáveis
 * podem ser passadas em `vars` e usadas pelo nome; um nome em `vars` sombreia
 * o membro homônimo de `Math`.
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
    if (id !== "Math" && !mathKeys.has(id) && !varKeys.has(id)) {
      throw new Error(`math: identificador "${id}" não permitido`);
    }
  }

  const varNames = Object.keys(vars);
  const varValues = varNames.map((k) => Number(vars[k]));

  // Nomes de Math usados na expressão viram parâmetros ligados ao valor
  // correspondente — é o que faz `sqrt(x)` e `PI` resolverem sem prefixo.
  // `vars` tem precedência: um var homônimo sombreia o membro de Math.
  const mathNames = [...new Set(identifiers)].filter((id) => mathKeys.has(id) && !varKeys.has(id));
  const mathValues = mathNames.map((k) => Math[k as keyof typeof Math]);

  // `Math` só entra na lista se `vars` não declarou esse nome — parâmetro
  // duplicado é SyntaxError em strict mode.
  const passMath = !varKeys.has("Math");
  const names = [...varNames, ...mathNames, ...(passMath ? ["Math"] : [])];
  const values = [...varValues, ...mathValues, ...(passMath ? [Math] : [])];

  try {
    const fn = new Function(...names, `"use strict"; return (${expression});`);
    const result = fn(...values);
    if (typeof result !== "number" || !Number.isFinite(result)) {
      return { output: { value: null, error: "resultado não numérico" } };
    }
    return { output: { value: result } };
  } catch (err) {
    throw new Error(`math: ${(err as Error).message}`);
  }
};
