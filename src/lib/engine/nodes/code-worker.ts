/**
 * Worker de sandbox para o nó `code`.
 *
 * Roda numa thread separada (Bun Worker) com heap próprio — o código do
 * usuário não enxerga as conexões/segredos em memória do worker BullMQ, e um
 * loop síncrono infinito ou um crash aqui NÃO derruba o processo principal:
 * o handler mata esta thread com `worker.terminate()` no timeout.
 *
 * Protocolo:
 *   ← postMessage({ code, input, prev, vars, steps, env })
 *   → postMessage({ ok: true,  result })            // result já JSON-clonado
 *   → postMessage({ ok: false, error: {message, name, stack?} })
 *
 * A modelagem do output (unwrap de `[{json}]`, wrap de primitivos) fica no
 * handler principal — aqui só devolvemos o retorno cru já serializável.
 */
import {
  SHADOWED_GLOBALS,
  buildN8nShims,
  buildNativePreamble,
  stripCollidingShims,
} from "./code-shims";

declare const self: Worker;

/**
 * Constrói funções `async` (não `new Function`, que é síncrona) — assim o
 * código do usuário pode usar `await` no topo. Obtido do protótipo de uma
 * async function; a referência é capturada aqui, no escopo do worker, antes de
 * qualquer shadowing de `Function` no escopo do usuário.
 */
const AsyncFunction = Object.getPrototypeOf(async function noop() {})
  .constructor as FunctionConstructor;

interface CodeJob {
  code: string;
  input: Record<string, unknown>;
  prev: Record<string, unknown>;
  vars: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  env: Record<string, string>;
}

/**
 * Garante que o valor cruze a fronteira do `postMessage` (structured clone) e
 * seja persistível em JSONB. Round-trip por JSON descarta funções, símbolos e
 * referências cíclicas — mesmas restrições que o output do nó já tem.
 */
function toCloneable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { __unserializable: String(value) };
  }
}

async function run(job: CodeJob): Promise<void> {
  const { code, input, prev, vars, steps, env } = job;

  const shims = stripCollidingShims(buildN8nShims(input, prev, vars, steps, env), code);
  const shimNames = Object.keys(shims);
  const shimValues = shimNames.map((k) => shims[k]);

  // Args nativos adila prefixados com `__adila_` pra não colidir com `const
  // input = ...` frequente em código n8n importado. Em seguida os shims n8n e,
  // por último, os globais neutralizados (bindados a `undefined`).
  type CodeFn = (...args: unknown[]) => Promise<unknown>;
  let fn: CodeFn;
  try {
    // "use strict" precisa ser a 1ª instrução; o preâmbulo (aliases nativos)
    // vem depois, e só então o corpo do usuário.
    const body = `"use strict";\n${buildNativePreamble(code)}${code}`;
    fn = new AsyncFunction(
      "__adila_input",
      "__adila_vars",
      "__adila_steps",
      "__adila_env",
      ...shimNames,
      ...SHADOWED_GLOBALS,
      body,
    ) as CodeFn;
  } catch (err) {
    const e = err as Error;
    postMessage({
      ok: false,
      error: { message: `code: erro de sintaxe — ${e.message}`, name: "SyntaxError" },
    });
    return;
  }

  try {
    const shadowValues = SHADOWED_GLOBALS.map(() => undefined);
    const result = await fn(input, vars, steps, env, ...shimValues, ...shadowValues);
    postMessage({ ok: true, result: toCloneable(result) });
  } catch (err) {
    const e = err as Error;
    postMessage({
      ok: false,
      error: { message: e.message, name: e.name || "Error", stack: e.stack },
    });
  }
}

self.onmessage = (event: MessageEvent<CodeJob>) => {
  void run(event.data);
};
