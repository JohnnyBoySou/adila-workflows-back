import type { NodeHandler } from "../types";

/**
 * Executa JavaScript arbitrário fornecido pelo usuário, ISOLADO numa thread
 * (Bun Worker) — ver `code-worker.ts`.
 *
 * Config:
 *   - code: string  — corpo da função; tem acesso a:
 *     • `input`, `vars`, `steps`, `env`         — sintaxe nativa adila
 *     • `$input`, `$json`, `$node`, `$vars`, `$env`,
 *       `$now`, `$today`, `$execution`, `$workflow`,
 *       `$prevNode`, `$items()`                — polyfills compatíveis com n8n
 *   - timeoutMs?: number  — timeout de parede. Default 5000, máx 30000.
 *
 * Output:
 *   - retorno do código (objeto) vira `output`. Retornos não-objeto entram como `{ result }`.
 *
 * Sandbox (isolamento de thread):
 *   - roda num Worker com heap próprio — não enxerga conexões/segredos em
 *     memória do worker BullMQ.
 *   - **loop síncrono infinito é interrompível**: o timeout mata a thread com
 *     `worker.terminate()` (ao contrário do `new Function` in-process anterior,
 *     onde só Promises pendentes eram interrompíveis).
 *   - um crash no código do usuário fica contido na thread — não derruba o worker.
 *   - globais perigosos (`process`, `Bun`, `require`, `Function`, ...) são
 *     neutralizados por shadowing léxico (ver `SHADOWED_GLOBALS`). `eval`
 *     indireto continua sendo vetor residual — isolamento real contra código
 *     hostil exige sandbox no nível do SO.
 *
 * Polyfills n8n: ver `code-shims.ts`.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;

interface WorkerOk {
  ok: true;
  result: unknown;
}
interface WorkerErr {
  ok: false;
  error: { message: string; name?: string; stack?: string };
}
type WorkerReply = WorkerOk | WorkerErr;

interface CodeJob {
  code: string;
  input: Record<string, unknown>;
  prev: Record<string, unknown>;
  vars: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  env: Record<string, string>;
}

/**
 * Roda um job de código num Worker efêmero e resolve com o retorno cru.
 * O Worker é sempre terminado (sucesso, erro OU timeout) — no timeout o
 * `terminate()` mata inclusive código síncrono travado. Spawn-por-execução:
 * um Worker terminado não é reutilizável, e a simplicidade vale mais que o
 * custo (~poucos ms) frente ao timeout de segundos do próprio nó.
 */
function runCodeInWorker(job: CodeJob, timeoutMs: number): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(new URL("./code-worker.ts", import.meta.url).href, {
      type: "module",
    });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`code: timeout após ${timeoutMs}ms`)));
    }, timeoutMs);

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply?.ok) {
        finish(() => resolve(reply.result));
      } else {
        const err = new Error(reply?.error?.message ?? "code: erro desconhecido no sandbox");
        err.name = reply?.error?.name ?? "Error";
        if (reply?.error?.stack) err.stack = reply.error.stack;
        finish(() => reject(err));
      }
    };

    worker.onerror = (event: ErrorEvent) => {
      finish(() => reject(new Error(`code: erro no sandbox — ${event.message || "desconhecido"}`)));
    };

    worker.postMessage(job);
  });
}

/**
 * Modela o retorno cru do sandbox no `output` do nó. Espelha a convenção n8n
 * `return [{ json: {...} }]` (unwrap) e envelopa não-objetos em `{ result }`.
 */
function shapeOutput(result: unknown): { output: Record<string, unknown> } {
  if (result === null || result === undefined) return { output: {} };
  if (typeof result === "object" && !Array.isArray(result)) {
    return { output: result as Record<string, unknown> };
  }
  // n8n convention: `return [{ json: {...} }]`. Quando vier nesse shape,
  // unwrap pra que `prev.X` resolva direto (em vez de `prev.result[0].json.X`).
  if (Array.isArray(result) && result.length > 0) {
    const first = result[0] as { json?: unknown } | null | undefined;
    if (first && typeof first === "object" && first.json && typeof first.json === "object") {
      if (result.length === 1) {
        return { output: first.json as Record<string, unknown> };
      }
      // Múltiplos items: expõe como `_items` E mantém shape do primeiro como prev.
      return {
        output: {
          ...(first.json as Record<string, unknown>),
          _items: result.map((r) => (r as { json: unknown }).json),
        },
      };
    }
  }
  return { output: { result } };
}

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

  const result = await runCodeInWorker(
    {
      code,
      input: context.input,
      prev: (context.prev ?? {}) as Record<string, unknown>,
      vars: context.vars,
      steps: context.steps,
      env: context.env,
    },
    timeoutMs,
  );

  return shapeOutput(result);
};
