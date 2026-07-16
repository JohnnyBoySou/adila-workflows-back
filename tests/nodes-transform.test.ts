import { describe, expect, test } from "bun:test";
import { aggregateHandler } from "../src/lib/engine/nodes/aggregate";
import { compareDatasetsHandler } from "../src/lib/engine/nodes/compare-datasets";
import { editFieldsHandler } from "../src/lib/engine/nodes/edit-fields";
import { filterHandler } from "../src/lib/engine/nodes/filter";
import { itemListsHandler } from "../src/lib/engine/nodes/item-lists";
import { limitHandler } from "../src/lib/engine/nodes/limit";
import { mergeHandler } from "../src/lib/engine/nodes/merge";
import { randomHandler } from "../src/lib/engine/nodes/random";
import { removeDuplicatesHandler } from "../src/lib/engine/nodes/remove-duplicates";
import { renameKeysHandler } from "../src/lib/engine/nodes/rename-keys";
import { shuffleHandler } from "../src/lib/engine/nodes/shuffle";
import { sortHandler } from "../src/lib/engine/nodes/sort";
import { splitInBatchesHandler } from "../src/lib/engine/nodes/split-in-batches";
import { splitOutHandler } from "../src/lib/engine/nodes/split-out";
import { uuidHandler } from "../src/lib/engine/nodes/uuid";
import type {
  ExecutionContext,
  NodeHandler,
  NodeType,
  WorkflowNode,
} from "../src/lib/engine/types";

/**
 * Testes dos nós de transformação de dados do engine.
 *
 * Não precisam de DB nem de rede — exercitam os handlers diretamente, no
 * mesmo estilo de `tests/code-node.test.ts`.
 *
 * Todos os handlers passam `node.config` por `renderTemplate`, então os
 * testes também cobrem interpolação `{{ ... }}` onde ela importa.
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

/** Invoca um handler com config crua e contexto opcional. */
function run(
  handler: NodeHandler,
  type: NodeType,
  config: Record<string, unknown>,
  context: ExecutionContext = ctx(),
) {
  return handler({ node: node(type, config), context });
}

// ---------------------------------------------------------------------------
// edit_fields
// ---------------------------------------------------------------------------

describe("edit_fields", () => {
  test("set adiciona e sobrescreve campos num objeto", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1, b: 2 },
      set: { b: 99, c: 3 },
    });
    expect(res.output).toEqual({ data: { a: 1, b: 99, c: 3 } });
  });

  test("remove apaga chaves do objeto", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1, b: 2, c: 3 },
      remove: ["b", "c"],
    });
    expect(res.output).toEqual({ data: { a: 1 } });
  });

  test("remove roda depois de set — remover uma chave recém-setada a apaga", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1 },
      set: { novo: "x" },
      remove: ["novo"],
    });
    expect(res.output).toEqual({ data: { a: 1 } });
  });

  test("keep_only descarta tudo fora de keep, mas set ainda é aplicado", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1, b: 2, c: 3 },
      keep_only: true,
      keep: ["a"],
      set: { d: 4 },
    });
    expect(res.output).toEqual({ data: { a: 1, d: 4 } });
  });

  test("keep_only com keep listando chave inexistente simplesmente a ignora", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1 },
      keep_only: true,
      keep: ["a", "naoExiste"],
    });
    expect(res.output).toEqual({ data: { a: 1 } });
  });

  test("keep_only sem keep zera o objeto", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1, b: 2 },
      keep_only: true,
    });
    expect(res.output).toEqual({ data: {} });
  });

  test("array aplica a edição item a item e devolve items + length", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: [{ a: 1 }, { a: 2 }],
      set: { tag: "x" },
    });
    expect(res.output).toEqual({
      items: [
        { a: 1, tag: "x" },
        { a: 2, tag: "x" },
      ],
      length: 2,
    });
  });

  test("itens não-objeto dentro do array passam intactos", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: [1, "txt", null, { a: 1 }],
      set: { tag: "x" },
    });
    expect(res.output.items).toEqual([1, "txt", null, { a: 1, tag: "x" }]);
  });

  test("array vazio devolve items vazio e length 0", async () => {
    const res = await run(editFieldsHandler, "edit_fields", { data: [], set: { a: 1 } });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("data primitivo é repassado sem edição", async () => {
    const res = await run(editFieldsHandler, "edit_fields", { data: "texto", set: { a: 1 } });
    expect(res.output).toEqual({ data: "texto" });
  });

  test("data null cai no ramo de passagem direta", async () => {
    const res = await run(editFieldsHandler, "edit_fields", { data: null, set: { a: 1 } });
    expect(res.output).toEqual({ data: null });
  });

  test("data ausente devolve { data: undefined }", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {});
    expect(res.output).toEqual({ data: undefined });
  });

  test("set/remove/keep inválidos são tratados como vazios (sem throw)", async () => {
    const res = await run(editFieldsHandler, "edit_fields", {
      data: { a: 1 },
      set: null,
      remove: "naoEhArray",
      keep: 42,
    });
    expect(res.output).toEqual({ data: { a: 1 } });
  });

  test("templates em set são interpolados contra o contexto", async () => {
    const res = await run(
      editFieldsHandler,
      "edit_fields",
      { data: { id: 1 }, set: { saudacao: "olá {{ input.nome }}", bruto: "{{ vars.n }}" } },
      ctx({ input: { nome: "ada" }, vars: { n: 7 } }),
    );
    // `{{ vars.n }}` é template "puro" → preserva o tipo number.
    expect(res.output).toEqual({ data: { id: 1, saudacao: "olá ada", bruto: 7 } });
  });

  test("não muta o objeto original", async () => {
    const original = { a: 1 };
    await run(editFieldsHandler, "edit_fields", { data: original, set: { b: 2 } });
    expect(original).toEqual({ a: 1 });
  });
});

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

