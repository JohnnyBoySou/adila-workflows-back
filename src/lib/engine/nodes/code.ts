import type { NodeHandler } from "../types";

/**
 * Executa JavaScript arbitrário fornecido pelo usuário.
 *
 * Config:
 *   - code: string  — corpo da função; tem acesso a `input`, `vars`, `steps`, `env`
 *   - timeoutMs?: number  — timeout para código *async*. Default 5000, máx 30000.
 *
 * Output:
 *   - retorno do código (objeto) vira `output`. Retornos não-objeto entram como `{ result }`.
 *
 * Sandbox:
 *   - usa `new Function(...)` — sem acesso a `require`, `process`, ou globais
 *     adicionais. Globais nativos (Math, JSON, Date, etc) continuam disponíveis.
 *   - código síncrono com loop infinito *não* é interrompível (limite do JS);
 *     o timeout só protege contra Promises que não resolvem.
 *   - desenvolvido pra payload-shaping confiável, não pra rodar código de terceiros.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;

export const codeHandler: NodeHandler = async ({ node, context }) => {
  const code = node.config.code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("code: config.code é obrigatório (string com o corpo da função)");
  }

  const timeoutRaw = node.config.timeoutMs;
  const timeoutMs = Math.min(
    typeof timeoutRaw === "number" && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  // Construído com `new Function` pra isolar do escopo léxico do worker.
  // Tipos do retorno são propositalmente unknown — o usuário pode retornar qualquer coisa.
  let fn: (
    input: Record<string, unknown>,
    vars: Record<string, unknown>,
    steps: Record<string, Record<string, unknown>>,
    env: Record<string, string>,
  ) => unknown;
  try {
    fn = new Function("input", "vars", "steps", "env", `"use strict";\n${code}`) as never;
  } catch (err) {
    throw new Error(`code: erro de sintaxe — ${(err as Error).message}`, { cause: err });
  }

  const exec = (async () => fn(context.input, context.vars, context.steps, context.env))();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code: timeout após ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    const result = await Promise.race([exec, timeout]);
    if (result === null || result === undefined) return { output: {} };
    if (typeof result === "object" && !Array.isArray(result)) {
      return { output: result as Record<string, unknown> };
    }
    return { output: { result } };
  } finally {
    if (timer) clearTimeout(timer);
  }
};
