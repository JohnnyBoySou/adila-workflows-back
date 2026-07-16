import { describe, expect, test } from "bun:test";
import { compressionHandler } from "../src/lib/engine/nodes/compression";
import { cryptoHandler } from "../src/lib/engine/nodes/crypto-node";
import { ifHandler } from "../src/lib/engine/nodes/if";
import { jwtHandler } from "../src/lib/engine/nodes/jwt";
import { respondToWebhookHandler } from "../src/lib/engine/nodes/respond-to-webhook";
import { setVariableHandler } from "../src/lib/engine/nodes/set-variable";
import { stopAndErrorHandler } from "../src/lib/engine/nodes/stop-and-error";
import { switchHandler } from "../src/lib/engine/nodes/switch";
import { transformHandler } from "../src/lib/engine/nodes/transform";
import { chatTriggerHandler } from "../src/lib/engine/nodes/chat-trigger";
import { emailTriggerHandler } from "../src/lib/engine/nodes/email-trigger";
import { errorTriggerHandler } from "../src/lib/engine/nodes/error-trigger";
import { formTriggerHandler } from "../src/lib/engine/nodes/form-trigger";
import { intervalTriggerHandler } from "../src/lib/engine/nodes/interval-trigger";
import { manualTriggerHandler } from "../src/lib/engine/nodes/manual-trigger";
import { postgresTriggerHandler } from "../src/lib/engine/nodes/postgres-trigger";
import { redisTriggerHandler } from "../src/lib/engine/nodes/redis-trigger";
import { rssTriggerHandler } from "../src/lib/engine/nodes/rss-trigger";
import { scheduleTriggerHandler } from "../src/lib/engine/nodes/schedule-trigger";
import { webhookTriggerHandler } from "../src/lib/engine/nodes/webhook-trigger";
import { workflowCalledTriggerHandler } from "../src/lib/engine/nodes/workflow-called-trigger";
import { renderTemplate, resolvePath } from "../src/lib/engine/template";
import { extractTokenUsage } from "../src/lib/engine/token-usage";
import type { ExecutionContext, NodeType, WorkflowNode } from "../src/lib/engine/types";

/**
 * Testes dos nós de controle de fluxo (if / switch / transform / set_variable /
 * stop_and_error / respond_to_webhook), dos nós de crypto (crypto / jwt /
 * compression), dos triggers passthrough e dos utilitários centrais do motor
 * (template.ts e token-usage.ts).
 *
 * Nenhum deles precisa de DB: os handlers são invocados diretamente com um
 * ExecutionContext montado à mão, seguindo o padrão de `code-node.test.ts`.
 *
 * Os testes descrevem o comportamento REAL do código hoje — inclusive quirks
 * que provavelmente são bugs (marcados com `QUIRK:` no comentário).
 */

function ctx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    input: {},
    vars: {},
    env: {},
    steps: {},
    prev: {},
    ...overrides,
  };
}

function node(type: NodeType, config: Record<string, unknown>): WorkflowNode {
  return { id: "n1", type, config };
}

// ---------------------------------------------------------------------------
// template.ts — utilitário central de interpolação
// ---------------------------------------------------------------------------