describe("limit", () => {
  test("pega os N primeiros por padrão", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3, 4, 5], count: 2 });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("from: 'end' pega os N últimos", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3, 4, 5], count: 2, from: "end" });
    expect(res.output).toEqual({ items: [4, 5], length: 2 });
  });

  test("from com valor desconhecido cai no comportamento de 'start'", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: 1, from: "meio" });
    expect(res.output).toEqual({ items: [1], length: 1 });
  });

  test("count maior que o array devolve tudo", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2], count: 10 });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("count 0 (from start) devolve vazio", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: 0 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("count negativo é normalizado pra 0", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: -5 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("count fracionário é truncado pra baixo", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: 2.9 });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("count não-numérico vira 0", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: "abc" });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  // Regressão: `slice(-0)` é `slice(0)` e devolvia a lista inteira — o oposto
  // do esperado. count 0 tem curto-circuito nas duas direções.
  test("count 0 com from 'end' devolve lista vazia", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: 0, from: "end" });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("count não-numérico com from 'end' vira 0 e devolve lista vazia", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: "abc", from: "end" });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("count negativo com from 'end' vira 0 e devolve lista vazia", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: -1, from: "end" });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("from 'end' com count válido ainda mantém os últimos N", async () => {
    const res = await run(limitHandler, "limit", { items: [1, 2, 3], count: 2, from: "end" });
    expect(res.output).toEqual({ items: [2, 3], length: 2 });
  });

  test("items ausente vira array vazio", async () => {
    const res = await run(limitHandler, "limit", { count: 3 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("items não-array vira array vazio", async () => {
    const res = await run(limitHandler, "limit", { items: { a: 1 }, count: 3 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("items via template puro preserva o array", async () => {
    const res = await run(
      limitHandler,
      "limit",
      { items: "{{ vars.lista }}", count: 2 },
      ctx({ vars: { lista: ["a", "b", "c"] } }),
    );
    expect(res.output).toEqual({ items: ["a", "b"], length: 2 });
  });
});

// ---------------------------------------------------------------------------
// remove_duplicates
// ---------------------------------------------------------------------------

describe("remove_duplicates", () => {
  test("dedup por valor do item inteiro, mantendo a primeira ocorrência", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [1, 2, 1, 3, 2],
    });
    expect(res.output).toEqual({ items: [1, 2, 3], length: 3, removed: 2 });
  });

  test("dedup de objetos compara por JSON (mesmo shape e ordem de chaves)", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [{ a: 1 }, { a: 1 }, { a: 2 }],
    });
    expect(res.output).toEqual({ items: [{ a: 1 }, { a: 2 }], length: 2, removed: 1 });
  });

  test("objetos com mesmas chaves em ordem diferente NÃO são deduplicados", async () => {
    // A key é JSON.stringify, então a ordem de inserção das chaves importa.
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [
        { a: 1, b: 2 },
        { b: 2, a: 1 },
      ],
    });
    expect(res.output.length).toBe(2);
    expect(res.output.removed).toBe(0);
  });

  test("field usa dot-path pra escolher a chave de dedup", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [
        { id: 1, nome: "a" },
        { id: 1, nome: "b" },
        { id: 2, nome: "c" },
      ],
      field: "id",
    });
    expect(res.output).toEqual({
      items: [
        { id: 1, nome: "a" },
        { id: 2, nome: "c" },
      ],
      length: 2,
      removed: 1,
    });
  });

  test("field aceita dot-path aninhado", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [
        { user: { email: "x@y.z" } },
        { user: { email: "x@y.z" } },
        { user: { email: "a@b.c" } },
      ],
      field: "user.email",
    });
    expect(res.output.length).toBe(2);
  });

  test("field ausente em vários itens colapsa todos num único (key 'null')", async () => {
    // JSON.stringify(undefined) === undefined → `?? "null"` cai pra "null",
    // mesma key de um valor literalmente null.
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [{ x: 1 }, { x: 2 }, { id: null }],
      field: "id",
    });
    expect(res.output).toEqual({ items: [{ x: 1 }], length: 1, removed: 2 });
  });

  test("array vazio devolve zeros", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", { items: [] });
    expect(res.output).toEqual({ items: [], length: 0, removed: 0 });
  });

  test("items ausente vira array vazio", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {});
    expect(res.output).toEqual({ items: [], length: 0, removed: 0 });
  });

  test("field não-string é ignorado (dedup pelo item inteiro)", async () => {
    const res = await run(removeDuplicatesHandler, "remove_duplicates", {
      items: [{ id: 1 }, { id: 1 }],
      field: 42,
    });
    expect(res.output.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// rename_keys
// ---------------------------------------------------------------------------

describe("rename_keys", () => {
  test("renomeia chaves de um objeto e mantém as não mapeadas", async () => {
    const res = await run(renameKeysHandler, "rename_keys", {
      data: { nome: "ada", idade: 30 },
      mapping: { nome: "name" },
    });
    expect(res.output).toEqual({ data: { name: "ada", idade: 30 } });
  });

  test("renomeia cada item de um array", async () => {
    const res = await run(renameKeysHandler, "rename_keys", {
      data: [{ a: 1 }, { a: 2 }],
      mapping: { a: "b" },
    });
    expect(res.output).toEqual({ items: [{ b: 1 }, { b: 2 }], length: 2 });
  });

  test("itens não-objeto do array passam intactos", async () => {
    const res = await run(renameKeysHandler, "rename_keys", {
      data: [1, null, { a: 1 }],
      mapping: { a: "b" },
    });
    expect(res.output.items).toEqual([1, null, { b: 1 }]);
  });

  test("mapping vazio devolve o objeto igual", async () => {
    const res = await run(renameKeysHandler, "rename_keys", {
      data: { a: 1 },
      mapping: {},
    });
    expect(res.output).toEqual({ data: { a: 1 } });
  });

  test("mapping ausente lança erro", async () => {
    await expect(run(renameKeysHandler, "rename_keys", { data: { a: 1 } })).rejects.toThrow(
      /obrigatório/i,
    );
  });

  test("mapping null lança erro", async () => {
    await expect(
      run(renameKeysHandler, "rename_keys", { data: { a: 1 }, mapping: null }),
    ).rejects.toThrow(/obrigatório/i);
  });

  test("mapping não-objeto (string) lança erro", async () => {
    await expect(
      run(renameKeysHandler, "rename_keys", { data: { a: 1 }, mapping: "nope" }),
    ).rejects.toThrow(/obrigatório/i);
  });

  test("colisão de destino: a última chave escrita vence (perde dado)", async () => {
    // {a:1,b:2} com mapping {a:"b"} → out.b = 1, depois out.b = 2.
    const res = await run(renameKeysHandler, "rename_keys", {
      data: { a: 1, b: 2 },
      mapping: { a: "b" },
    });
    expect(res.output).toEqual({ data: { b: 2 } });
  });

  test("data primitivo é repassado", async () => {
    const res = await run(renameKeysHandler, "rename_keys", { data: 5, mapping: { a: "b" } });
    expect(res.output).toEqual({ data: 5 });
  });

  test("data null é repassado", async () => {
    const res = await run(renameKeysHandler, "rename_keys", { data: null, mapping: { a: "b" } });
    expect(res.output).toEqual({ data: null });
  });

  test("array vazio devolve items vazio", async () => {
    const res = await run(renameKeysHandler, "rename_keys", { data: [], mapping: { a: "b" } });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("renomeia apenas chaves shallow (não desce em objetos aninhados)", async () => {
    const res = await run(renameKeysHandler, "rename_keys", {
      data: { user: { a: 1 } },
      mapping: { a: "b" },
    });
    expect(res.output).toEqual({ data: { user: { a: 1 } } });
  });
});

// ---------------------------------------------------------------------------
// shuffle
// ---------------------------------------------------------------------------

describe("shuffle", () => {
  test("com seed é determinístico entre execuções", async () => {
    const cfg = { items: [1, 2, 3, 4, 5, 6, 7, 8], seed: 42 };
    const a = await run(shuffleHandler, "shuffle", { ...cfg });
    const b = await run(shuffleHandler, "shuffle", { ...cfg });
    expect(a.output.items).toEqual(b.output.items);
  });

  test("seeds diferentes produzem ordens diferentes", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = await run(shuffleHandler, "shuffle", { items, seed: 1 });
    const b = await run(shuffleHandler, "shuffle", { items, seed: 2 });
    expect(a.output.items).not.toEqual(b.output.items);
  });

  test("resultado é uma permutação — preserva todos os elementos", async () => {
    const items = [1, 2, 3, 4, 5];
    const res = await run(shuffleHandler, "shuffle", { items, seed: 7 });
    expect([...(res.output.items as number[])].sort((x, y) => x - y)).toEqual(items);
    expect(res.output.length).toBe(5);
  });

  test("não muta o array original", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const copia = [...items];
    await run(shuffleHandler, "shuffle", { items, seed: 3 });
    expect(items).toEqual(copia);
  });

  test("array vazio devolve vazio", async () => {
    const res = await run(shuffleHandler, "shuffle", { items: [], seed: 1 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("array de 1 item é devolvido igual", async () => {
    const res = await run(shuffleHandler, "shuffle", { items: ["só"], seed: 1 });
    expect(res.output).toEqual({ items: ["só"], length: 1 });
  });

  test("items ausente vira array vazio", async () => {
    const res = await run(shuffleHandler, "shuffle", { seed: 1 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("seed não-numérico cai no Math.random (ainda é permutação)", async () => {
    const items = [1, 2, 3, 4, 5];
    const res = await run(shuffleHandler, "shuffle", { items, seed: "42" });
    expect([...(res.output.items as number[])].sort((x, y) => x - y)).toEqual(items);
  });

  test("seed 0 é aceito (0 é number, não cai no fallback)", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = await run(shuffleHandler, "shuffle", { items, seed: 0 });
    const b = await run(shuffleHandler, "shuffle", { items, seed: 0 });
    expect(a.output.items).toEqual(b.output.items);
  });
});

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

describe("sort", () => {
  test("ordena números ascendente por padrão", async () => {
    const res = await run(sortHandler, "sort", { items: [3, 1, 2] });
    expect(res.output).toEqual({ items: [1, 2, 3], length: 3 });
  });

  test("order desc inverte", async () => {
    const res = await run(sortHandler, "sort", { items: [3, 1, 2], order: "desc" });
    expect(res.output.items).toEqual([3, 2, 1]);
  });

  test("order desconhecido é tratado como asc", async () => {
    const res = await run(sortHandler, "sort", { items: [3, 1, 2], order: "qualquer" });
    expect(res.output.items).toEqual([1, 2, 3]);
  });

  test("ordena strings por localeCompare", async () => {
    const res = await run(sortHandler, "sort", { items: ["banana", "abacaxi", "cereja"] });
    expect(res.output.items).toEqual(["abacaxi", "banana", "cereja"]);
  });

  test("field ordena por dot-path", async () => {
    const res = await run(sortHandler, "sort", {
      items: [{ n: 3 }, { n: 1 }, { n: 2 }],
      field: "n",
    });
    expect(res.output.items).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  test("field aninhado funciona", async () => {
    const res = await run(sortHandler, "sort", {
      items: [{ u: { idade: 30 } }, { u: { idade: 20 } }],
      field: "u.idade",
    });
    expect(res.output.items).toEqual([{ u: { idade: 20 } }, { u: { idade: 30 } }]);
  });

  test("null/undefined vão pra frente no asc", async () => {
    const res = await run(sortHandler, "sort", { items: [2, null, 1] });
    expect(res.output.items).toEqual([null, 1, 2]);
  });

  test("null vai pro fim no desc", async () => {
    const res = await run(sortHandler, "sort", { items: [2, null, 1], order: "desc" });
    expect(res.output.items).toEqual([2, 1, null]);
  });

  test("tipos mistos caem em comparação de string", async () => {
    // 10 vs "9": não são ambos number → String("10").localeCompare("9") < 0.
    const res = await run(sortHandler, "sort", { items: ["9", 10] });
    expect(res.output.items).toEqual([10, "9"]);
  });

  test("itens sem o field (undefined) vão pra frente no asc", async () => {
    const res = await run(sortHandler, "sort", { items: [{ n: 2 }, { outro: 1 }], field: "n" });
    expect(res.output.items).toEqual([{ outro: 1 }, { n: 2 }]);
  });

  test("array vazio", async () => {
    const res = await run(sortHandler, "sort", { items: [] });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("items ausente vira vazio", async () => {
    const res = await run(sortHandler, "sort", {});
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("não muta o array original", async () => {
    const items = [3, 1, 2];
    await run(sortHandler, "sort", { items });
    expect(items).toEqual([3, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
// split_out
// ---------------------------------------------------------------------------

describe("split_out", () => {
  test("sem field repassa items como estão", async () => {
    const res = await run(splitOutHandler, "split_out", { items: [1, 2, 3] });
    expect(res.output).toEqual({ items: [1, 2, 3], length: 3 });
  });

  test("field achata os arrays internos", async () => {
    const res = await run(splitOutHandler, "split_out", {
      items: [{ tags: ["a", "b"] }, { tags: ["c"] }],
      field: "tags",
    });
    expect(res.output).toEqual({ items: ["a", "b", "c"], length: 3 });
  });

  test("field apontando pra valor escalar empurra o valor cru", async () => {
    const res = await run(splitOutHandler, "split_out", {
      items: [{ v: 1 }, { v: 2 }],
      field: "v",
    });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("itens sem o field são pulados", async () => {
    const res = await run(splitOutHandler, "split_out", {
      items: [{ tags: ["a"] }, { outro: 1 }, { tags: ["b"] }],
      field: "tags",
    });
    expect(res.output).toEqual({ items: ["a", "b"], length: 2 });
  });

  test("field com valor null é empurrado (null !== undefined)", async () => {
    const res = await run(splitOutHandler, "split_out", { items: [{ v: null }], field: "v" });
    expect(res.output).toEqual({ items: [null], length: 1 });
  });

  test("array interno vazio não contribui com nada", async () => {
    const res = await run(splitOutHandler, "split_out", {
      items: [{ tags: [] }, { tags: ["x"] }],
      field: "tags",
    });
    expect(res.output).toEqual({ items: ["x"], length: 1 });
  });

  test("field aninhado por dot-path", async () => {
    const res = await run(splitOutHandler, "split_out", {
      items: [{ d: { list: [1, 2] } }],
      field: "d.list",
    });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("itens primitivos com field são pulados", async () => {
    const res = await run(splitOutHandler, "split_out", { items: [1, "x", null], field: "v" });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("array vazio", async () => {
    const res = await run(splitOutHandler, "split_out", { items: [], field: "tags" });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("items ausente vira vazio", async () => {
    const res = await run(splitOutHandler, "split_out", {});
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("achatamento é de um nível só", async () => {
    const res = await run(splitOutHandler, "split_out", {
      items: [{ t: [[1, 2], [3]] }],
      field: "t",
    });
    expect(res.output.items).toEqual([[1, 2], [3]]);
  });
});

// ---------------------------------------------------------------------------
// split_in_batches
// ---------------------------------------------------------------------------

describe("split_in_batches", () => {
  test("itera em lotes e emite label 'loop' até esgotar, depois 'done'", async () => {
    const context = ctx();
    const cfg = { items: [1, 2, 3, 4, 5], batchSize: 2 };

    const r1 = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(r1.nextLabel).toBe("loop");
    expect(r1.output).toEqual({ batch: [1, 2], batchIndex: 0, cursor: 2, total: 5, done: false });

    const r2 = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(r2.output).toEqual({ batch: [3, 4], batchIndex: 1, cursor: 4, total: 5, done: false });

    const r3 = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(r3.output).toEqual({ batch: [5], batchIndex: 2, cursor: 6, total: 5, done: false });

    const r4 = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(r4.nextLabel).toBe("done");
    expect(r4.output).toEqual({ done: true, total: 5 });
  });

  test("batchSize default é 1", async () => {
    const context = ctx();
    const r1 = await run(splitInBatchesHandler, "split_in_batches", { items: ["a", "b"] }, context);
    expect(r1.output.batch).toEqual(["a"]);
    expect(r1.output.cursor).toBe(1);
  });

  test("batchSize 0 ou negativo cai pro default 1", async () => {
    const zero = await run(splitInBatchesHandler, "split_in_batches", {
      items: [1, 2],
      batchSize: 0,
    });
    expect(zero.output.batch).toEqual([1]);

    const neg = await run(splitInBatchesHandler, "split_in_batches", {
      items: [1, 2],
      batchSize: -3,
    });
    expect(neg.output.batch).toEqual([1]);
  });

  test("batchSize fracionário é truncado", async () => {
    const res = await run(splitInBatchesHandler, "split_in_batches", {
      items: [1, 2, 3, 4],
      batchSize: 2.9,
    });
    expect(res.output.batch).toEqual([1, 2]);
  });

  test("batchSize não-numérico cai pro default 1", async () => {
    const res = await run(splitInBatchesHandler, "split_in_batches", {
      items: [1, 2],
      batchSize: "2",
    });
    expect(res.output.batch).toEqual([1]);
  });

  test("batchSize maior que o array devolve tudo num lote só", async () => {
    const res = await run(splitInBatchesHandler, "split_in_batches", {
      items: [1, 2],
      batchSize: 99,
    });
    expect(res.output.batch).toEqual([1, 2]);
    expect(res.output.cursor).toBe(99);
  });

  test("array vazio vai direto pra 'done'", async () => {
    const res = await run(splitInBatchesHandler, "split_in_batches", { items: [] });
    expect(res.nextLabel).toBe("done");
    expect(res.output).toEqual({ done: true, total: 0 });
  });

  test("items resolvido por template é snapshotado só na primeira visita", async () => {
    const context = ctx({ vars: { lista: [1, 2, 3] } });
    const cfg = { items: "{{ vars.lista }}", batchSize: 1 };

    const r1 = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(r1.output.batch).toEqual([1]);

    // Trocar a fonte no meio do loop não afeta o snapshot já capturado.
    context.vars.lista = ["x", "y", "z", "w"];
    const r2 = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(r2.output.batch).toEqual([2]);
    expect(r2.output.total).toBe(3);
  });

  test("state é limpo ao concluir, permitindo reuso do nó", async () => {
    const context = ctx();
    const cfg = { items: [1] };

    await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    const done = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(done.nextLabel).toBe("done");
    expect(context.loopState).toEqual({});

    // Nova rodada recomeça do zero.
    const again = await run(splitInBatchesHandler, "split_in_batches", cfg, context);
    expect(again.nextLabel).toBe("loop");
    expect(again.output.batch).toEqual([1]);
  });

  test("items que não resolve pra array lança erro", async () => {
    await expect(
      run(splitInBatchesHandler, "split_in_batches", { items: { a: 1 } }),
    ).rejects.toThrow(/precisa resolver pra um array/i);
  });

  test("items ausente lança erro", async () => {
    await expect(run(splitInBatchesHandler, "split_in_batches", {})).rejects.toThrow(
      /precisa resolver pra um array/i,
    );
  });

  test("array acima de 10.000 itens lança erro", async () => {
    const items = Array.from({ length: 10_001 }, () => 0);
    await expect(run(splitInBatchesHandler, "split_in_batches", { items })).rejects.toThrow(
      /excede o limite 10000/i,
    );
  });

  test("exatamente 10.000 itens é aceito", async () => {
    const items = Array.from({ length: 10_000 }, () => 0);
    const res = await run(splitInBatchesHandler, "split_in_batches", { items });
    expect(res.output.total).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe("merge", () => {
  test("append concatena a e b (modo default)", async () => {
    const res = await run(mergeHandler, "merge", { a: [1, 2], b: [3] });
    expect(res.output).toEqual({ items: [1, 2, 3], length: 3 });
  });

  test("append explícito", async () => {
    const res = await run(mergeHandler, "merge", { a: ["x"], b: ["y"], mode: "append" });
    expect(res.output).toEqual({ items: ["x", "y"], length: 2 });
  });

  test("append com ambos vazios", async () => {
    const res = await run(mergeHandler, "merge", { a: [], b: [] });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("append com a e b ausentes vira vazio", async () => {
    const res = await run(mergeHandler, "merge", {});
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("merge_by_key faz shallow merge com b sobrescrevendo a", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [
        { id: 1, nome: "ada", extra: "keep" },
        { id: 2, nome: "bob" },
      ],
      b: [{ id: 1, nome: "ADA" }],
      mode: "merge_by_key",
      key: "id",
    });
    expect(res.output).toEqual({
      items: [
        { id: 1, nome: "ADA", extra: "keep" },
        { id: 2, nome: "bob" },
      ],
      length: 2,
    });
  });

  test("merge_by_key acrescenta itens de b sem match no fim", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [{ id: 1 }],
      b: [{ id: 2, novo: true }],
      mode: "merge_by_key",
      key: "id",
    });
    expect(res.output.items).toEqual([{ id: 1 }, { id: 2, novo: true }]);
  });

  test("merge_by_key com key aninhada", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [{ u: { id: 1 }, v: "a" }],
      b: [{ u: { id: 1 }, v: "b" }],
      mode: "merge_by_key",
      key: "u.id",
    });
    expect(res.output.items).toEqual([{ u: { id: 1 }, v: "b" }]);
  });

  test("merge_by_key: itens não-objeto de `a` passam intactos", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [1, { id: 1 }],
      b: [{ id: 1, x: 9 }],
      mode: "merge_by_key",
      key: "id",
    });
    expect(res.output.items).toEqual([1, { id: 1, x: 9 }]);
  });

  test("merge_by_key: itens não-objeto de `b` são ignorados no índice", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [{ id: 1 }],
      b: [42, "txt"],
      mode: "merge_by_key",
      key: "id",
    });
    expect(res.output.items).toEqual([{ id: 1 }]);
  });

  test("merge_by_key: chaves duplicadas em b — a última vence no índice", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [{ id: 1 }],
      b: [
        { id: 1, v: "primeiro" },
        { id: 1, v: "segundo" },
      ],
      mode: "merge_by_key",
      key: "id",
    });
    expect(res.output.items).toEqual([{ id: 1, v: "segundo" }]);
  });

  test("merge_by_key: itens sem a key colidem na chave 'null'", async () => {
    const res = await run(mergeHandler, "merge", {
      a: [{ x: 1 }],
      b: [{ y: 2 }],
      mode: "merge_by_key",
      key: "id",
    });
    // Ambos resolvem pra `null` → dão match entre si.
    expect(res.output.items).toEqual([{ x: 1, y: 2 }]);
  });

  test("merge_by_key sem key lança erro", async () => {
    await expect(
      run(mergeHandler, "merge", { a: [], b: [], mode: "merge_by_key" }),
    ).rejects.toThrow(/`key` é obrigatório/i);
  });

  test("merge_by_key com key string vazia lança erro", async () => {
    await expect(
      run(mergeHandler, "merge", { a: [], b: [], mode: "merge_by_key", key: "" }),
    ).rejects.toThrow(/`key` é obrigatório/i);
  });

  test("mode desconhecido lança erro", async () => {
    await expect(run(mergeHandler, "merge", { a: [], b: [], mode: "xpto" })).rejects.toThrow(
      /mode "xpto" não suportado/i,
    );
  });

  test("a/b não-array viram vazio", async () => {
    const res = await run(mergeHandler, "merge", { a: "nope", b: { k: 1 } });
    expect(res.output).toEqual({ items: [], length: 0 });
  });
});

// ---------------------------------------------------------------------------
// item_lists
// ---------------------------------------------------------------------------

describe("item_lists", () => {
  test("length conta os itens", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "length",
      items: [1, 2, 3],
    });
    expect(res.output).toEqual({ length: 3 });
  });

  test("length com items ausente devolve 0", async () => {
    const res = await run(itemListsHandler, "item_lists", { operation: "length" });
    expect(res.output).toEqual({ length: 0 });
  });

  test("reverse inverte sem mutar e sem devolver length", async () => {
    const items = [1, 2, 3];
    const res = await run(itemListsHandler, "item_lists", { operation: "reverse", items });
    expect(res.output).toEqual({ items: [3, 2, 1] });
    expect(items).toEqual([1, 2, 3]);
  });

  test("filter eq é o comparador default", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items: [{ s: "ok" }, { s: "no" }],
      field: "s",
      value: "ok",
    });
    expect(res.output).toEqual({ items: [{ s: "ok" }], length: 1 });
  });

  test("filter neq", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items: [1, 2, 3],
      op: "neq",
      value: 2,
    });
    expect(res.output.items).toEqual([1, 3]);
  });

  test("filter gt / gte / lt / lte comparam numericamente", async () => {
    const items = [1, 2, 3];
    const gt = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items,
      op: "gt",
      value: 2,
    });
    expect(gt.output.items).toEqual([3]);

    const gte = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items,
      op: "gte",
      value: 2,
    });
    expect(gte.output.items).toEqual([2, 3]);

    const lt = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items,
      op: "lt",
      value: 2,
    });
    expect(lt.output.items).toEqual([1]);

    const lte = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items,
      op: "lte",
      value: 2,
    });
    expect(lte.output.items).toEqual([1, 2]);
  });

  test("filter contains casa substring", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items: ["abacaxi", "banana"],
      op: "contains",
      value: "aba",
    });
    expect(res.output.items).toEqual(["abacaxi"]);
  });

  test("filter truthy/falsy são unários (ignoram value)", async () => {
    const items = [0, 1, "", "x", null];
    const truthy = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items,
      op: "truthy",
    });
    expect(truthy.output.items).toEqual([1, "x"]);

    const falsy = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items,
      op: "falsy",
    });
    expect(falsy.output.items).toEqual([0, "", null]);
  });

  test("filter com op inválido lança erro", async () => {
    await expect(
      run(itemListsHandler, "item_lists", { operation: "filter", items: [], op: "regex" }),
    ).rejects.toThrow(/op "regex" inválido/i);
  });

  test("filter sem field compara o item inteiro", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "filter",
      items: ["a", "b"],
      value: "a",
    });
    expect(res.output.items).toEqual(["a"]);
  });

  test("sort asc/desc e não devolve length", async () => {
    const asc = await run(itemListsHandler, "item_lists", { operation: "sort", items: [3, 1, 2] });
    expect(asc.output).toEqual({ items: [1, 2, 3] });

    const desc = await run(itemListsHandler, "item_lists", {
      operation: "sort",
      items: [3, 1, 2],
      order: "desc",
    });
    expect(desc.output).toEqual({ items: [3, 2, 1] });
  });

  test("sort por field aninhado", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "sort",
      items: [{ u: { n: 2 } }, { u: { n: 1 } }],
      field: "u.n",
    });
    expect(res.output.items).toEqual([{ u: { n: 1 } }, { u: { n: 2 } }]);
  });

  test("slice com start e end", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "slice",
      items: [1, 2, 3, 4, 5],
      start: 1,
      end: 3,
    });
    expect(res.output).toEqual({ items: [2, 3], length: 2 });
  });

  test("slice sem start/end devolve tudo", async () => {
    const res = await run(itemListsHandler, "item_lists", { operation: "slice", items: [1, 2] });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("slice com start negativo conta do fim", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "slice",
      items: [1, 2, 3],
      start: -2,
    });
    expect(res.output.items).toEqual([2, 3]);
  });

  test("slice com start/end não-numéricos usa os defaults", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "slice",
      items: [1, 2, 3],
      start: "1",
      end: "2",
    });
    expect(res.output.items).toEqual([1, 2, 3]);
  });

  test("distinct sem field dedup pelo item", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "distinct",
      items: [1, 1, 2],
    });
    expect(res.output).toEqual({ items: [1, 2], length: 2 });
  });

  test("distinct com field mantém a primeira ocorrência", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "distinct",
      items: [
        { id: 1, v: "a" },
        { id: 1, v: "b" },
        { id: 2, v: "c" },
      ],
      field: "id",
    });
    expect(res.output.items).toEqual([
      { id: 1, v: "a" },
      { id: 2, v: "c" },
    ]);
  });

  test("distinct trata undefined e null como a mesma chave", async () => {
    const res = await run(itemListsHandler, "item_lists", {
      operation: "distinct",
      items: [{ id: null }, { outro: 1 }],
      field: "id",
    });
    expect(res.output.length).toBe(1);
  });

  test("operation ausente lança erro", async () => {
    await expect(run(itemListsHandler, "item_lists", { items: [] })).rejects.toThrow(
      /operation "undefined" não suportada/i,
    );
  });

  test("operation desconhecida lança erro", async () => {
    await expect(
      run(itemListsHandler, "item_lists", { operation: "explodir", items: [] }),
    ).rejects.toThrow(/operation "explodir" não suportada/i);
  });
});

