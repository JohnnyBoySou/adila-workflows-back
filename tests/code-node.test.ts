import { describe, expect, test } from "bun:test";
import { codeHandler } from "../src/lib/engine/nodes/code";
import type { ExecutionContext, WorkflowNode } from "../src/lib/engine/types";

/**
 * Testes do nó `code` — foco no isolamento de sandbox (Worker thread).
 * Não precisam de DB; exercitam diretamente o handler.
 *
 * Cobrem: modelagem de output, polyfills n8n, e as três garantias do sandbox
 * (kill de loop síncrono no timeout, contenção de exceção, neutralização de
 * globais perigosos).
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

function codeNode(code: string, extraConfig: Record<string, unknown> = {}): WorkflowNode {
  return { id: "n1", type: "code", config: { code, ...extraConfig } };
}

async function run(
  code: string,
  context: ExecutionContext = ctx(),
  extraConfig: Record<string, unknown> = {},
) {
  return codeHandler({ node: codeNode(code, extraConfig), context });
}

describe("code node — modelagem de output", () => {
  test("objeto retornado vira output direto", async () => {
    const res = await run("return { a: 1, b: 'x' };");
    expect(res.output).toEqual({ a: 1, b: "x" });
  });

  test("primitivo retornado é envelopado em { result }", async () => {
    const res = await run("return 42;");
    expect(res.output).toEqual({ result: 42 });
  });

  test("string retornada é envelopada em { result }", async () => {
    const res = await run("return 'hello';");
    expect(res.output).toEqual({ result: "hello" });
  });

  test("sem return produz output vazio", async () => {
    const res = await run("const x = 1;");
    expect(res.output).toEqual({});
  });

  test("convenção n8n [{ json }] com 1 item faz unwrap", async () => {
    const res = await run("return [{ json: { nome: 'ada', idade: 30 } }];");
    expect(res.output).toEqual({ nome: "ada", idade: 30 });
  });

  test("convenção n8n [{ json }] com N itens expõe _items e mantém shape do 1º", async () => {
    const res = await run("return [{ json: { i: 1 } }, { json: { i: 2 } }];");
    expect(res.output.i).toBe(1);
    expect(res.output._items).toEqual([{ i: 1 }, { i: 2 }]);
  });

  test("array simples (não-n8n) vira { result: [...] }", async () => {
    const res = await run("return [1, 2, 3];");
    expect(res.output).toEqual({ result: [1, 2, 3] });
  });

  test("Promise (async) é aguardada", async () => {
    const res = await run("return await Promise.resolve({ ok: true });");
    expect(res.output).toEqual({ ok: true });
  });
});

describe("code node — polyfills e contexto", () => {
  test("input nativo acessível", async () => {
    const res = await run("return { echo: input.msg };", ctx({ input: { msg: "oi" } }));
    expect(res.output).toEqual({ echo: "oi" });
  });

  test("vars nativo acessível", async () => {
    const res = await run("return { v: vars.count };", ctx({ vars: { count: 7 } }));
    expect(res.output).toEqual({ v: 7 });
  });

  test("$json reflete o item atual (prev quando presente)", async () => {
    const res = await run("return { j: $json.valor };", ctx({ prev: { valor: 99 } }));
    expect(res.output).toEqual({ j: 99 });
  });

  test("$json cai pro input quando prev vazio", async () => {
    const res = await run("return { j: $json.k };", ctx({ input: { k: "fromInput" }, prev: {} }));
    expect(res.output).toEqual({ j: "fromInput" });
  });

  test("$input.first().json acessível", async () => {
    const res = await run("return $input.first().json;", ctx({ prev: { a: 1 } }));
    expect(res.output).toEqual({ a: 1 });
  });

  test("redeclarar `const items` não quebra (shim colidente é removido)", async () => {
    const res = await run("const items = [10, 20]; return { soma: items[0] + items[1] };");
    expect(res.output).toEqual({ soma: 30 });
  });
});

describe("code node — sandbox: contenção de erros", () => {
  test("throw no código do usuário rejeita com a mensagem", async () => {
    await expect(run("throw new Error('boom');")).rejects.toThrow("boom");
  });

  test("erro de sintaxe rejeita", async () => {
    await expect(run("return {{{ ;")).rejects.toThrow(/sintaxe/i);
  });

  test("config.code ausente falha cedo", async () => {
    await expect(
      codeHandler({ node: { id: "n1", type: "code", config: {} }, context: ctx() }),
    ).rejects.toThrow(/obrigatório/i);
  });
});

describe("code node — sandbox: neutralização de globais", () => {
  test("process é undefined dentro do sandbox (sem vazar env)", async () => {
    const res = await run("return { t: typeof process };");
    expect(res.output).toEqual({ t: "undefined" });
  });

  test("Bun é undefined dentro do sandbox", async () => {
    const res = await run("return { t: typeof Bun };");
    expect(res.output).toEqual({ t: "undefined" });
  });

  test("require é undefined dentro do sandbox", async () => {
    const res = await run("return { t: typeof require };");
    expect(res.output).toEqual({ t: "undefined" });
  });

  test("Function construtor é neutralizado (bloqueia escape clássico)", async () => {
    // `Function('return process')()` é o escape clássico; com Function=undefined
    // a própria referência lança TypeError, contida como rejeição.
    await expect(run("return Function('return process')();")).rejects.toThrow();
  });
});

describe("code node — sandbox: timeout mata loop síncrono", () => {
  test("loop infinito síncrono é interrompido pelo timeout", async () => {
    const started = Date.now();
    await expect(run("while (true) {}", ctx(), { timeoutMs: 300 })).rejects.toThrow(/timeout/i);
    // Prova que o kill foi por parede (~300ms), não que o event loop travou pra sempre.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);
});