describe("template — resolvePath", () => {
  test("navega notação ponto simples", () => {
    expect(resolvePath({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
  });

  test("navega índices numéricos em arrays", () => {
    expect(resolvePath({ lista: [{ nome: "ada" }, { nome: "bob" }] }, "lista.1.nome")).toBe("bob");
  });

  test("aceita colchetes com aspas simples", () => {
    expect(resolvePath({ dados: { "chave com espaço": 7 } }, "dados['chave com espaço']")).toBe(7);
  });

  test("aceita colchetes com aspas duplas", () => {
    expect(resolvePath({ dados: { "a-b": "x" } }, 'dados["a-b"]')).toBe("x");
  });

  test("aceita colchetes sem aspas (índice cru)", () => {
    expect(resolvePath({ lista: ["zero", "um"] }, "lista[1]")).toBe("um");
  });

  test("mistura colchetes e ponto", () => {
    expect(resolvePath({ a: { "k k": { b: 1 } } }, "a['k k'].b")).toBe(1);
  });

  test("path inexistente devolve undefined", () => {
    expect(resolvePath({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  test("atravessar primitivo devolve undefined em vez de lançar", () => {
    expect(resolvePath({ a: 5 }, "a.b")).toBeUndefined();
  });

  test("obj null devolve undefined", () => {
    expect(resolvePath(null, "a")).toBeUndefined();
  });

  test("path vazio devolve o próprio objeto", () => {
    const obj = { a: 1 };
    expect(resolvePath(obj, "")).toBe(obj);
  });

  test("colchete não fechado interrompe a tokenização (tokens já lidos valem)", () => {
    // `a[b` → token "a" é lido, o `[` sem `]` faz o loop parar.
    expect(resolvePath({ a: { b: 1 } }, "a[b")).toEqual({ b: 1 });
  });

  test("acessa chaves de array por propriedade (length)", () => {
    expect(resolvePath({ xs: [1, 2, 3] }, "xs.length")).toBe(3);
  });
});

describe("template — renderTemplate", () => {
  test("template puro devolve o valor cru preservando tipo (número)", () => {
    const out = renderTemplate("{{ input.n }}", ctx({ input: { n: 42 } }));
    expect(out).toBe(42);
  });

  test("template puro devolve objeto cru (não stringifica)", () => {
    const obj = { a: 1 };
    const out = renderTemplate("{{ input.obj }}", ctx({ input: { obj } }));
    expect(out).toEqual(obj);
  });

  test("template puro tolera espaços internos", () => {
    expect(renderTemplate("{{input.n}}", ctx({ input: { n: 1 } }))).toBe(1);
    expect(renderTemplate("{{   input.n   }}", ctx({ input: { n: 1 } }))).toBe(1);
  });

  test("template embutido em texto interpola como string", () => {
    const out = renderTemplate("olá {{ input.nome }}!", ctx({ input: { nome: "ada" } }));
    expect(out).toBe("olá ada!");
  });

  test("múltiplos templates na mesma string", () => {
    const out = renderTemplate("{{ input.a }}-{{ input.b }}", ctx({ input: { a: 1, b: 2 } }));
    expect(out).toBe("1-2");
  });

  test("valor não resolvido vira string vazia na interpolação", () => {
    expect(renderTemplate("x={{ input.faltando }}", ctx())).toBe("x=");
  });

  test("null resolvido vira string vazia na interpolação", () => {
    expect(renderTemplate("x={{ input.n }}", ctx({ input: { n: null } }))).toBe("x=");
  });

  test("objeto interpolado em texto é JSON.stringify", () => {
    const out = renderTemplate("obj={{ input.o }}", ctx({ input: { o: { a: 1 } } }));
    expect(out).toBe('obj={"a":1}');
  });

  test("template puro não resolvido devolve undefined", () => {
    expect(renderTemplate("{{ input.nada }}", ctx())).toBeUndefined();
  });

  test("string sem template passa direto", () => {
    expect(renderTemplate("texto puro", ctx())).toBe("texto puro");
  });

  test("recursão em arrays", () => {
    const out = renderTemplate(["{{ input.a }}", "lit"], ctx({ input: { a: 1 } }));
    expect(out).toEqual([1, "lit"]);
  });

  test("recursão em objetos aninhados", () => {
    const out = renderTemplate(
      { x: "{{ input.a }}", nested: { y: "{{ input.b }}" } },
      ctx({ input: { a: 1, b: "dois" } }),
    );
    expect(out).toEqual({ x: 1, nested: { y: "dois" } });
  });

  test("não-strings passam direto (número, boolean, null)", () => {
    const c = ctx();
    expect(renderTemplate(7, c)).toBe(7);
    expect(renderTemplate(true, c)).toBe(true);
    expect(renderTemplate(null, c)).toBeNull();
    expect(renderTemplate(undefined, c)).toBeUndefined();
  });

  test("resolve prefixo env", () => {
    expect(renderTemplate("{{ env.API_KEY }}", ctx({ env: { API_KEY: "k1" } }))).toBe("k1");
  });

  test("resolve prefixo steps por id de nó", () => {
    const c = ctx({ steps: { "node-1": { text: "oi" } } });
    expect(renderTemplate("{{ steps.node-1.text }}", c)).toBe("oi");
  });

  test("resolve prefixo prev", () => {
    expect(renderTemplate("{{ prev.v }}", ctx({ prev: { v: 9 } }))).toBe(9);
  });

  test("resolve prefixo vars", () => {
    expect(renderTemplate("{{ vars.c }}", ctx({ vars: { c: "z" } }))).toBe("z");
  });
});

describe("template — aliases n8n e fallback cross-prefix", () => {
  test("$json.X é reescrito para prev.X", () => {
    expect(renderTemplate("{{ $json.v }}", ctx({ prev: { v: "do prev" } }))).toBe("do prev");
  });

  test("$json['X'] é reescrito para prev['X']", () => {
    expect(renderTemplate("{{ $json['a b'] }}", ctx({ prev: { "a b": 3 } }))).toBe(3);
  });

  test("prev.X undefined cai para input.X", () => {
    expect(renderTemplate("{{ prev.v }}", ctx({ prev: {}, input: { v: "do input" } }))).toBe(
      "do input",
    );
  });

  test("prev.X undefined cai para vars.X quando input também não tem", () => {
    expect(renderTemplate("{{ prev.v }}", ctx({ prev: {}, vars: { v: "do vars" } }))).toBe(
      "do vars",
    );
  });

  test("input.X undefined cai para prev.X", () => {
    expect(renderTemplate("{{ input.v }}", ctx({ prev: { v: "do prev" } }))).toBe("do prev");
  });

  test("input.X undefined cai para vars.X", () => {
    expect(renderTemplate("{{ input.v }}", ctx({ vars: { v: "do vars" } }))).toBe("do vars");
  });

  test("prev tem prioridade sobre o fallback de input", () => {
    const c = ctx({ prev: { v: "prev" }, input: { v: "input" } });
    expect(renderTemplate("{{ prev.v }}", c)).toBe("prev");
  });

  test("fallback com colchetes (prev['k'] → input['k'])", () => {
    expect(renderTemplate("{{ prev['k k'] }}", ctx({ prev: {}, input: { "k k": 5 } }))).toBe(5);
  });

  test("vars.X sem fallback cross-prefix (não vira prev/input)", () => {
    // `vars.` não está na lista de PREFIXES do crossPrefixes, então não há fallback.
    expect(renderTemplate("{{ vars.v }}", ctx({ prev: { v: 1 }, input: { v: 2 } }))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// if — cobertura de todos os operadores
// ---------------------------------------------------------------------------

async function runIf(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return ifHandler({ node: node("if", config), context });
}

/** Atalho: só o nextLabel do if. */
async function ifLabel(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return (await runIf(config, context)).nextLabel;
}

describe("if — operadores de igualdade", () => {
  test("eq verdadeiro devolve nextLabel true", async () => {
    expect(await ifLabel({ left: "a", op: "eq", right: "a" })).toBe("true");
  });

  test("eq falso devolve nextLabel false", async () => {
    expect(await ifLabel({ left: "a", op: "eq", right: "b" })).toBe("false");
  });

  test("eq coage para string por inferência (1 === '1')", async () => {
    expect(await ifLabel({ left: 1, op: "eq", right: "1" })).toBe("true");
  });

  test("eq com dataType number compara numericamente", async () => {
    expect(await ifLabel({ left: "10", op: "eq", right: 10, dataType: "number" })).toBe("true");
  });

  test("eq com dataType boolean coage string 'true'", async () => {
    expect(await ifLabel({ left: "true", op: "eq", right: true, dataType: "boolean" })).toBe("true");
  });

  test("neq verdadeiro", async () => {
    expect(await ifLabel({ left: "a", op: "neq", right: "b" })).toBe("true");
  });

  test("neq falso após coerção string", async () => {
    expect(await ifLabel({ left: 1, op: "neq", right: "1" })).toBe("false");
  });
});

describe("if — operadores unários de verdade", () => {
  test("truthy com valor preenchido", async () => {
    expect(await ifLabel({ left: "x", op: "truthy" })).toBe("true");
  });

  test("truthy com string vazia é false", async () => {
    expect(await ifLabel({ left: "", op: "truthy" })).toBe("false");
  });

  test("truthy usa o valor CRU, não o coagido: string 'false' é truthy", async () => {
    // QUIRK: inferDataType("truthy") === "boolean", mas evaluate faz Boolean(left)
    // no valor original — então "false" (string não-vazia) é verdadeiro.
    expect(await ifLabel({ left: "false", op: "truthy" })).toBe("true");
  });

  test("falsy com 0", async () => {
    expect(await ifLabel({ left: 0, op: "falsy" })).toBe("true");
  });

  test("falsy com valor preenchido", async () => {
    expect(await ifLabel({ left: "x", op: "falsy" })).toBe("false");
  });

  test("isTrue com boolean true", async () => {
    expect(await ifLabel({ left: true, op: "isTrue" })).toBe("true");
  });

  test("isTrue aceita string 'TRUE' (case-insensitive)", async () => {
    expect(await ifLabel({ left: "TRUE", op: "isTrue" })).toBe("true");
  });

  test("isTrue com false é false", async () => {
    expect(await ifLabel({ left: false, op: "isTrue" })).toBe("false");
  });

  test("isFalse com boolean false", async () => {
    expect(await ifLabel({ left: false, op: "isFalse" })).toBe("true");
  });

  test("isFalse aceita string 'false'", async () => {
    expect(await ifLabel({ left: "false", op: "isFalse" })).toBe("true");
  });

  test("isFalse com true é false", async () => {
    expect(await ifLabel({ left: true, op: "isFalse" })).toBe("false");
  });
});

describe("if — operadores numéricos", () => {
  test("gt verdadeiro", async () => {
    expect(await ifLabel({ left: 5, op: "gt", right: 3 })).toBe("true");
  });

  test("gt compara numericamente mesmo com strings ('10' > '9')", async () => {
    expect(await ifLabel({ left: "10", op: "gt", right: "9" })).toBe("true");
  });

  test("gt falso quando igual", async () => {
    expect(await ifLabel({ left: 3, op: "gt", right: 3 })).toBe("false");
  });

  test("gte com valores iguais", async () => {
    expect(await ifLabel({ left: 3, op: "gte", right: 3 })).toBe("true");
  });

  test("gte falso quando menor", async () => {
    expect(await ifLabel({ left: 2, op: "gte", right: 3 })).toBe("false");
  });

  test("lt verdadeiro", async () => {
    expect(await ifLabel({ left: 2, op: "lt", right: 3 })).toBe("true");
  });

  test("lt falso quando igual", async () => {
    expect(await ifLabel({ left: 3, op: "lt", right: 3 })).toBe("false");
  });

  test("lte com valores iguais", async () => {
    expect(await ifLabel({ left: 3, op: "lte", right: 3 })).toBe("true");
  });

  test("lte falso quando maior", async () => {
    expect(await ifLabel({ left: 4, op: "lte", right: 3 })).toBe("false");
  });

  test("gt com valor não-numérico é false (NaN)", async () => {
    expect(await ifLabel({ left: "abc", op: "gt", right: 1 })).toBe("false");
  });
});

describe("if — operadores de string", () => {
  test("contains em string", async () => {
    expect(await ifLabel({ left: "hello world", op: "contains", right: "world" })).toBe("true");
  });

  test("contains falso em string", async () => {
    expect(await ifLabel({ left: "hello", op: "contains", right: "xyz" })).toBe("false");
  });

  test("contains em array com dataType array compara sem coerção", async () => {
    expect(await ifLabel({ left: [1, 2, 3], op: "contains", right: 2, dataType: "array" })).toBe(
      "true",
    );
  });

  test("contains em array com dataType string (default) falha por coerção do right", async () => {
    // QUIRK: `contains` testa `left.includes(rc)` — rc já foi coagido a string
    // "2" pelo dataType inferido "string", então nunca casa com o número 2.
    expect(await ifLabel({ left: [1, 2, 3], op: "contains", right: 2 })).toBe("false");
  });

  test("contains em tipo não string/array devolve false", async () => {
    expect(await ifLabel({ left: 42, op: "contains", right: "4" })).toBe("false");
  });

  test("ncontains em string", async () => {
    expect(await ifLabel({ left: "hello", op: "ncontains", right: "xyz" })).toBe("true");
  });

  test("ncontains em array com dataType array", async () => {
    expect(await ifLabel({ left: [1, 2], op: "ncontains", right: 9, dataType: "array" })).toBe(
      "true",
    );
  });

  test("ncontains em tipo não string/array devolve true", async () => {
    expect(await ifLabel({ left: 42, op: "ncontains", right: "4" })).toBe("true");
  });

  test("startsWith verdadeiro", async () => {
    expect(await ifLabel({ left: "adila", op: "startsWith", right: "adi" })).toBe("true");
  });

  test("startsWith falso", async () => {
    expect(await ifLabel({ left: "adila", op: "startsWith", right: "xx" })).toBe("false");
  });

  test("nstartsWith verdadeiro", async () => {
    expect(await ifLabel({ left: "adila", op: "nstartsWith", right: "xx" })).toBe("true");
  });

  test("nstartsWith falso", async () => {
    expect(await ifLabel({ left: "adila", op: "nstartsWith", right: "adi" })).toBe("false");
  });

  test("endsWith verdadeiro", async () => {
    expect(await ifLabel({ left: "arquivo.pdf", op: "endsWith", right: ".pdf" })).toBe("true");
  });

  test("endsWith falso", async () => {
    expect(await ifLabel({ left: "arquivo.pdf", op: "endsWith", right: ".txt" })).toBe("false");
  });

  test("nendsWith verdadeiro", async () => {
    expect(await ifLabel({ left: "arquivo.pdf", op: "nendsWith", right: ".txt" })).toBe("true");
  });

  test("nendsWith falso", async () => {
    expect(await ifLabel({ left: "arquivo.pdf", op: "nendsWith", right: ".pdf" })).toBe("false");
  });

  test("regex casando", async () => {
    expect(await ifLabel({ left: "abc123", op: "regex", right: "\\d+$" })).toBe("true");
  });

  test("regex não casando", async () => {
    expect(await ifLabel({ left: "abc", op: "regex", right: "^\\d" })).toBe("false");
  });

  test("regex inválido devolve false em vez de lançar", async () => {
    expect(await ifLabel({ left: "abc", op: "regex", right: "[" })).toBe("false");
  });

  test("nregex verdadeiro quando não casa", async () => {
    expect(await ifLabel({ left: "abc", op: "nregex", right: "^\\d" })).toBe("true");
  });

  test("nregex falso quando casa", async () => {
    expect(await ifLabel({ left: "abc123", op: "nregex", right: "\\d+" })).toBe("false");
  });

  test("nregex inválido devolve true em vez de lançar", async () => {
    expect(await ifLabel({ left: "abc", op: "nregex", right: "[" })).toBe("true");
  });
});

describe("if — operadores de presença", () => {
  test("isEmpty com string vazia", async () => {
    expect(await ifLabel({ left: "", op: "isEmpty" })).toBe("true");
  });

  test("isEmpty com array vazio", async () => {
    expect(await ifLabel({ left: [], op: "isEmpty" })).toBe("true");
  });

  test("isEmpty com objeto vazio", async () => {
    expect(await ifLabel({ left: {}, op: "isEmpty" })).toBe("true");
  });

  test("isEmpty com null", async () => {
    expect(await ifLabel({ left: null, op: "isEmpty" })).toBe("true");
  });

  test("isEmpty com número 0 é false (0 não é 'vazio')", async () => {
    expect(await ifLabel({ left: 0, op: "isEmpty" })).toBe("false");
  });

  test("isEmpty NÃO faz trim: string com espaços não é vazia", async () => {
    expect(await ifLabel({ left: "   ", op: "isEmpty" })).toBe("false");
  });

  test("isNotEmpty com conteúdo", async () => {
    expect(await ifLabel({ left: "x", op: "isNotEmpty" })).toBe("true");
  });

  test("isNotEmpty com array vazio é false", async () => {
    expect(await ifLabel({ left: [], op: "isNotEmpty" })).toBe("false");
  });

  test("exists com 0 é true (existe)", async () => {
    expect(await ifLabel({ left: 0, op: "exists" })).toBe("true");
  });

  test("exists com null é false", async () => {
    expect(await ifLabel({ left: null, op: "exists" })).toBe("false");
  });

  test("exists com chave ausente é false", async () => {
    expect(await ifLabel({ op: "exists" })).toBe("false");
  });

  test("notExists com null é true", async () => {
    expect(await ifLabel({ left: null, op: "notExists" })).toBe("true");
  });

  test("notExists com valor é false", async () => {
    expect(await ifLabel({ left: "x", op: "notExists" })).toBe("false");
  });
});

describe("if — operadores de data", () => {
  test("isAfter verdadeiro", async () => {
    expect(await ifLabel({ left: "2024-01-02", op: "isAfter", right: "2024-01-01" })).toBe("true");
  });

  test("isAfter falso quando igual", async () => {
    expect(await ifLabel({ left: "2024-01-01", op: "isAfter", right: "2024-01-01" })).toBe("false");
  });

  test("isAfter com data inválida devolve false", async () => {
    expect(await ifLabel({ left: "não-é-data", op: "isAfter", right: "2024-01-01" })).toBe("false");
  });

  test("isBefore verdadeiro", async () => {
    expect(await ifLabel({ left: "2024-01-01", op: "isBefore", right: "2024-01-02" })).toBe("true");
  });

  test("isBefore falso quando depois", async () => {
    expect(await ifLabel({ left: "2024-01-03", op: "isBefore", right: "2024-01-02" })).toBe("false");
  });

  test("isAfterOrEqual verdadeiro quando igual", async () => {
    expect(await ifLabel({ left: "2024-01-01", op: "isAfterOrEqual", right: "2024-01-01" })).toBe(
      "true",
    );
  });

  test("isAfterOrEqual falso quando antes", async () => {
    expect(await ifLabel({ left: "2023-12-31", op: "isAfterOrEqual", right: "2024-01-01" })).toBe(
      "false",
    );
  });

  test("isBeforeOrEqual verdadeiro quando igual", async () => {
    expect(await ifLabel({ left: "2024-01-01", op: "isBeforeOrEqual", right: "2024-01-01" })).toBe(
      "true",
    );
  });

  test("isBeforeOrEqual falso quando depois", async () => {
    expect(await ifLabel({ left: "2024-01-02", op: "isBeforeOrEqual", right: "2024-01-01" })).toBe(
      "false",
    );
  });

  test("isBeforeOrEqual com data inválida devolve false", async () => {
    expect(await ifLabel({ left: "2024-01-01", op: "isBeforeOrEqual", right: "xx" })).toBe("false");
  });
});

describe("if — operadores de tamanho", () => {
  test("lenEq com array", async () => {
    expect(await ifLabel({ left: [1, 2, 3], op: "lenEq", right: 3 })).toBe("true");
  });

  test("lenEq com string usa o comprimento", async () => {
    expect(await ifLabel({ left: "abc", op: "lenEq", right: 3 })).toBe("true");
  });

  test("lenEq com objeto usa a quantidade de chaves", async () => {
    expect(await ifLabel({ left: { a: 1, b: 2 }, op: "lenEq", right: 2 })).toBe("true");
  });

  test("lenEq com tipo sem tamanho conta 0", async () => {
    expect(await ifLabel({ left: 42, op: "lenEq", right: 0 })).toBe("true");
  });

  test("lenNeq verdadeiro", async () => {
    expect(await ifLabel({ left: [1], op: "lenNeq", right: 3 })).toBe("true");
  });

  test("lenNeq falso", async () => {
    expect(await ifLabel({ left: [1, 2, 3], op: "lenNeq", right: 3 })).toBe("false");
  });

  test("lenGt verdadeiro", async () => {
    expect(await ifLabel({ left: [1, 2, 3], op: "lenGt", right: 2 })).toBe("true");
  });

  test("lenGt falso quando igual", async () => {
    expect(await ifLabel({ left: [1, 2], op: "lenGt", right: 2 })).toBe("false");
  });

  test("lenGte verdadeiro quando igual", async () => {
    expect(await ifLabel({ left: [1, 2], op: "lenGte", right: 2 })).toBe("true");
  });

  test("lenGte falso quando menor", async () => {
    expect(await ifLabel({ left: [1], op: "lenGte", right: 2 })).toBe("false");
  });

  test("lenLt verdadeiro", async () => {
    expect(await ifLabel({ left: [1], op: "lenLt", right: 2 })).toBe("true");
  });

  test("lenLt falso quando igual", async () => {
    expect(await ifLabel({ left: [1, 2], op: "lenLt", right: 2 })).toBe("false");
  });

  test("lenLte verdadeiro quando igual", async () => {
    expect(await ifLabel({ left: [1, 2], op: "lenLte", right: 2 })).toBe("true");
  });

  test("lenLte falso quando maior", async () => {
    expect(await ifLabel({ left: [1, 2, 3], op: "lenLte", right: 2 })).toBe("false");
  });
});

describe("if — comportamento do handler", () => {
  test("op ausente cai para truthy", async () => {
    expect(await ifLabel({ left: "x" })).toBe("true");
    expect(await ifLabel({ left: "" })).toBe("false");
  });

  test("operador desconhecido lança", async () => {
    await expect(runIf({ left: 1, op: "quemsabe", right: 1 })).rejects.toThrow(
      /operador "quemsabe" não suportado/,
    );
  });

  test("output propaga o item de prev e anexa metadata em _if", async () => {
    const res = await runIf({ left: "a", op: "eq", right: "a" }, ctx({ prev: { pedido: 7 } }));
    expect(res.output.pedido).toBe(7);
    expect(res.output._if).toEqual({
      left: "a",
      op: "eq",
      right: "a",
      dataType: "string",
      result: true,
    });
  });

  test("sem prev o output só tem _if", async () => {
    const res = await ifHandler({
      node: node("if", { left: 1, op: "truthy" }),
      context: { input: {}, vars: {}, env: {}, steps: {} },
    });
    expect(Object.keys(res.output)).toEqual(["_if"]);
  });

  test("left e right são templatáveis", async () => {
    const res = await runIf(
      { left: "{{ input.a }}", op: "eq", right: "{{ vars.b }}" },
      ctx({ input: { a: 5 }, vars: { b: 5 } }),
    );
    expect(res.nextLabel).toBe("true");
    expect((res.output._if as Record<string, unknown>).left).toBe(5);
  });

  test("dataType explícito sobrescreve a inferência do operador", async () => {
    // "eq" inferiria "string"; forçando number, "1.0" e 1 passam a ser iguais.
    expect(await ifLabel({ left: "1.0", op: "eq", right: 1 })).toBe("false");
    expect(await ifLabel({ left: "1.0", op: "eq", right: 1, dataType: "number" })).toBe("true");
  });

  test("coerce string trata null como string vazia", async () => {
    expect(await ifLabel({ left: null, op: "eq", right: "" })).toBe("true");
  });
});

// ---------------------------------------------------------------------------
// switch
// ---------------------------------------------------------------------------

async function runSwitch(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return switchHandler({ node: node("switch", config), context });
}

function rule(over: Record<string, unknown>) {
  return { left: "a", op: "eq", right: "a", dataType: "string", label: "L", ...over };
}

describe("switch — formato novo (rules) por operador", () => {
  test("eq casa e devolve o label da regra", async () => {
    const res = await runSwitch({ rules: [rule({ left: "x", right: "x", label: "casou" })] });
    expect(res.nextLabel).toBe("casou");
  });

  test("eq não casa e cai no default", async () => {
    const res = await runSwitch({ rules: [rule({ left: "x", right: "y" })] });
    expect(res.nextLabel).toBe("default");
  });

  test("neq", async () => {
    const res = await runSwitch({ rules: [rule({ op: "neq", left: "x", right: "y" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("gt com dataType number", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "gt", left: 10, right: 3, dataType: "number" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("gt falso", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "gt", left: 1, right: 3, dataType: "number" })],
    });
    expect(res.nextLabel).toBe("default");
  });

  test("gte quando igual", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "gte", left: 3, right: 3, dataType: "number" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("lt", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "lt", left: 1, right: 3, dataType: "number" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("lte quando igual", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "lte", left: 3, right: 3, dataType: "number" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("contains", async () => {
    const res = await runSwitch({ rules: [rule({ op: "contains", left: "olá mundo", right: "mundo" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("ncontains", async () => {
    const res = await runSwitch({ rules: [rule({ op: "ncontains", left: "olá", right: "xyz" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("startsWith", async () => {
    const res = await runSwitch({ rules: [rule({ op: "startsWith", left: "adila", right: "adi" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("endsWith", async () => {
    const res = await runSwitch({ rules: [rule({ op: "endsWith", left: "a.pdf", right: ".pdf" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("regex casando", async () => {
    const res = await runSwitch({ rules: [rule({ op: "regex", left: "abc1", right: "\\d$" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("regex inválido devolve false (cai no default)", async () => {
    const res = await runSwitch({ rules: [rule({ op: "regex", left: "abc", right: "[" })] });
    expect(res.nextLabel).toBe("default");
  });

  test("isEmpty (unário, avaliado antes da coerção)", async () => {
    const res = await runSwitch({ rules: [rule({ op: "isEmpty", left: "" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("isEmpty FAZ trim (diferente do if)", async () => {
    const res = await runSwitch({ rules: [rule({ op: "isEmpty", left: "   " })] });
    expect(res.nextLabel).toBe("L");
  });

  test("isEmpty com array vazio e objeto vazio", async () => {
    expect((await runSwitch({ rules: [rule({ op: "isEmpty", left: [] })] })).nextLabel).toBe("L");
    expect((await runSwitch({ rules: [rule({ op: "isEmpty", left: {} })] })).nextLabel).toBe("L");
  });

  test("notEmpty", async () => {
    const res = await runSwitch({ rules: [rule({ op: "notEmpty", left: "x" })] });
    expect(res.nextLabel).toBe("L");
  });

  test("notEmpty falso com null", async () => {
    const res = await runSwitch({ rules: [rule({ op: "notEmpty", left: null })] });
    expect(res.nextLabel).toBe("default");
  });

  test("operador desconhecido não lança — devolve false e cai no default", async () => {
    const res = await runSwitch({ rules: [rule({ op: "inventado" })] });
    expect(res.nextLabel).toBe("default");
  });
});

describe("switch — coerção por dataType", () => {
  test("boolean coage string 'True' com espaços", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "eq", left: "  True ", right: true, dataType: "boolean" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("dateTime compara timestamps de strings ISO", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "gt", left: "2024-01-02", right: "2024-01-01", dataType: "dateTime" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("dateTime com número passa direto (timestamp)", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "eq", left: 1000, right: 1000, dataType: "dateTime" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("dateTime inválido vira null e não casa em gt", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "gt", left: "xx", right: "2024-01-01", dataType: "dateTime" })],
    });
    expect(res.nextLabel).toBe("default");
  });

  test("dataType desconhecido cai para string", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "eq", left: 5, right: "5", dataType: "vodka" })],
    });
    expect(res.nextLabel).toBe("L");
  });

  test("QUIRK: dataType number com AMBOS não-numéricos casa em eq (null === null)", async () => {
    // coerce() devolve null quando Number(v) é NaN, então dois valores inválidos
    // e distintos ("abc" e "xyz") são considerados iguais.
    const res = await runSwitch({
      rules: [rule({ op: "eq", left: "abc", right: "xyz", dataType: "number" })],
    });
    expect(res.nextLabel).toBe("L");
  });
});

describe("switch — seleção de regra e defaults", () => {
  test("primeira regra verdadeira vence", async () => {
    const res = await runSwitch({
      rules: [
        rule({ op: "eq", left: "a", right: "z", label: "primeira" }),
        rule({ op: "eq", left: "a", right: "a", label: "segunda" }),
        rule({ op: "eq", left: "a", right: "a", label: "terceira" }),
      ],
    });
    expect(res.nextLabel).toBe("segunda");
  });

  test("output da regra que casou traz metadata", async () => {
    const res = await runSwitch({
      rules: [rule({ op: "eq", left: "a", right: "a", label: "ok" })],
    });
    expect(res.output).toEqual({
      matched: "ok",
      op: "eq",
      dataType: "string",
      left: "a",
      right: "a",
    });
  });

  test("nenhuma regra casa: output sinaliza no_rule_matched", async () => {
    const res = await runSwitch({ rules: [rule({ right: "z" })], default: "outros" });
    expect(res.nextLabel).toBe("outros");
    expect(res.output).toEqual({ matched: "outros", reason: "no_rule_matched" });
  });

  test("default vazio cai para 'default'", async () => {
    const res = await runSwitch({ rules: [rule({ right: "z" })], default: "" });
    expect(res.nextLabel).toBe("default");
  });

  test("regras sem label são descartadas (isRule)", async () => {
    // Sem regra válida, cai no caminho legado — que sem `cases` devolve o default.
    const res = await runSwitch({ rules: [{ left: "a", op: "eq", right: "a" }], default: "fb" });
    expect(res.nextLabel).toBe("fb");
    expect(res.output).toEqual({ value: undefined, matched: "fb" });
  });

  test("rules não-array é ignorado", async () => {
    const res = await runSwitch({ rules: "nada" });
    expect(res.nextLabel).toBe("default");
  });

  test("left/right são templatáveis", async () => {
    const res = await runSwitch(
      { rules: [rule({ left: "{{ input.tipo }}", right: "premium", label: "vip" })] },
      ctx({ input: { tipo: "premium" } }),
    );
    expect(res.nextLabel).toBe("vip");
  });
});

describe("switch — formato legado (value/cases)", () => {
  test("case casando por igualdade estrita", async () => {
    const res = await runSwitch({
      value: "b",
      cases: [
        { match: "a", label: "A" },
        { match: "b", label: "B" },
      ],
    });
    expect(res.nextLabel).toBe("B");
    expect(res.output).toEqual({ value: "b", matched: "B" });
  });

  test("igualdade é estrita: 5 não casa com '5'", async () => {
    const res = await runSwitch({ value: 5, cases: [{ match: "5", label: "S" }] });
    expect(res.nextLabel).toBe("default");
  });

  test("nenhum case casa devolve o default configurado", async () => {
    const res = await runSwitch({
      value: "z",
      cases: [{ match: "a", label: "A" }],
      default: "resto",
    });
    expect(res.nextLabel).toBe("resto");
    expect(res.output).toEqual({ value: "z", matched: "resto" });
  });

  test("cases sem label são descartados", async () => {
    const res = await runSwitch({ value: "a", cases: [{ match: "a" }] });
    expect(res.nextLabel).toBe("default");
  });

  test("value é templatável", async () => {
    const res = await runSwitch(
      { value: "{{ input.v }}", cases: [{ match: "ok", label: "OK" }] },
      ctx({ input: { v: "ok" } }),
    );
    expect(res.nextLabel).toBe("OK");
  });
});

// ---------------------------------------------------------------------------
// transform
// ---------------------------------------------------------------------------

async function runTransform(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return transformHandler({ node: node("transform", config), context });
}

describe("transform — mode object", () => {
  test("resolve paths do contexto (default mode = object)", async () => {
    const res = await runTransform(
      { mapping: { id: "input.user.id", nome: "input.user.name" } },
      ctx({ input: { user: { id: 1, name: "ada" } } }),
    );
    expect(res.output).toEqual({ id: 1, nome: "ada" });
  });

  test("resolve paths de vars, env e steps", async () => {
    const res = await runTransform(
      { mode: "object", mapping: { v: "vars.a", e: "env.K", s: "steps.n0.total" } },
      ctx({ vars: { a: 1 }, env: { K: "k" }, steps: { n0: { total: 9 } } }),
    );
    expect(res.output).toEqual({ v: 1, e: "k", s: 9 });
  });

  test("path inexistente vira undefined", async () => {
    const res = await runTransform({ mapping: { x: "input.nada.aqui" } });
    expect(res.output).toEqual({ x: undefined });
  });

  test("valor não-path passa por renderTemplate", async () => {
    const res = await runTransform(
      { mapping: { saudacao: "olá {{ input.nome }}" } },
      ctx({ input: { nome: "ada" } }),
    );
    expect(res.output).toEqual({ saudacao: "olá ada" });
  });

  test("string literal sem prefixo conhecido passa direto", async () => {
    const res = await runTransform({ mapping: { fixo: "constante" } });
    expect(res.output).toEqual({ fixo: "constante" });
  });

  test("valores não-string são renderizados recursivamente", async () => {
    const res = await runTransform(
      { mapping: { n: 7, obj: { k: "{{ input.a }}" }, arr: ["{{ input.a }}"] } },
      ctx({ input: { a: "A" } }),
    );
    expect(res.output).toEqual({ n: 7, obj: { k: "A" }, arr: ["A"] });
  });

  test("path com espaço não é tratado como path (vira template)", async () => {
    const res = await runTransform({ mapping: { x: "input.a b" } });
    expect(res.output).toEqual({ x: "input.a b" });
  });

  test("`prev.` NÃO é prefixo de path — precisa de {{ }}", async () => {
    const literal = await runTransform({ mapping: { x: "prev.v" } }, ctx({ prev: { v: 1 } }));
    expect(literal.output).toEqual({ x: "prev.v" });
    const template = await runTransform({ mapping: { x: "{{ prev.v }}" } }, ctx({ prev: { v: 1 } }));
    expect(template.output).toEqual({ x: 1 });
  });

  test("QUIRK: qualquer string começando com 'it' vira path (prefixo 'it' sem ponto)", async () => {
    // "items" começa com "it", então é resolvido como path no scope → undefined.
    const res = await runTransform({ mapping: { x: "items" } }, ctx({ input: { items: [1] } }));
    expect(res.output).toEqual({ x: undefined });
  });

  test("include_source anexa o input original em _source", async () => {
    const res = await runTransform(
      { mapping: { id: "input.id" }, include_source: true },
      ctx({ input: { id: 1, extra: "e" } }),
    );
    expect(res.output).toEqual({ id: 1, _source: { id: 1, extra: "e" } });
  });

  test("sem include_source não há _source", async () => {
    const res = await runTransform({ mapping: { id: "input.id" } }, ctx({ input: { id: 1 } }));
    expect(res.output._source).toBeUndefined();
  });
});

describe("transform — mode array", () => {
  test("mapeia cada item via `it`", async () => {
    const res = await runTransform(
      {
        mode: "array",
        source: "{{ input.list }}",
        mapping: { id: "it.id", nome: "it.attributes.name" },
      },
      ctx({
        input: {
          list: [
            { id: 1, attributes: { name: "a" } },
            { id: 2, attributes: { name: "b" } },
          ],
        },
      }),
    );
    expect(res.output).toEqual({
      items: [
        { id: 1, nome: "a" },
        { id: 2, nome: "b" },
      ],
      length: 2,
    });
  });

  test("source array literal também funciona", async () => {
    const res = await runTransform({
      mode: "array",
      source: [{ id: 1 }],
      mapping: { id: "it.id" },
    });
    expect(res.output).toEqual({ items: [{ id: 1 }], length: 1 });
  });

  test("source não-array vira lista vazia", async () => {
    const res = await runTransform({ mode: "array", source: "nada", mapping: { id: "it.id" } });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("source ausente vira lista vazia", async () => {
    const res = await runTransform({ mode: "array", mapping: { id: "it.id" } });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("mapping em mode array ainda enxerga o contexto global", async () => {
    const res = await runTransform(
      { mode: "array", source: [{ id: 1 }], mapping: { id: "it.id", tenant: "vars.tenant" } },
      ctx({ vars: { tenant: "t1" } }),
    );
    expect(res.output).toEqual({ items: [{ id: 1, tenant: "t1" }], length: 1 });
  });
});

describe("transform — validação", () => {
  test("mapping ausente lança", async () => {
    await expect(runTransform({})).rejects.toThrow(/config.mapping é obrigatório/);
  });

  test("mapping não-objeto lança", async () => {
    await expect(runTransform({ mapping: "x" })).rejects.toThrow(/config.mapping é obrigatório/);
  });

  test("mode desconhecido lança", async () => {
    await expect(runTransform({ mode: "matrix", mapping: {} })).rejects.toThrow(
      /mode "matrix" não suportado/,
    );
  });
});

// ---------------------------------------------------------------------------
// set_variable
// ---------------------------------------------------------------------------

async function runSetVar(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return setVariableHandler({ node: node("set_variable", config), context });
}

describe("set_variable — modo single", () => {
  test("define uma variável com valor literal", async () => {
    const res = await runSetVar({ name: "x", value: 1 });
    expect(res.vars).toEqual({ x: 1 });
    expect(res.output).toEqual({ name: "x", value: 1 });
  });

  test("valor é templatável e preserva tipo", async () => {
    const res = await runSetVar({ name: "x", value: "{{ input.n }}" }, ctx({ input: { n: 42 } }));
    expect(res.vars).toEqual({ x: 42 });
  });

  test("name ausente lança", async () => {
    await expect(runSetVar({ value: 1 })).rejects.toThrow(/informe `name` ou `variables`/);
  });

  test("name vazio lança", async () => {
    await expect(runSetVar({ name: "", value: 1 })).rejects.toThrow(/informe `name` ou `variables`/);
  });

  test("name não-string lança", async () => {
    await expect(runSetVar({ name: 42, value: 1 })).rejects.toThrow(/informe `name` ou `variables`/);
  });
});

describe("set_variable — modo multi", () => {
  test("define N variáveis renderizadas", async () => {
    const res = await runSetVar(
      { variables: { a: "{{ input.x }}", b: "lit" } },
      ctx({ input: { x: 1 } }),
    );
    expect(res.vars).toEqual({ a: 1, b: "lit" });
    expect(res.output).toEqual({ a: 1, b: "lit" });
  });

  test("variables vazio devolve objeto vazio", async () => {
    const res = await runSetVar({ variables: {} });
    expect(res.vars).toEqual({});
  });

  test("chave com ponto vira flat E nested ao mesmo tempo", async () => {
    const res = await runSetVar({ variables: { "config.bearerToken": "123" } });
    expect(res.vars).toEqual({
      "config.bearerToken": "123",
      config: { bearerToken: "123" },
    });
  });

  test("chave com múltiplos pontos cria a árvore inteira", async () => {
    const res = await runSetVar({ variables: { "a.b.c": 1 } });
    expect(res.vars).toEqual({ "a.b.c": 1, a: { b: { c: 1 } } });
  });
});

describe("set_variable — coerção via _types", () => {
  test("boolean: string 'true' vira true", async () => {
    const res = await runSetVar({ variables: { f: " TRUE " }, _types: { f: "boolean" } });
    expect(res.vars).toEqual({ f: true });
  });

  test("boolean: string 'false' vira false", async () => {
    const res = await runSetVar({ variables: { f: "false" }, _types: { f: "boolean" } });
    expect(res.vars).toEqual({ f: false });
  });

  test("boolean: outra string cai em Boolean(value)", async () => {
    const res = await runSetVar({ variables: { f: "sim" }, _types: { f: "boolean" } });
    expect(res.vars).toEqual({ f: true });
  });

  test("boolean: já-boolean passa direto", async () => {
    const res = await runSetVar({ variables: { f: false }, _types: { f: "boolean" } });
    expect(res.vars).toEqual({ f: false });
  });

  test("number: string numérica vira número", async () => {
    const res = await runSetVar({ variables: { n: "42" }, _types: { n: "number" } });
    expect(res.vars).toEqual({ n: 42 });
  });

  test("number: string inválida devolve o valor original", async () => {
    const res = await runSetVar({ variables: { n: "abc" }, _types: { n: "number" } });
    expect(res.vars).toEqual({ n: "abc" });
  });

  test("string: número vira string", async () => {
    const res = await runSetVar({ variables: { s: 42 }, _types: { s: "string" } });
    expect(res.vars).toEqual({ s: "42" });
  });

  test("string: null vira string vazia", async () => {
    const res = await runSetVar({ variables: { s: null }, _types: { s: "string" } });
    expect(res.vars).toEqual({ s: "" });
  });

  test("object: JSON string é parseado", async () => {
    const res = await runSetVar({ variables: { o: '{"a":1}' }, _types: { o: "object" } });
    expect(res.vars).toEqual({ o: { a: 1 } });
  });

  test("array: JSON string é parseado", async () => {
    const res = await runSetVar({ variables: { a: "[1,2]" }, _types: { a: "array" } });
    expect(res.vars).toEqual({ a: [1, 2] });
  });

  test("object: JSON inválido devolve a string original", async () => {
    const res = await runSetVar({ variables: { o: "{quebrado" }, _types: { o: "object" } });
    expect(res.vars).toEqual({ o: "{quebrado" });
  });

  test("object: não-string passa direto", async () => {
    const res = await runSetVar({ variables: { o: { a: 1 } }, _types: { o: "object" } });
    expect(res.vars).toEqual({ o: { a: 1 } });
  });

  test("tipo desconhecido não coage", async () => {
    const res = await runSetVar({ variables: { x: "1" }, _types: { x: "bigint" } });
    expect(res.vars).toEqual({ x: "1" });
  });

  test("chaves sem entrada em _types ficam intocadas", async () => {
    const res = await runSetVar({ variables: { a: "1", b: "2" }, _types: { a: "number" } });
    expect(res.vars).toEqual({ a: 1, b: "2" });
  });
});

// ---------------------------------------------------------------------------
// stop_and_error
// ---------------------------------------------------------------------------

async function runStop(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return stopAndErrorHandler({ node: node("stop_and_error", config), context });
}

describe("stop_and_error", () => {
  test("lança erro com a mensagem configurada", async () => {
    await expect(runStop({ message: "pedido inválido" })).rejects.toThrow("pedido inválido");
  });

  test("mensagem é templatável", async () => {
    await expect(
      runStop({ message: "erro no pedido {{ input.id }}" }, ctx({ input: { id: 7 } })),
    ).rejects.toThrow("erro no pedido 7");
  });

  test("message ausente lança erro de config", async () => {
    await expect(runStop({})).rejects.toThrow(/config.message é obrigatório/);
  });

  test("message vazia lança erro de config", async () => {
    await expect(runStop({ message: "" })).rejects.toThrow(/config.message é obrigatório/);
  });

  test("message não-string lança erro de config", async () => {
    await expect(runStop({ message: 42 })).rejects.toThrow(/config.message é obrigatório/);
  });

  test("details é anexado ao erro", async () => {
    const err = await runStop({ message: "x", details: { campo: "cpf" } }).catch(
      (e: unknown) => e as Error & { details?: unknown },
    );
    expect(err.message).toBe("x");
    expect(err.details).toEqual({ campo: "cpf" });
  });

  test("details é templatável", async () => {
    const err = await runStop(
      { message: "x", details: { id: "{{ input.id }}" } },
      ctx({ input: { id: 9 } }),
    ).catch((e: unknown) => e as Error & { details?: unknown });
    expect(err.details).toEqual({ id: 9 });
  });

  test("sem details o erro não ganha a propriedade", async () => {
    const err = await runStop({ message: "x" }).catch(
      (e: unknown) => e as Error & { details?: unknown },
    );
    expect(err.details).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// respond_to_webhook
// ---------------------------------------------------------------------------

async function runRespond(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  const res = await respondToWebhookHandler({ node: node("respond_to_webhook", config), context });
  return res.output.__webhookResponse as { status: number; headers: Record<string, string>; body: unknown };
}

describe("respond_to_webhook", () => {
  test("defaults: status 200, headers vazios, body null", async () => {
    const r = await runRespond({});
    expect(r).toEqual({ status: 200, headers: {}, body: null });
  });

  test("status válido é respeitado", async () => {
    expect((await runRespond({ status: 404 })).status).toBe(404);
  });

  test("status 599 (limite superior) é aceito", async () => {
    expect((await runRespond({ status: 599 })).status).toBe(599);
  });

  test("status 100 (limite inferior) é aceito", async () => {
    expect((await runRespond({ status: 100 })).status).toBe(100);
  });

  test("status fracionário é truncado", async () => {
    expect((await runRespond({ status: 201.9 })).status).toBe(201);
  });

  test("status fora da faixa cai para 200", async () => {
    expect((await runRespond({ status: 99 })).status).toBe(200);
    expect((await runRespond({ status: 600 })).status).toBe(200);
  });

  test("status não-numérico cai para 200", async () => {
    expect((await runRespond({ status: "201" })).status).toBe(200);
  });

  test("headers são convertidos para string", async () => {
    const r = await runRespond({ headers: { "x-count": 3, "x-flag": true, "x-s": "v" } });
    expect(r.headers).toEqual({ "x-count": "3", "x-flag": "true", "x-s": "v" });
  });

  test("headers não-objeto é ignorado", async () => {
    expect((await runRespond({ headers: "x" })).headers).toEqual({});
  });

  test("body objeto é preservado", async () => {
    expect((await runRespond({ body: { ok: true } })).body).toEqual({ ok: true });
  });

  test("body explicitamente null é preservado", async () => {
    expect((await runRespond({ body: null })).body).toBeNull();
  });

  test("body é templatável", async () => {
    const r = await runRespond({ body: { eco: "{{ input.msg }}" } }, ctx({ input: { msg: "oi" } }));
    expect(r.body).toEqual({ eco: "oi" });
  });

  test("body string simples", async () => {
    expect((await runRespond({ body: "pong" })).body).toBe("pong");
  });

  test("status e headers também são templatáveis", async () => {
    const r = await runRespond(
      { status: "{{ input.st }}", headers: { "x-id": "{{ input.id }}" } },
      ctx({ input: { st: 418, id: 7 } }),
    );
    expect(r.status).toBe(418);
    expect(r.headers).toEqual({ "x-id": "7" });
  });
});

// ---------------------------------------------------------------------------
// crypto
// ---------------------------------------------------------------------------

async function runCrypto(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return cryptoHandler({ node: node("crypto", config), context });
}

// Segredo fixo só para teste — não é credencial real.
const TEST_SECRET = "segredo-de-teste";

const SHA256_HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("crypto — hash", () => {
  /**
   * BUG (crypto-node.ts:30 e :48): quando `encoding` é OMITIDO da config, a
   * ternária devolve `cfg.encoding` — que é `undefined` — em vez do "hex"
   * default que a condição acabou de calcular. `digest(undefined)` devolve um
   * Buffer, não string, e o Buffer vai cru pro output do step (e daí pro JSONB
   * de workflow_run_steps). Só acontece com `encoding` ausente: valor válido
   * ("hex"/"base64") e valor inválido ("rot13" → cai no literal "hex") ambos
   * produzem string. Os testes abaixo travam o comportamento ATUAL.
   */
  test("BUG: sem encoding explícito o digest sai como Buffer, não string", async () => {
    const res = await runCrypto({ operation: "hash", value: "hello" });
    expect(Buffer.isBuffer(res.output.digest)).toBe(true);
    expect((res.output.digest as Buffer).toString("hex")).toBe(SHA256_HELLO);
  });

  test("sha256 com encoding hex explícito", async () => {
    const res = await runCrypto({ operation: "hash", value: "hello", encoding: "hex" });
    expect(res.output.digest).toBe(SHA256_HELLO);
  });

  test("md5", async () => {
    const res = await runCrypto({
      operation: "hash",
      algorithm: "md5",
      value: "hello",
      encoding: "hex",
    });
    expect(res.output.digest).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  test("sha1", async () => {
    const res = await runCrypto({
      operation: "hash",
      algorithm: "sha1",
      value: "hello",
      encoding: "hex",
    });
    expect(res.output.digest).toBe("aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
  });

  test("sha512 produz 128 hex chars", async () => {
    const res = await runCrypto({
      operation: "hash",
      algorithm: "sha512",
      value: "hello",
      encoding: "hex",
    });
    expect(String(res.output.digest)).toHaveLength(128);
  });

  test("encoding base64", async () => {
    const res = await runCrypto({ operation: "hash", value: "hello", encoding: "base64" });
    expect(res.output.digest).toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
  });

  test("encoding inválido cai para hex (string, ao contrário do encoding ausente)", async () => {
    const res = await runCrypto({ operation: "hash", value: "hello", encoding: "rot13" });
    expect(res.output.digest).toBe(SHA256_HELLO);
  });

  test("value é templatável", async () => {
    const res = await runCrypto(
      { operation: "hash", value: "{{ input.v }}", encoding: "hex" },
      ctx({ input: { v: "hello" } }),
    );
    expect(res.output.digest).toBe(SHA256_HELLO);
  });

  test("value ausente vira string vazia (hash do vazio)", async () => {
    const res = await runCrypto({ operation: "hash", encoding: "hex" });
    expect(res.output.digest).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("algoritmo não suportado lança", async () => {
    await expect(runCrypto({ operation: "hash", algorithm: "sha3", value: "x" })).rejects.toThrow(
      /algoritmo "sha3" não suportado/,
    );
  });
});

describe("crypto — hmac", () => {
  test("hmac sha256 em hex", async () => {
    const res = await runCrypto({
      operation: "hmac",
      value: "hello",
      secret: TEST_SECRET,
    });
    expect(res.output.digest).toBe(
      "a8bbce6b50ddf3561e585d4ccb813e91fc2a00994ab032435163327386d5280f",
    );
  });

  test("hmac é determinístico e muda com o segredo", async () => {
    const a = await runCrypto({ operation: "hmac", value: "x", secret: "s1" });
    const b = await runCrypto({ operation: "hmac", value: "x", secret: "s2" });
    const a2 = await runCrypto({ operation: "hmac", value: "x", secret: "s1" });
    expect(a.output.digest).toBe(a2.output.digest as string);
    expect(a.output.digest).not.toBe(b.output.digest as string);
  });

  test("hmac com encoding base64", async () => {
    const res = await runCrypto({
      operation: "hmac",
      value: "hello",
      secret: TEST_SECRET,
      encoding: "base64",
    });
    expect(String(res.output.digest)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("hmac sha512", async () => {
    const res = await runCrypto({
      operation: "hmac",
      algorithm: "sha512",
      value: "x",
      secret: TEST_SECRET,
    });
    expect(String(res.output.digest)).toHaveLength(128);
  });

  test("secret ausente lança", async () => {
    await expect(runCrypto({ operation: "hmac", value: "x" })).rejects.toThrow(
      /`secret` é obrigatório/,
    );
  });

  test("secret vazio lança", async () => {
    await expect(runCrypto({ operation: "hmac", value: "x", secret: "" })).rejects.toThrow(
      /`secret` é obrigatório/,
    );
  });

  test("algoritmo não suportado lança", async () => {
    await expect(
      runCrypto({ operation: "hmac", algorithm: "crc32", value: "x", secret: TEST_SECRET }),
    ).rejects.toThrow(/algoritmo "crc32" não suportado/);
  });
});

describe("crypto — uuid / random / base64", () => {
  test("uuid v4 no formato canônico", async () => {
    const res = await runCrypto({ operation: "uuid" });
    expect(String(res.output.uuid)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test("uuids consecutivos são distintos", async () => {
    const a = await runCrypto({ operation: "uuid" });
    const b = await runCrypto({ operation: "uuid" });
    expect(a.output.uuid).not.toBe(b.output.uuid as string);
  });

  test("random default: 16 bytes em hex (32 chars)", async () => {
    const res = await runCrypto({ operation: "random" });
    expect(res.output.bytes).toBe(16);
    expect(String(res.output.value)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("random com bytes customizado", async () => {
    const res = await runCrypto({ operation: "random", bytes: 8 });
    expect(res.output.bytes).toBe(8);
    expect(String(res.output.value)).toHaveLength(16);
  });

  test("random limita a 256 bytes", async () => {
    const res = await runCrypto({ operation: "random", bytes: 9999 });
    expect(res.output.bytes).toBe(256);
    expect(String(res.output.value)).toHaveLength(512);
  });

  test("random com bytes inválido/zero cai para 16", async () => {
    expect((await runCrypto({ operation: "random", bytes: 0 })).output.bytes).toBe(16);
    expect((await runCrypto({ operation: "random", bytes: -5 })).output.bytes).toBe(16);
    expect((await runCrypto({ operation: "random", bytes: "abc" })).output.bytes).toBe(16);
  });

  test("random com bytes fracionário é truncado", async () => {
    expect((await runCrypto({ operation: "random", bytes: 4.9 })).output.bytes).toBe(4);
  });

  test("random em base64", async () => {
    const res = await runCrypto({ operation: "random", bytes: 12, encoding: "base64" });
    expect(String(res.output.value)).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(Buffer.from(String(res.output.value), "base64")).toHaveLength(12);
  });

  test("base64 encode", async () => {
    const res = await runCrypto({ operation: "base64", value: "olá" });
    expect(res.output.value).toBe(Buffer.from("olá", "utf8").toString("base64"));
  });

  test("base64 decode", async () => {
    const enc = Buffer.from("olá mundo", "utf8").toString("base64");
    const res = await runCrypto({ operation: "base64", mode: "decode", value: enc });
    expect(res.output.value).toBe("olá mundo");
  });

  test("base64 round-trip encode → decode", async () => {
    const original = "texto com acentuação e símbolos ✓";
    const enc = await runCrypto({ operation: "base64", mode: "encode", value: original });
    const dec = await runCrypto({
      operation: "base64",
      mode: "decode",
      value: String(enc.output.value),
    });
    expect(dec.output.value).toBe(original);
  });

  test("base64 com mode inválido lança", async () => {
    await expect(runCrypto({ operation: "base64", mode: "rot13", value: "x" })).rejects.toThrow(
      /mode "rot13" inválido/,
    );
  });

  test("operation desconhecida lança", async () => {
    await expect(runCrypto({ operation: "enigma" })).rejects.toThrow(
      /operation "enigma" não suportada/,
    );
  });

  test("operation ausente lança", async () => {
    await expect(runCrypto({})).rejects.toThrow(/operation "undefined" não suportada/);
  });
});

// ---------------------------------------------------------------------------
// jwt
// ---------------------------------------------------------------------------

async function runJwt(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return jwtHandler({ node: node("jwt", config), context });
}

// Segredo fixo só para teste — não é credencial real.
const JWT_SECRET = "jwt-segredo-de-teste-1234567890";

describe("jwt — sign e verify (round-trip)", () => {
  test("sign produz token JWS de 3 segmentos", async () => {
    const res = await runJwt({ operation: "sign", payload: { sub: "u1" }, secret: JWT_SECRET });
    expect(String(res.output.token).split(".")).toHaveLength(3);
  });

  test("round-trip sign → verify devolve o payload", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1", role: "admin" },
      secret: JWT_SECRET,
    });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
    });
    expect(verified.output.valid).toBe(true);
    const payload = verified.output.payload as Record<string, unknown>;
    expect(payload.sub).toBe("u1");
    expect(payload.role).toBe("admin");
    expect(verified.output.header).toEqual({ alg: "HS256" });
  });

  test("sign anexa iat automaticamente", async () => {
    const signed = await runJwt({ operation: "sign", payload: { sub: "u1" }, secret: JWT_SECRET });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
    });
    expect(typeof (verified.output.payload as Record<string, unknown>).iat).toBe("number");
  });

  test("expiresIn define exp", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      expiresIn: "1h",
    });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
    });
    const p = verified.output.payload as Record<string, number>;
    expect(p.exp! - p.iat!).toBe(3600);
  });

  test("verify com segredo errado devolve valid:false (não lança)", async () => {
    const signed = await runJwt({ operation: "sign", payload: { sub: "u1" }, secret: JWT_SECRET });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: "segredo-errado-totalmente",
    });
    expect(verified.output.valid).toBe(false);
    expect(typeof verified.output.error).toBe("string");
    expect(verified.output.payload).toBeUndefined();
  });

  test("verify com token malformado devolve valid:false", async () => {
    const verified = await runJwt({ operation: "verify", token: "nada.disso", secret: JWT_SECRET });
    expect(verified.output.valid).toBe(false);
  });

  test("token expirado devolve valid:false", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      expiresIn: "-1h",
    });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
    });
    expect(verified.output.valid).toBe(false);
  });

  test("algorithm HS384 e HS512 fazem round-trip", async () => {
    for (const alg of ["HS384", "HS512"]) {
      const signed = await runJwt({
        operation: "sign",
        payload: { sub: "u1" },
        secret: JWT_SECRET,
        algorithm: alg,
      });
      const verified = await runJwt({
        operation: "verify",
        token: signed.output.token,
        secret: JWT_SECRET,
      });
      expect(verified.output.valid).toBe(true);
      expect(verified.output.header).toEqual({ alg });
    }
  });

  test("algorithm inválido cai para HS256", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      algorithm: "RS256",
    });
    const decoded = await runJwt({ operation: "decode", token: signed.output.token });
    expect(decoded.output.header).toEqual({ alg: "HS256" });
  });

  test("issuer e audience batendo → valid:true", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      issuer: "adila",
      audience: "app",
    });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
      issuer: "adila",
      audience: "app",
    });
    expect(verified.output.valid).toBe(true);
    const p = verified.output.payload as Record<string, unknown>;
    expect(p.iss).toBe("adila");
    expect(p.aud).toBe("app");
  });

  test("issuer divergente → valid:false", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      issuer: "adila",
    });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
      issuer: "outro",
    });
    expect(verified.output.valid).toBe(false);
  });

  test("audience divergente → valid:false", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      audience: "app",
    });
    const verified = await runJwt({
      operation: "verify",
      token: signed.output.token,
      secret: JWT_SECRET,
      audience: "outro",
    });
    expect(verified.output.valid).toBe(false);
  });

  test("secret é templatável", async () => {
    const c = ctx({ env: { JWT_SECRET } });
    const signed = await runJwt(
      { operation: "sign", payload: { sub: "u1" }, secret: "{{ env.JWT_SECRET }}" },
      c,
    );
    const verified = await runJwt(
      { operation: "verify", token: signed.output.token, secret: "{{ env.JWT_SECRET }}" },
      c,
    );
    expect(verified.output.valid).toBe(true);
  });
});

describe("jwt — decode", () => {
  test("decode devolve payload e header sem validar assinatura", async () => {
    const signed = await runJwt({ operation: "sign", payload: { sub: "u1" }, secret: JWT_SECRET });
    const decoded = await runJwt({ operation: "decode", token: signed.output.token });
    expect((decoded.output.payload as Record<string, unknown>).sub).toBe("u1");
    expect(decoded.output.header).toEqual({ alg: "HS256" });
  });

  test("decode não checa expiração", async () => {
    const signed = await runJwt({
      operation: "sign",
      payload: { sub: "u1" },
      secret: JWT_SECRET,
      expiresIn: "-1h",
    });
    const decoded = await runJwt({ operation: "decode", token: signed.output.token });
    expect((decoded.output.payload as Record<string, unknown>).sub).toBe("u1");
  });

  test("decode de token inválido lança (vem da jose)", async () => {
    await expect(runJwt({ operation: "decode", token: "lixo" })).rejects.toThrow();
  });
});

describe("jwt — validação de config", () => {
  test("sign sem payload lança", async () => {
    await expect(runJwt({ operation: "sign", secret: JWT_SECRET })).rejects.toThrow(
      /config.payload é obrigatório/,
    );
  });

  test("sign sem secret lança", async () => {
    await expect(runJwt({ operation: "sign", payload: { a: 1 } })).rejects.toThrow(
      /config.secret é obrigatório/,
    );
  });

  test("verify sem token lança", async () => {
    await expect(runJwt({ operation: "verify", secret: JWT_SECRET })).rejects.toThrow(
      /config.token é obrigatório/,
    );
  });

  test("verify sem secret lança", async () => {
    await expect(runJwt({ operation: "verify", token: "a.b.c" })).rejects.toThrow(
      /config.secret é obrigatório/,
    );
  });

  test("decode sem token lança", async () => {
    await expect(runJwt({ operation: "decode" })).rejects.toThrow(/config.token é obrigatório/);
  });

  test("operation desconhecida lança", async () => {
    await expect(runJwt({ operation: "refresh" })).rejects.toThrow(
      /deve ser 'sign', 'verify' ou 'decode'/,
    );
  });
});

// ---------------------------------------------------------------------------
// compression
// ---------------------------------------------------------------------------

async function runCompression(config: Record<string, unknown>, context: ExecutionContext = ctx()) {
  return compressionHandler({ node: node("compression", config), context });
}

describe("compression — round-trip", () => {
  test("gzip (default) compress → decompress preserva o conteúdo", async () => {
    const original = "adila ".repeat(200);
    const comp = await runCompression({ operation: "compress", value: original });
    const dec = await runCompression({
      operation: "decompress",
      value: String(comp.output.value),
    });
    expect(dec.output.value).toBe(original);
  });

  test("deflate compress → decompress preserva o conteúdo", async () => {
    const original = "dados repetidos ".repeat(100);
    const comp = await runCompression({
      operation: "compress",
      algorithm: "deflate",
      value: original,
    });
    const dec = await runCompression({
      operation: "decompress",
      algorithm: "deflate",
      value: String(comp.output.value),
    });
    expect(dec.output.value).toBe(original);
  });

  test("texto repetitivo realmente encolhe", async () => {
    const original = "a".repeat(5000);
    const comp = await runCompression({ operation: "compress", value: original });
    expect(comp.output.originalSize).toBe(5000);
    expect(comp.output.finalSize as number).toBeLessThan(5000);
  });

  test("compress default emite base64 válido", async () => {
    const comp = await runCompression({ operation: "compress", value: "olá" });
    expect(String(comp.output.value)).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  test("round-trip com encoding hex explícito", async () => {
    const original = "conteúdo hexadecimal";
    const comp = await runCompression({
      operation: "compress",
      value: original,
      outputEncoding: "hex",
    });
    expect(String(comp.output.value)).toMatch(/^[0-9a-f]+$/);
    const dec = await runCompression({
      operation: "decompress",
      value: String(comp.output.value),
      inputEncoding: "hex",
    });
    expect(dec.output.value).toBe(original);
  });

  test("preserva acentuação em utf8", async () => {
    const original = "ação, coração e não — çãõ";
    const comp = await runCompression({ operation: "compress", value: original });
    const dec = await runCompression({ operation: "decompress", value: String(comp.output.value) });
    expect(dec.output.value).toBe(original);
  });

  test("originalSize/finalSize refletem os buffers, não as strings", async () => {
    const comp = await runCompression({ operation: "compress", value: "olá" });
    // "olá" em utf8 tem 4 bytes (á = 2 bytes).
    expect(comp.output.originalSize).toBe(4);
    expect(comp.output.finalSize as number).toBeGreaterThan(0);
  });

  test("value é templatável", async () => {
    const comp = await runCompression(
      { operation: "compress", value: "{{ input.txt }}" },
      ctx({ input: { txt: "oi" } }),
    );
    const dec = await runCompression({ operation: "decompress", value: String(comp.output.value) });
    expect(dec.output.value).toBe("oi");
  });

  test("algorithm inválido cai para gzip", async () => {
    const comp = await runCompression({ operation: "compress", algorithm: "brotli", value: "oi" });
    const dec = await runCompression({
      operation: "decompress",
      algorithm: "gzip",
      value: String(comp.output.value),
    });
    expect(dec.output.value).toBe("oi");
  });
});

describe("compression — validação", () => {
  test("value não-string lança", async () => {
    await expect(runCompression({ operation: "compress", value: 42 })).rejects.toThrow(
      /config.value deve ser string/,
    );
  });

  test("value ausente lança", async () => {
    await expect(runCompression({ operation: "compress" })).rejects.toThrow(
      /config.value deve ser string/,
    );
  });

  test("operation inválida lança", async () => {
    await expect(runCompression({ operation: "zip", value: "x" })).rejects.toThrow(
      /deve ser 'compress' ou 'decompress'/,
    );
  });

  test("decompress de dado que não é gzip lança", async () => {
    const lixo = Buffer.from("não sou gzip", "utf8").toString("base64");
    await expect(runCompression({ operation: "decompress", value: lixo })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// triggers passthrough
// ---------------------------------------------------------------------------

describe("triggers passthrough — ecoam o input no shape do próprio trigger", () => {
  const payload = { a: 1, nested: { b: 2 } };

  const casos: Array<[string, NodeType, (typeof scheduleTriggerHandler), string]> = [
    ["schedule_trigger", "schedule_trigger", scheduleTriggerHandler, "input"],
    ["interval_trigger", "interval_trigger", intervalTriggerHandler, "input"],
    ["email_trigger", "email_trigger", emailTriggerHandler, "email"],
    ["form_trigger", "form_trigger", formTriggerHandler, "submission"],
    ["chat_trigger", "chat_trigger", chatTriggerHandler, "message"],
    ["error_trigger", "error_trigger", errorTriggerHandler, "error"],
    ["workflow_called_trigger", "workflow_called_trigger", workflowCalledTriggerHandler, "args"],
    ["rss_trigger", "rss_trigger", rssTriggerHandler, "item"],
    ["postgres_trigger", "postgres_trigger", postgresTriggerHandler, "notification"],
    ["redis_trigger", "redis_trigger", redisTriggerHandler, "message"],
    ["webhook_trigger", "webhook_trigger", webhookTriggerHandler, "body"],
  ];

  for (const [nome, tipo, handler, chave] of casos) {
    test(`${nome} envelopa o input em '${chave}'`, async () => {
      const res = await handler({ node: node(tipo, {}), context: ctx({ input: payload }) });
      expect(res.output).toEqual({ [chave]: payload });
      expect(res.nextLabel).toBeUndefined();
    });

    test(`${nome} com input vazio devolve '${chave}' vazio`, async () => {
      const res = await handler({ node: node(tipo, {}), context: ctx() });
      expect(res.output).toEqual({ [chave]: {} });
    });
  }
});

describe("manual_trigger", () => {
  test("com input preenchido ecoa o input", async () => {
    const res = await manualTriggerHandler({
      node: node("manual_trigger", { defaultInput: { a: "default" } }),
      context: ctx({ input: { a: "real" } }),
    });
    expect(res.output).toEqual({ input: { a: "real" } });
  });

  test("sem input usa defaultInput e pré-popula context.input", async () => {
    const context = ctx();
    const res = await manualTriggerHandler({
      node: node("manual_trigger", { defaultInput: { a: 1 } }),
      context,
    });
    expect(res.output).toEqual({ input: { a: 1 } });
    // Efeito colateral intencional: downstream consegue usar `{{ input.a }}`.
    expect(context.input).toEqual({ a: 1 });
  });

  test("defaultInput é templatável", async () => {
    const context = ctx({ env: { REGIAO: "br" } });
    const res = await manualTriggerHandler({
      node: node("manual_trigger", { defaultInput: { regiao: "{{ env.REGIAO }}" } }),
      context,
    });
    expect(res.output).toEqual({ input: { regiao: "br" } });
  });

  test("sem input e sem defaultInput devolve input vazio", async () => {
    const res = await manualTriggerHandler({ node: node("manual_trigger", {}), context: ctx() });
    expect(res.output).toEqual({ input: {} });
  });

  test("defaultInput não-objeto é ignorado", async () => {
    const res = await manualTriggerHandler({
      node: node("manual_trigger", { defaultInput: "xx" }),
      context: ctx(),
    });
    expect(res.output).toEqual({ input: {} });
  });
});

// ---------------------------------------------------------------------------
// token-usage
// ---------------------------------------------------------------------------

describe("token-usage — extractTokenUsage", () => {
  test("shape ai_chat/ai_agent (inputTokens/outputTokens/totalTokens)", () => {
    const res = extractTokenUsage(
      { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { model: "gpt-4o" },
    );
    expect(res).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15, model: "gpt-4o" });
  });

  test("totalTokens ausente é somado a partir de input+output", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 10, outputTokens: 5 } }, {});
    expect(res?.totalTokens).toBe(15);
  });

  test("shape embeddings ({ tokens }) conta como input, sem output", () => {
    const res = extractTokenUsage(
      { usage: { tokens: 7 }, model: "text-embedding-3-small" },
      {},
    );
    expect(res).toEqual({
      inputTokens: 7,
      outputTokens: null,
      totalTokens: 7,
      model: "text-embedding-3-small",
    });
  });

  test("inputTokens tem prioridade sobre tokens", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 3, tokens: 99 } }, {});
    expect(res?.inputTokens).toBe(3);
  });

  test("valores fracionários são arredondados", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 10.4, outputTokens: 5.6 } }, {});
    expect(res?.inputTokens).toBe(10);
    expect(res?.outputTokens).toBe(6);
  });

  test("valores não-numéricos viram null", () => {
    const res = extractTokenUsage({ usage: { inputTokens: "10", outputTokens: 5 } }, {});
    expect(res?.inputTokens).toBeNull();
    expect(res?.outputTokens).toBe(5);
    expect(res?.totalTokens).toBe(5);
  });

  test("Infinity vira null", () => {
    const res = extractTokenUsage({ usage: { inputTokens: Infinity, outputTokens: 2 } }, {});
    expect(res?.inputTokens).toBeNull();
  });

  test("model do config tem prioridade sobre o do output", () => {
    const res = extractTokenUsage(
      { usage: { inputTokens: 1 }, model: "do-output" },
      { model: "do-config" },
    );
    expect(res?.model).toBe("do-config");
  });

  test("model do output é fallback", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 1 }, model: "do-output" }, {});
    expect(res?.model).toBe("do-output");
  });

  test("sem model em lugar nenhum devolve null", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 1 } }, null);
    expect(res?.model).toBeNull();
  });

  test("model não-string no config é ignorado", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 1 } }, { model: 42 });
    expect(res?.model).toBeNull();
  });

  test("output sem usage devolve null", () => {
    expect(extractTokenUsage({ texto: "oi" }, {})).toBeNull();
  });

  test("output não-objeto devolve null", () => {
    expect(extractTokenUsage("string", {})).toBeNull();
    expect(extractTokenUsage(null, {})).toBeNull();
    expect(extractTokenUsage(42, {})).toBeNull();
  });

  test("usage não-objeto devolve null", () => {
    expect(extractTokenUsage({ usage: "muito" }, {})).toBeNull();
  });

  test("usage sem número reconhecível devolve null", () => {
    expect(extractTokenUsage({ usage: { foo: "bar" } }, {})).toBeNull();
  });

  test("usage com zeros devolve totais zerados e total null", () => {
    // sum === 0 não é > 0, então totalTokens fica null — mas o registro é
    // mantido porque input/output são números reconhecidos.
    const res = extractTokenUsage({ usage: { inputTokens: 0, outputTokens: 0 } }, {});
    expect(res).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: null, model: null });
  });

  test("só outputTokens ainda é rastreável", () => {
    const res = extractTokenUsage({ usage: { outputTokens: 4 } }, {});
    expect(res).toEqual({ inputTokens: null, outputTokens: 4, totalTokens: 4, model: null });
  });

  test("totalTokens explícito não é recalculado", () => {
    const res = extractTokenUsage({ usage: { inputTokens: 1, outputTokens: 1, totalTokens: 99 } }, {});
    expect(res?.totalTokens).toBe(99);
  });
});