// ---------------------------------------------------------------------------
// aggregate
// ---------------------------------------------------------------------------

describe("aggregate", () => {
  test("count conta itens", async () => {
    const res = await run(aggregateHandler, "aggregate", { operation: "count", items: [1, 2, 3] });
    expect(res.output).toEqual({ count: 3 });
  });

  test("count com items ausente devolve 0", async () => {
    const res = await run(aggregateHandler, "aggregate", { operation: "count" });
    expect(res.output).toEqual({ count: 0 });
  });

  test("sum soma o field", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "sum",
      items: [{ v: 1 }, { v: 2 }, { v: 3 }],
      field: "v",
    });
    expect(res.output).toEqual({ sum: 6 });
  });

  test("sum trata valores não-numéricos como 0", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "sum",
      items: [{ v: 1 }, { v: "abc" }, { v: null }, { outro: 1 }],
      field: "v",
    });
    expect(res.output).toEqual({ sum: 1 });
  });

  test("sum coage strings numéricas", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "sum",
      items: [{ v: "10" }, { v: "5" }],
      field: "v",
    });
    expect(res.output).toEqual({ sum: 15 });
  });

  test("avg devolve avg, count e sum", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "avg",
      items: [{ v: 2 }, { v: 4 }],
      field: "v",
    });
    expect(res.output).toEqual({ avg: 3, count: 2, sum: 6 });
  });

  test("avg de array vazio devolve zeros (não NaN)", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "avg",
      items: [],
      field: "v",
    });
    expect(res.output).toEqual({ avg: 0, count: 0, sum: 0 });
  });

  test("min e max", async () => {
    const min = await run(aggregateHandler, "aggregate", {
      operation: "min",
      items: [{ v: 5 }, { v: 2 }],
      field: "v",
    });
    expect(min.output).toEqual({ min: 2 });

    const max = await run(aggregateHandler, "aggregate", {
      operation: "max",
      items: [{ v: 5 }, { v: 2 }],
      field: "v",
    });
    expect(max.output).toEqual({ max: 5 });
  });

  test("min/max de array vazio devolvem 0 (não ±Infinity)", async () => {
    const min = await run(aggregateHandler, "aggregate", {
      operation: "min",
      items: [],
      field: "v",
    });
    expect(min.output).toEqual({ min: 0 });

    const max = await run(aggregateHandler, "aggregate", {
      operation: "max",
      items: [],
      field: "v",
    });
    expect(max.output).toEqual({ max: 0 });
  });

  test("field aninhado por dot-path", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "sum",
      items: [{ u: { v: 1 } }, { u: { v: 2 } }],
      field: "u.v",
    });
    expect(res.output).toEqual({ sum: 3 });
  });

  test.each(["sum", "avg", "min", "max"])("%s sem field lança erro", async (op) => {
    await expect(run(aggregateHandler, "aggregate", { operation: op, items: [] })).rejects.toThrow(
      /config\.field é obrigatório/i,
    );
  });

  test("field string vazia conta como ausente e lança erro", async () => {
    await expect(
      run(aggregateHandler, "aggregate", { operation: "sum", items: [], field: "" }),
    ).rejects.toThrow(/config\.field é obrigatório/i);
  });

  test("group_by agrupa e conta", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [
        { dept: "eng", s: 10 },
        { dept: "eng", s: 20 },
        { dept: "rh", s: 5 },
      ],
      by: "dept",
    });
    expect(res.output).toEqual({
      groups: [
        { key: "eng", count: 2 },
        { key: "rh", count: 1 },
      ],
      length: 2,
    });
  });

  test("group_by com aggs aplica as reduções por grupo", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [
        { dept: "eng", s: 10 },
        { dept: "eng", s: 20 },
        { dept: "rh", s: 5 },
      ],
      by: "dept",
      aggs: {
        total: { op: "sum", field: "s" },
        media: { op: "avg", field: "s" },
        maior: { op: "max", field: "s" },
        quantos: { op: "count" },
      },
    });
    expect(res.output.groups).toEqual([
      { key: "eng", count: 2, total: 30, media: 15, maior: 20, quantos: 2 },
      { key: "rh", count: 1, total: 5, media: 5, maior: 5, quantos: 1 },
    ]);
  });

  test("group_by preserva o tipo da chave", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [{ k: 1 }, { k: 1 }, { k: "1" }],
      by: "k",
    });
    // JSON.stringify(1) = "1" e JSON.stringify("1") = '"1"' → buckets distintos.
    expect(res.output.groups).toEqual([
      { key: 1, count: 2 },
      { key: "1", count: 1 },
    ]);
  });

  test("group_by trata chave ausente como null", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [{ outro: 1 }, { k: null }],
      by: "k",
    });
    expect(res.output.groups).toEqual([{ key: undefined, count: 2 }]);
  });

  test("group_by de array vazio devolve groups vazio", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [],
      by: "k",
    });
    expect(res.output).toEqual({ groups: [], length: 0 });
  });

  test("group_by sem `by` lança erro", async () => {
    await expect(
      run(aggregateHandler, "aggregate", { operation: "group_by", items: [] }),
    ).rejects.toThrow(/config\.by é obrigatório/i);
  });

  test("agg spec inválida é pulada silenciosamente", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [{ k: "a" }],
      by: "k",
      aggs: { ruim: { field: "x" }, pior: null, terrivel: "nope" },
    });
    expect(res.output.groups).toEqual([{ key: "a", count: 1 }]);
  });

  test("agg com op != count e sem field devolve 0", async () => {
    const res = await run(aggregateHandler, "aggregate", {
      operation: "group_by",
      items: [{ k: "a", v: 9 }],
      by: "k",
      aggs: { t: { op: "sum" } },
    });
    expect(res.output.groups).toEqual([{ key: "a", count: 1, t: 0 }]);
  });

  test("operation desconhecida lança erro", async () => {
    await expect(
      run(aggregateHandler, "aggregate", { operation: "mediana", items: [] }),
    ).rejects.toThrow(/operation "mediana" não suportada/i);
  });
});

