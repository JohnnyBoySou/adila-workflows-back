/**
 * Polyfills n8n-compatíveis para o nó `code`, construídos a partir de dados
 * planos (input/prev/vars/steps/env). Vive num módulo separado porque roda
 * DENTRO do Worker de sandbox (`code-worker.ts`) — o handler principal só
 * repassa dados serializáveis pela fronteira do Worker; os shims (que contêm
 * funções e Proxies não-clonáveis) são reconstruídos aqui, no outro lado.
 *
 * Ver `code.ts` para o contrato completo dos globais expostos.
 */

type NodeNameMap = Record<string, string>;

export function buildN8nShims(
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
    // mode — quem chama o shim deve filtrar via detecção de declaração.
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

/**
 * Globais do host neutralizados no sandbox via *shadowing* por parâmetro —
 * bindados a `undefined` no escopo léxico do código do usuário. Fecha o acesso
 * casual a `process.env` (exfiltração de segredos) e o escape clássico via
 * `Function("return process")()`. Independe de o global ser configurável
 * (`Bun` não é deletável, mas o shadow por param funciona mesmo assim).
 *
 * NOTA: `eval` e `arguments` não podem ser nomes de parâmetro em strict mode,
 * então `eval` indireto `(0,eval)(...)` continua sendo um vetor residual — a
 * garantia forte é o isolamento de thread + kill por timeout do Worker, não a
 * remoção total de globais. Sandbox de verdade contra código hostil exige
 * isolamento no nível do SO (container/seccomp), fora do escopo aqui.
 */
export const SHADOWED_GLOBALS = [
  "process",
  "Bun",
  "require",
  "module",
  "global",
  "globalThis",
  "Function",
] as const;

/** Nomes de shim que colidem com declarações comuns de código importado. */
export const COLLIDING_SHIM_NAMES = ["items", "$json", "$input", "$vars", "$env"] as const;

/**
 * Nomes nativos adila expostos ao código do usuário (`input`, `vars`, ...).
 * Os valores chegam como parâmetros prefixados `__adila_*` (que nunca colidem
 * com declarações do usuário) e são aliasados pra esses nomes via preâmbulo.
 */
export const NATIVE_ARG_NAMES = ["input", "vars", "steps", "env"] as const;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True se o código do usuário declara `name` (const/let/var) no topo. */
function redeclaresName(code: string, name: string): boolean {
  return new RegExp(`\\b(?:const|let|var)\\s+${escapeRegExp(name)}\\b`).test(code);
}

/**
 * Preâmbulo que aliasa os parâmetros `__adila_*` pros nomes nativos
 * (`const input = __adila_input;`). Pula qualquer nome que o usuário redeclare
 * — assim `const input = [...]` no corpo não dispara "redeclaration" em strict
 * mode; nesse caso o usuário simplesmente não enxerga o input nativo (mesma
 * semântica de sombreamento do escopo léxico).
 */
export function buildNativePreamble(code: string): string {
  const lines: string[] = [];
  for (const name of NATIVE_ARG_NAMES) {
    if (!redeclaresName(code, name)) lines.push(`const ${name} = __adila_${name};`);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Remove do mapa de shims qualquer nome que o código do usuário redeclare
 * (`const items = ...`). Sem isso, passar `items` como parâmetro e depois
 * `const items` no corpo dispara "redeclaration" em strict mode.
 */
export function stripCollidingShims(
  shims: Record<string, unknown>,
  code: string,
): Record<string, unknown> {
  const out = { ...shims };
  for (const name of COLLIDING_SHIM_NAMES) {
    if (redeclaresName(code, name)) delete out[name];
  }
  return out;
}
