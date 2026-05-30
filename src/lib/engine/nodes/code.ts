import type { NodeHandler } from "../types";

/**
 * Executa JavaScript arbitrário fornecido pelo usuário.
 *
 * Config:
 *   - code: string  — corpo da função; tem acesso a:
 *     • `input`, `vars`, `steps`, `env`         — sintaxe nativa adila
 *     • `$input`, `$json`, `$node`, `$vars`, `$env`,
 *       `$now`, `$today`, `$execution`, `$workflow`,
 *       `$prevNode`, `$items()`                — polyfills compatíveis com n8n
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
 *
 * Polyfills n8n (best-effort):
 *   - `$input.all() / .first() / .last() / .item.json` retornam o `input` global
 *     (não há items[] real; cada chamada vê o mesmo objeto envelopado).
 *   - `$json` é o `input` (item atual aproximado).
 *   - `$('NomeDoNo')` resolve via `nodeNameToId` injetado pelo importer em `vars._nodeNameToId`,
 *     caindo em `steps[id]` quando achar. Sem o mapa, devolve `{ json: {} }`.
 *   - `$now` / `$today` são `Date` (sem helpers Luxon).
 *   - `$execution` / `$workflow` expõem só `id` e `mode`/`name` quando disponíveis.
 */
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30_000;

type NodeNameMap = Record<string, string>;

function buildN8nShims(
  input: Record<string, unknown>,
  prev: Record<string, unknown>,
  vars: Record<string, unknown>,
  steps: Record<string, Record<string, unknown>>,
  env: Record<string, string>,
): Record<string, unknown> {
  const nameToId = (vars._nodeNameToId as NodeNameMap | undefined) ?? {};
  // Item atual fluindo entre nós = output do step anterior (`prev`), com
  // fallback pro input do run quando prev tá vazio (1º nó depois do trigger).
  const currentItem = prev && Object.keys(prev).length > 0 ? prev : input;
  const itemAsObj = { json: currentItem, binary: {} };
  const items = [itemAsObj];

  const $input = {
    all: () => items,
    first: () => itemAsObj,
    last: () => itemAsObj,
    item: itemAsObj,
    params: input,
  };

  const $items = () => items;

  const node = (name: string) => {
    const id = nameToId[name];
    const stepOut = id ? steps[id] : undefined;
    const data = stepOut && typeof stepOut === "object" ? (stepOut as Record<string, unknown>) : {};
    return {
      json: data,
      item: { json: data, binary: {} },
      all: () => [{ json: data, binary: {} }],
      first: () => ({ json: data, binary: {} }),
      last: () => ({ json: data, binary: {} }),
    };
  };

  const now = new Date();
  return {
    // `items` é shim só pra compat n8n. Se o user código declara `const items`
    // / `let items`, prefixar como param causa erro de redeclaração em strict
    // mode — quem chama o shim deve filtrar via detectUserDeclaredItems().
    items,
    $input,
    $items,
    $json: currentItem,
    $node: new Proxy(
      {},
      {
        get(_t, name) {
          if (typeof name !== "string") return undefined;
          return node(name);
        },
      },
    ),
    $: node,
    $vars: vars,
    $env: env,
    $now: now,
    $today: now,
    $execution: { id: env.RUN_ID ?? "", mode: "production" },
    $workflow: { id: env.WORKFLOW_ID ?? "", name: env.WORKFLOW_NAME ?? "" },
    $prevNode: { json: input },
  };
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

  const shims = buildN8nShims(
    context.input,
    (context.prev ?? {}) as Record<string, unknown>,
    context.vars,
    context.steps,
    context.env,
  );
  // Skip shims que colidem com declarações do usuário. Em strict mode,
  // `const items = ...` falha se `items` foi passado como param de função —
  // detectamos via regex e removemos o shim correspondente.
  const collidingNames = ["items", "$json", "$input", "$vars", "$env"];
  for (const n of collidingNames) {
    const re = new RegExp(`\\b(const|let|var)\\s+\\${n.startsWith("$") ? "" : ""}${n}\\b`);
    if (re.test(code)) delete shims[n];
  }
  const shimNames = Object.keys(shims);
  const shimValues = shimNames.map((k) => shims[k]);

  // Construído com `new Function` pra isolar do escopo léxico do worker.
  // Argumentos: 4 adila-nativos + N polyfills n8n (sempre na ordem de `shimNames`).
  type CodeFn = (
    input: Record<string, unknown>,
    vars: Record<string, unknown>,
    steps: Record<string, Record<string, unknown>>,
    env: Record<string, string>,
    ...shimArgs: unknown[]
  ) => unknown;
  // Args nativos adila prefixados com `__adila_` pra não colidir com `const input
  // = ...` ou `const vars = ...` que código n8n importado frequentemente declara.
  // Quem quiser usar via JS, acesse $input/$vars/$env/items que são polyfills shim.
  let fn: CodeFn;
  try {
    fn = new Function(
      "__adila_input",
      "__adila_vars",
      "__adila_steps",
      "__adila_env",
      ...shimNames,
      `"use strict";\n${code}`,
    ) as CodeFn;
  } catch (err) {
    throw new Error(`code: erro de sintaxe — ${(err as Error).message}`, { cause: err });
  }

  const exec = (async () =>
    fn(context.input, context.vars, context.steps, context.env, ...shimValues))();

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
    // n8n convention: `return [{ json: {...} }]`. Quando vier nesse shape,
    // unwrap pra que `prev.X` resolva direto (em vez de `prev.result[0].json.X`).
    if (Array.isArray(result) && result.length > 0) {
      const first = result[0] as { json?: unknown } | null | undefined;
      if (first && typeof first === "object" && first.json && typeof first.json === "object") {
        if (result.length === 1) {
          return { output: first.json as Record<string, unknown> };
        }
        // Múltiplos items: expõe como `items` E mantém shape do primeiro como prev.
        return {
          output: {
            ...(first.json as Record<string, unknown>),
            _items: result.map((r) => (r as { json: unknown }).json),
          },
        };
      }
    }
    return { output: { result } };
  } finally {
    if (timer) clearTimeout(timer);
  }
};