// ---------------------------------------------------------------------------
// filter
// ---------------------------------------------------------------------------

describe("filter — modo array (legado)", () => {
  test("eq filtra por field", async () => {
    const res = await run(filterHandler, "filter", {
      items: [{ s: "ok" }, { s: "no" }],
      op: "eq",
      field: "s",
      value: "ok",
    });
    expect(res.output).toEqual({ items: [{ s: "ok" }], length: 1 });
  });

  test("sem field compara o item inteiro", async () => {
    const res = await run(filterHandler, "filter", { items: [1, 2], op: "eq", value: 2 });
    expect(res.output.items).toEqual([2]);
  });

  test("op default é truthy (que também descarta vazios)", async () => {
    const res = await run(filterHandler, "filter", { items: [0, 1, "", "x", [], {}, null] });
    expect(res.output.items).toEqual([1, "x"]);
  });

  test("notEmpty / isEmpty", async () => {
    const items = ["", "  ", "x", [], [1], {}, { a: 1 }, null, undefined, 0];
    const notEmpty = await run(filterHandler, "filter", { items, op: "notEmpty" });
    expect(notEmpty.output.items).toEqual(["x", [1], { a: 1 }, 0]);

    const isEmpty = await run(filterHandler, "filter", { items, op: "isEmpty" });
    expect(isEmpty.output.items).toEqual(["", "  ", [], {}, null, undefined]);
  });

  test("contains em array", async () => {
    const res = await run(filterHandler, "filter", {
      items: ["abacaxi", "banana"],
      op: "contains",
      value: "ban",
    });
    expect(res.output.items).toEqual(["banana"]);
  });

  test("gt em array", async () => {
    const res = await run(filterHandler, "filter", { items: [1, 5, 9], op: "gt", value: 4 });
    expect(res.output.items).toEqual([5, 9]);
  });

  test("array vazio", async () => {
    const res = await run(filterHandler, "filter", { items: [], op: "eq", value: 1 });
    expect(res.output).toEqual({ items: [], length: 0 });
  });

  test("op inválido lança erro antes de qualquer coisa", async () => {
    await expect(run(filterHandler, "filter", { items: [], op: "regex" })).rejects.toThrow(
      /op "regex" inválido/i,
    );
  });
});

describe("filter — modo n8n (single item)", () => {
  test("condição verdadeira emite nextLabel 'true' e preserva prev", async () => {
    const res = await run(
      filterHandler,
      "filter",
      { left: "{{ prev.status }}", op: "eq", right: "ok" },
      ctx({ prev: { status: "ok", id: 7 } }),
    );
    expect(res.nextLabel).toBe("true");
    expect(res.output).toEqual({
      _filter: { passed: true, op: "eq", left: "ok", right: "ok" },
      status: "ok",
      id: 7,
    });
  });

  test("condição falsa emite nextLabel 'false' mas ainda preserva prev", async () => {
    const res = await run(
      filterHandler,
      "filter",
      { left: "{{ prev.status }}", op: "eq", right: "ok" },
      ctx({ prev: { status: "erro" } }),
    );
    expect(res.nextLabel).toBe("false");
    expect(res.output).toEqual({
      _filter: { passed: false, op: "eq", left: "erro", right: "ok" },
      status: "erro",
    });
  });

  test("`value` funciona como alias de `right`", async () => {
    const res = await run(filterHandler, "filter", { left: 5, op: "gte", value: 5 });
    expect(res.nextLabel).toBe("true");
  });

  test("`right` tem precedência sobre `value`", async () => {
    const res = await run(filterHandler, "filter", { left: 5, op: "eq", right: 5, value: 99 });
    expect((res.output._filter as Record<string, unknown>).right).toBe(5);
    expect(res.nextLabel).toBe("true");
  });

  test("op default truthy avalia `left`", async () => {
    const passa = await run(filterHandler, "filter", { left: "algo" });
    expect(passa.nextLabel).toBe("true");

    const falha = await run(filterHandler, "filter", { left: "" });
    expect(falha.nextLabel).toBe("false");
  });

  test("left ausente com truthy reprova", async () => {
    const res = await run(filterHandler, "filter", {});
    expect(res.nextLabel).toBe("false");
    expect(res.output._filter).toEqual({
      passed: false,
      op: "truthy",
      left: undefined,
      right: undefined,
    });
  });

  test("prev não-objeto resulta em output só com _filter", async () => {
    const res = await run(
      filterHandler,
      "filter",
      { left: 1, op: "truthy" },
      ctx({ prev: undefined }),
    );
    expect(res.output).toEqual({
      _filter: { passed: true, op: "truthy", left: 1, right: undefined },
    });
  });

  test("truthy trata objeto/array vazio como falso (diferente do JS puro)", async () => {
    const arr = await run(filterHandler, "filter", { left: [], op: "truthy" });
    expect(arr.nextLabel).toBe("false");

    const obj = await run(filterHandler, "filter", { left: {}, op: "truthy" });
    expect(obj.nextLabel).toBe("false");
  });

  test("notEmpty/isEmpty em single mode", async () => {
    const notEmpty = await run(filterHandler, "filter", { left: "  ", op: "notEmpty" });
    expect(notEmpty.nextLabel).toBe("false");

    const isEmpty = await run(filterHandler, "filter", { left: null, op: "isEmpty" });
    expect(isEmpty.nextLabel).toBe("true");
  });

  test("items não-array cai no modo single (não no modo array)", async () => {
    const res = await run(filterHandler, "filter", { items: "nope", left: 1, op: "truthy" });
    expect(res.nextLabel).toBe("true");
    expect(res.output._filter).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// compare_datasets
// ---------------------------------------------------------------------------

describe("compare_datasets", () => {
  test("classifica added, removed, changed e equal", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [
        { id: 1, v: "x" },
        { id: 2, v: "y" },
        { id: 3, v: "z" },
      ],
      b: [
        { id: 1, v: "x" },
        { id: 2, v: "MUDOU" },
        { id: 4, v: "novo" },
      ],
      key: "id",
    });
    expect(res.output.added).toEqual([{ id: 4, v: "novo" }]);
    expect(res.output.removed).toEqual([{ id: 3, v: "z" }]);
    expect(res.output.changed).toEqual([
      { key: 2, before: { id: 2, v: "y" }, after: { id: 2, v: "MUDOU" } },
    ]);
    expect(res.output.equal).toEqual([{ id: 1, v: "x" }]);
  });

  test("datasets idênticos → tudo em equal", async () => {
    const linhas = [{ id: 1 }, { id: 2 }];
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: linhas,
      b: linhas,
      key: "id",
    });
    expect(res.output).toEqual({ added: [], removed: [], changed: [], equal: linhas });
  });

  test("a vazio → tudo added", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [],
      b: [{ id: 1 }],
      key: "id",
    });
    expect(res.output.added).toEqual([{ id: 1 }]);
    expect(res.output.removed).toEqual([]);
  });

  test("b vazio → tudo removed", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [{ id: 1 }],
      b: [],
      key: "id",
    });
    expect(res.output.removed).toEqual([{ id: 1 }]);
    expect(res.output.added).toEqual([]);
  });

  test("ambos vazios devolve tudo vazio", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", { a: [], b: [], key: "id" });
    expect(res.output).toEqual({ added: [], removed: [], changed: [], equal: [] });
  });

  test("a/b ausentes viram arrays vazios", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", { key: "id" });
    expect(res.output).toEqual({ added: [], removed: [], changed: [], equal: [] });
  });

  test("key aninhada por dot-path", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [{ u: { id: 1 }, v: 1 }],
      b: [{ u: { id: 1 }, v: 2 }],
      key: "u.id",
    });
    expect(res.output.changed).toEqual([
      { key: 1, before: { u: { id: 1 }, v: 1 }, after: { u: { id: 1 }, v: 2 } },
    ]);
  });

  test("key string preservada no changed", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [{ id: "abc", v: 1 }],
      b: [{ id: "abc", v: 2 }],
      key: "id",
    });
    expect((res.output.changed as { key: unknown }[])[0]!.key).toBe("abc");
  });

  test("duplicatas de key: a última ocorrência vence o índice", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [
        { id: 1, v: "primeiro" },
        { id: 1, v: "segundo" },
      ],
      b: [{ id: 1, v: "segundo" }],
      key: "id",
    });
    expect(res.output.equal).toEqual([{ id: 1, v: "segundo" }]);
  });

  test("key ausente lança erro", async () => {
    await expect(run(compareDatasetsHandler, "compare_datasets", { a: [], b: [] })).rejects.toThrow(
      /`key` é obrigatório/i,
    );
  });

  test("key string vazia lança erro", async () => {
    await expect(
      run(compareDatasetsHandler, "compare_datasets", { a: [], b: [], key: "" }),
    ).rejects.toThrow(/`key` é obrigatório/i);
  });

  test("key não-string lança erro", async () => {
    await expect(
      run(compareDatasetsHandler, "compare_datasets", { a: [], b: [], key: 42 }),
    ).rejects.toThrow(/`key` é obrigatório/i);
  });

  test("itens sem a key colidem todos na chave null", async () => {
    const res = await run(compareDatasetsHandler, "compare_datasets", {
      a: [{ x: 1 }, { x: 2 }],
      b: [{ x: 2 }],
      key: "id",
    });
    // Ambos os lados colapsam num único bucket "null"; o último de `a` é {x:2}.
    expect(res.output.equal).toEqual([{ x: 2 }]);
    expect(res.output.added).toEqual([]);
    expect(res.output.removed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// uuid
// ---------------------------------------------------------------------------

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

describe("uuid", () => {
  test("default gera um v4 válido em { uuid }", async () => {
    const res = await run(uuidHandler, "uuid", {});
    expect(res.output.uuid).toMatch(UUID_V4_RE);
  });

  test("version v4 explícito", async () => {
    const res = await run(uuidHandler, "uuid", { version: "v4" });
    expect(res.output.uuid).toMatch(UUID_V4_RE);
  });

  test("chamadas sucessivas geram valores diferentes", async () => {
    const a = await run(uuidHandler, "uuid", {});
    const b = await run(uuidHandler, "uuid", {});
    expect(a.output.uuid).not.toBe(b.output.uuid);
  });

  test("version nil devolve o UUID zerado", async () => {
    const res = await run(uuidHandler, "uuid", { version: "nil" });
    expect(res.output.uuid).toBe(NIL_UUID);
  });

  test("version desconhecida cai pro v4", async () => {
    const res = await run(uuidHandler, "uuid", { version: "v7" });
    expect(res.output.uuid).toMatch(UUID_V4_RE);
  });

  test("count > 1 devolve values com N uuids únicos", async () => {
    const res = await run(uuidHandler, "uuid", { count: 3 });
    const values = res.output.values as string[];
    expect(values).toHaveLength(3);
    for (const v of values) expect(v).toMatch(UUID_V4_RE);
    expect(new Set(values).size).toBe(3);
    expect(res.output.uuid).toBeUndefined();
  });

  test("count 1 devolve { uuid } e não { values }", async () => {
    const res = await run(uuidHandler, "uuid", { count: 1 });
    expect(res.output.uuid).toMatch(UUID_V4_RE);
    expect(res.output.values).toBeUndefined();
  });

  test("count 0 cai pro default 1", async () => {
    const res = await run(uuidHandler, "uuid", { count: 0 });
    expect(res.output.uuid).toMatch(UUID_V4_RE);
  });

  test("count negativo cai pro default 1", async () => {
    const res = await run(uuidHandler, "uuid", { count: -5 });
    expect(res.output.uuid).toMatch(UUID_V4_RE);
  });

  test("count não-numérico cai pro default 1", async () => {
    const res = await run(uuidHandler, "uuid", { count: "3" });
    expect(res.output.uuid).toMatch(UUID_V4_RE);
  });

  test("count é limitado a 1000", async () => {
    const res = await run(uuidHandler, "uuid", { count: 5000 });
    expect(res.output.values).toHaveLength(1000);
  });

  test("count nil > 1 repete o UUID zerado", async () => {
    const res = await run(uuidHandler, "uuid", { version: "nil", count: 2 });
    expect(res.output.values).toEqual([NIL_UUID, NIL_UUID]);
  });
});

// ---------------------------------------------------------------------------
// random
//
// Obs.: o nó `random` NÃO expõe opção `seed` — ele usa node:crypto/Math.random.
// Onde precisamos de determinismo, restringimos o espaço amostral (ex.:
// intervalo de 1 valor, alfabeto de 1 caractere) em vez de semear.
// ---------------------------------------------------------------------------

describe("random", () => {
  test("integer respeita [min, max) e devolve inteiro", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await run(randomHandler, "random", { type: "integer", min: 5, max: 10 });
      const v = res.output.value as number;
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThan(10);
    }
  });

  test("integer com intervalo de 1 valor é determinístico (max exclusivo)", async () => {
    const res = await run(randomHandler, "random", { type: "integer", min: 7, max: 8 });
    expect(res.output.value).toBe(7);
  });

  test("integer usa defaults min=0 max=100", async () => {
    const res = await run(randomHandler, "random", { type: "integer" });
    const v = res.output.value as number;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(100);
  });

  test("integer trunca min/max fracionários", async () => {
    const res = await run(randomHandler, "random", { type: "integer", min: 3.9, max: 4.9 });
    expect(res.output.value).toBe(3);
  });

  test("integer aceita min negativo", async () => {
    const res = await run(randomHandler, "random", { type: "integer", min: -5, max: -4 });
    expect(res.output.value).toBe(-5);
  });

  test("integer com max <= min lança erro", async () => {
    await expect(run(randomHandler, "random", { type: "integer", min: 5, max: 5 })).rejects.toThrow(
      /max deve ser > min/i,
    );
    await expect(run(randomHandler, "random", { type: "integer", min: 5, max: 1 })).rejects.toThrow(
      /max deve ser > min/i,
    );
  });

  test("float fica em [min, max)", async () => {
    for (let i = 0; i < 50; i++) {
      const res = await run(randomHandler, "random", { type: "float", min: 1, max: 2 });
      const v = res.output.value as number;
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThan(2);
    }
  });

  test("float usa defaults 0..1", async () => {
    const res = await run(randomHandler, "random", { type: "float" });
    const v = res.output.value as number;
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  test("float com min === max é determinístico (não valida intervalo)", async () => {
    const res = await run(randomHandler, "random", { type: "float", min: 5, max: 5 });
    expect(res.output.value).toBe(5);
  });

  test("boolean devolve um booleano", async () => {
    const res = await run(randomHandler, "random", { type: "boolean" });
    expect(typeof res.output.value).toBe("boolean");
  });

  test("string usa o alfabeto default e length 16", async () => {
    const res = await run(randomHandler, "random", { type: "string" });
    expect(res.output.value).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  test("string respeita length", async () => {
    const res = await run(randomHandler, "random", { type: "string", length: 4 });
    expect((res.output.value as string).length).toBe(4);
  });

  test("string com alfabeto de 1 caractere é determinística", async () => {
    const res = await run(randomHandler, "random", { type: "string", length: 5, alphabet: "A" });
    expect(res.output.value).toBe("AAAAA");
  });

  test("string com alfabeto customizado só usa esses caracteres", async () => {
    const res = await run(randomHandler, "random", { type: "string", length: 32, alphabet: "01" });
    expect(res.output.value).toMatch(/^[01]{32}$/);
  });

  test("string com length 0/negativo cai pro default 16", async () => {
    const zero = await run(randomHandler, "random", { type: "string", length: 0, alphabet: "A" });
    expect(zero.output.value).toBe("A".repeat(16));

    const neg = await run(randomHandler, "random", { type: "string", length: -3, alphabet: "A" });
    expect(neg.output.value).toBe("A".repeat(16));
  });

  test("string com alphabet vazio cai pro default", async () => {
    const res = await run(randomHandler, "random", { type: "string", length: 8, alphabet: "" });
    expect(res.output.value).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  test("string tem length limitado a 4096", async () => {
    const res = await run(randomHandler, "random", { type: "string", length: 9999, alphabet: "A" });
    expect((res.output.value as string).length).toBe(4096);
  });

  test("bytes default é hex de 16 bytes (32 chars)", async () => {
    const res = await run(randomHandler, "random", { type: "bytes" });
    expect(res.output.value).toMatch(/^[0-9a-f]{32}$/);
  });

  test("bytes respeita length em hex", async () => {
    const res = await run(randomHandler, "random", { type: "bytes", length: 4 });
    expect(res.output.value).toMatch(/^[0-9a-f]{8}$/);
  });

  test("bytes com encoding base64", async () => {
    const res = await run(randomHandler, "random", {
      type: "bytes",
      length: 12,
      encoding: "base64",
    });
    expect(res.output.value).toMatch(/^[A-Za-z0-9+/]{16}$/);
  });

  test("bytes com encoding base64url não contém + nem /", async () => {
    const res = await run(randomHandler, "random", {
      type: "bytes",
      length: 32,
      encoding: "base64url",
    });
    expect(res.output.value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("bytes com encoding desconhecido cai pra hex", async () => {
    const res = await run(randomHandler, "random", { type: "bytes", length: 4, encoding: "utf8" });
    expect(res.output.value).toMatch(/^[0-9a-f]{8}$/);
  });

  test("bytes com length 0 cai pro default 16", async () => {
    const res = await run(randomHandler, "random", { type: "bytes", length: 0 });
    expect((res.output.value as string).length).toBe(32);
  });

  test("pick com um item só é determinístico", async () => {
    const res = await run(randomHandler, "random", { type: "pick", items: ["único"] });
    expect(res.output.value).toBe("único");
  });

  test("pick sempre devolve um elemento do array", async () => {
    const items = ["a", "b", "c"];
    for (let i = 0; i < 30; i++) {
      const res = await run(randomHandler, "random", { type: "pick", items });
      expect(items).toContain(res.output.value as string);
    }
  });

  test("pick com items vazio lança erro", async () => {
    await expect(run(randomHandler, "random", { type: "pick", items: [] })).rejects.toThrow(
      /array não vazio/i,
    );
  });

  test("pick sem items lança erro", async () => {
    await expect(run(randomHandler, "random", { type: "pick" })).rejects.toThrow(
      /array não vazio/i,
    );
  });

  test("pick com items não-array lança erro", async () => {
    await expect(run(randomHandler, "random", { type: "pick", items: "abc" })).rejects.toThrow(
      /array não vazio/i,
    );
  });

  test("type ausente lança erro", async () => {
    await expect(run(randomHandler, "random", {})).rejects.toThrow(/config\.type inválido/i);
  });

  test("type desconhecido lança erro", async () => {
    await expect(run(randomHandler, "random", { type: "gaussiana" })).rejects.toThrow(
      /config\.type inválido/i,
    );
  });

  test("config é interpolada por template antes de usar", async () => {
    const res = await run(
      randomHandler,
      "random",
      { type: "pick", items: "{{ vars.opcoes }}" },
      ctx({ vars: { opcoes: ["x"] } }),
    );
    expect(res.output.value).toBe("x");
  });
});
