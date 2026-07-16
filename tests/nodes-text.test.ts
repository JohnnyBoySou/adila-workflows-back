import { describe, expect, test } from "bun:test";
import { csvHandler } from "../src/lib/engine/nodes/csv";
import { dateTimeHandler } from "../src/lib/engine/nodes/date-time";
import { htmlExtractHandler } from "../src/lib/engine/nodes/html-extract";
import { jsonHandler } from "../src/lib/engine/nodes/json";
import { markdownHandler } from "../src/lib/engine/nodes/markdown";
import { mathHandler } from "../src/lib/engine/nodes/math";
import { templateHandler } from "../src/lib/engine/nodes/template";
import { textManipulationHandler } from "../src/lib/engine/nodes/text-manipulation";
import { urlToolsHandler } from "../src/lib/engine/nodes/url-tools";
import { xmlHandler } from "../src/lib/engine/nodes/xml";
import { yamlHandler } from "../src/lib/engine/nodes/yaml";
import type { ExecutionContext, NodeHandler, NodeType } from "../src/lib/engine/types";

/**
 * Testes dos nós de serialização/texto do engine.
 * Não precisam de DB; exercitam os handlers diretamente.
 *
 * Todos esses nós são discriminados por `config.operation`, então cada bloco
 * cobre: as operations suportadas, a operation inválida, erro de parse e
 * casos de borda (string vazia, null/undefined, config obrigatória ausente).
 *
 * Determinismo: nenhuma asserção depende do "agora" nem do timezone da
 * máquina — datas são fixas e, quando o nó usa getters locais (`date_time
 * format`), a entrada é uma string sem `Z` (interpretada como hora local),
 * o que torna o resultado idêntico em qualquer TZ.
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

/** Invoca um handler com a config dada, sem estado compartilhado entre testes. */
async function run(
  handler: NodeHandler,
  type: NodeType,
  config: Record<string, unknown>,
  context: ExecutionContext = ctx(),
) {
  const res = await handler({ node: { id: "n1", type, config }, context });
  return res.output;
}

// ---------------------------------------------------------------- json

describe("json node", () => {
  test("parse converte string JSON em objeto", async () => {
    const out = await run(jsonHandler, "json", { operation: "parse", value: '{"a":1,"b":[2,3]}' });
    expect(out).toEqual({ data: { a: 1, b: [2, 3] } });
  });

  test("parse aceita escalares JSON", async () => {
    expect(await run(jsonHandler, "json", { operation: "parse", value: "42" })).toEqual({ data: 42 });
  });

  test("parse com JSON inválido lança erro prefixado", async () => {
    await expect(
      run(jsonHandler, "json", { operation: "parse", value: "{nao é json}" }),
    ).rejects.toThrow(/^json parse:/);
  });

  test("parse com value ausente vira string vazia e falha no JSON.parse", async () => {
    await expect(run(jsonHandler, "json", { operation: "parse" })).rejects.toThrow(/^json parse:/);
  });

  test("stringify serializa em uma linha por padrão", async () => {
    const out = await run(jsonHandler, "json", { operation: "stringify", value: { a: 1 } });
    expect(out).toEqual({ text: '{"a":1}' });
  });

  test("stringify com pretty indenta com 2 espaços", async () => {
    const out = await run(jsonHandler, "json", {
      operation: "stringify",
      value: { a: 1 },
      pretty: true,
    });
    expect(out.text).toBe('{\n  "a": 1\n}');
  });

  test("stringify sem value produz text undefined (JSON.stringify(undefined))", async () => {
    const out = await run(jsonHandler, "json", { operation: "stringify" });
    expect(out.text).toBeUndefined();
  });

  test("extract resolve dot-path com índice numérico", async () => {
    const out = await run(jsonHandler, "json", {
      operation: "extract",
      value: { a: { b: [10, 20] } },
      path: "a.b.1",
    });
    expect(out).toEqual({ value: 20 });
  });

  test("extract de path inexistente devolve undefined", async () => {
    const out = await run(jsonHandler, "json", {
      operation: "extract",
      value: { a: 1 },
      path: "x.y",
    });
    expect(out.value).toBeUndefined();
  });

  test("extract sem path é rejeitado", async () => {
    await expect(
      run(jsonHandler, "json", { operation: "extract", value: { a: 1 } }),
    ).rejects.toThrow(/`path` é obrigatório/);
  });

  test("operation não suportada é rejeitada", async () => {
    await expect(run(jsonHandler, "json", { operation: "nope" })).rejects.toThrow(
      /operation "nope" não suportada/,
    );
  });

  test("config é interpolada a partir do contexto antes de executar", async () => {
    const out = await run(
      jsonHandler,
      "json",
      { operation: "parse", value: "{{ input.raw }}" },
      ctx({ input: { raw: '{"ok":true}' } }),
    );
    expect(out).toEqual({ data: { ok: true } });
  });
});

// ---------------------------------------------------------------- yaml

describe("yaml node", () => {
  test("parse converte YAML em objeto", async () => {
    const out = await run(yamlHandler, "yaml", { operation: "parse", value: "a: 1\nb:\n  - x\n" });
    expect(out).toEqual({ data: { a: 1, b: ["x"] } });
  });

  test("parse de string vazia devolve null", async () => {
    const out = await run(yamlHandler, "yaml", { operation: "parse", value: "" });
    expect(out).toEqual({ data: null });
  });

  test("parse com YAML inválido propaga o erro do parser", async () => {
    await expect(
      run(yamlHandler, "yaml", { operation: "parse", value: "a: [1,\n  b: :" }),
    ).rejects.toThrow();
  });

  test("parse exige value string", async () => {
    await expect(run(yamlHandler, "yaml", { operation: "parse", value: 5 })).rejects.toThrow(
      /config.value deve ser string/,
    );
  });

  test("stringify serializa objeto em YAML", async () => {
    const out = await run(yamlHandler, "yaml", { operation: "stringify", value: { a: 1 } });
    expect(out).toEqual({ yaml: "a: 1\n" });
  });

  test("stringify sem value produz yaml undefined", async () => {
    const out = await run(yamlHandler, "yaml", { operation: "stringify" });
    expect(out.yaml).toBeUndefined();
  });

  test("operation ausente ou inválida é rejeitada", async () => {
    await expect(run(yamlHandler, "yaml", {})).rejects.toThrow(
      /operation deve ser 'parse' ou 'stringify'/,
    );
    await expect(run(yamlHandler, "yaml", { operation: "nope" })).rejects.toThrow(
      /operation deve ser 'parse' ou 'stringify'/,
    );
  });
});

// ---------------------------------------------------------------- xml

describe("xml node", () => {
  test("parse aninha tags sob a raiz", async () => {
    const out = await run(xmlHandler, "xml", {
      operation: "parse",
      value: "<root><a>1</a><b>2</b></root>",
    });
    expect(out).toEqual({ data: { root: { a: "1", b: "2" } } });
  });

  test("parse expõe atributos em @attrs", async () => {
    const out = await run(xmlHandler, "xml", {
      operation: "parse",
      value: '<u id="7"><n>ada</n></u>',
    });
    expect(out).toEqual({ data: { u: { "@attrs": { id: "7" }, n: "ada" } } });
  });

  test("parse agrupa tags repetidas em array", async () => {
    const out = await run(xmlHandler, "xml", {
      operation: "parse",
      value: "<l><i>a</i><i>b</i></l>",
    });
    expect(out).toEqual({ data: { l: { i: ["a", "b"] } } });
  });

  test("parse ignora o prolog <?xml ...?>", async () => {
    const out = await run(xmlHandler, "xml", {
      operation: "parse",
      value: '<?xml version="1.0"?><r><a>1</a></r>',
    });
    expect(out).toEqual({ data: { r: { a: "1" } } });
  });

  test("parse de string vazia devolve data null", async () => {
    expect(await run(xmlHandler, "xml", { operation: "parse", value: "" })).toEqual({ data: null });
  });

  test("parse sem value devolve data null (não lança)", async () => {
    expect(await run(xmlHandler, "xml", { operation: "parse" })).toEqual({ data: null });
  });

  test("build gera XML com prolog e escapa entidades", async () => {
    const out = await run(xmlHandler, "xml", { operation: "build", data: { a: 1, b: "x&y" } });
    expect(out.text).toBe('<?xml version="1.0" encoding="UTF-8"?><root><a>1</a><b>x&amp;y</b></root>');
  });

  test("build usa `root` customizado e fecha tag vazia para null", async () => {
    const out = await run(xmlHandler, "xml", { operation: "build", root: "doc", data: { a: null } });
    expect(out.text).toBe('<?xml version="1.0" encoding="UTF-8"?><doc><a/></doc>');
  });

  test("build repete a tag para cada item de um array", async () => {
    const out = await run(xmlHandler, "xml", {
      operation: "build",
      root: "l",
      data: { i: ["a", "b"] },
    });
    expect(out.text).toContain("<l><i>a</i><i>b</i></l>");
  });

  test("operation não suportada é rejeitada", async () => {
    await expect(run(xmlHandler, "xml", { operation: "nope" })).rejects.toThrow(
      /xml: operation "nope" não suportada/,
    );
  });
});

// ---------------------------------------------------------------- csv

describe("csv node", () => {
  test("parse com headers monta items indexados pelo cabeçalho", async () => {
    const out = await run(csvHandler, "csv", { operation: "parse", value: "a,b\n1,2\n3,4" });
    expect(out).toEqual({
      items: [
        { a: "1", b: "2" },
        { a: "3", b: "4" },
      ],
      length: 2,
      headers: ["a", "b"],
    });
  });

  test("parse com headers=false devolve rows cruas", async () => {
    const out = await run(csvHandler, "csv", {
      operation: "parse",
      value: "1,2",
      headers: false,
    });
    expect(out).toEqual({ rows: [["1", "2"]], length: 1 });
  });

  test("parse respeita aspas com delimitador dentro do campo", async () => {
    const out = await run(csvHandler, "csv", { operation: "parse", value: 'a,b\n"x,y",2' });
    expect(out.items).toEqual([{ a: "x,y", b: "2" }]);
  });

  test("parse desescapa aspas duplas repetidas", async () => {
    const out = await run(csvHandler, "csv", { operation: "parse", value: 'a\n"diz ""oi"""' });
    expect(out.items).toEqual([{ a: 'diz "oi"' }]);
  });

  test("parse aceita quebra de linha dentro de campo aspeado", async () => {
    const out = await run(csvHandler, "csv", { operation: "parse", value: 'a,b\n"l1\nl2",2' });
    expect(out.items).toEqual([{ a: "l1\nl2", b: "2" }]);
  });

  test("parse com delimiter customizado (TSV)", async () => {
    const out = await run(csvHandler, "csv", {
      operation: "parse",
      value: "a\tb\n1\t2",
      delimiter: "\t",
    });
    expect(out.items).toEqual([{ a: "1", b: "2" }]);
  });

  test("parse preenche com string vazia colunas faltantes na linha", async () => {
    const out = await run(csvHandler, "csv", { operation: "parse", value: "a,b\n1" });
    expect(out.items).toEqual([{ a: "1", b: "" }]);
  });

  test("parse de string vazia devolve items vazio", async () => {
    expect(await run(csvHandler, "csv", { operation: "parse", value: "" })).toEqual({
      items: [],
      length: 0,
    });
  });

  test("build infere headers da união das chaves e deixa faltantes vazias", async () => {
    const out = await run(csvHandler, "csv", {
      operation: "build",
      items: [
        { a: 1, b: 2 },
        { a: 3, c: 4 },
      ],
    });
    expect(out).toEqual({ text: "a,b,c\n1,2,\n3,,4", headers: ["a", "b", "c"] });
  });

  test("build escapa campos que contêm delimitador ou aspas", async () => {
    const out = await run(csvHandler, "csv", { operation: "build", items: [{ a: 'x,y"z' }] });
    expect(out.text).toBe('a\n"x,y""z"');
  });

  test("build sem items devolve só a linha de headers vazia", async () => {
    expect(await run(csvHandler, "csv", { operation: "build" })).toEqual({ text: "", headers: [] });
  });

  test("operation não suportada é rejeitada", async () => {
    await expect(run(csvHandler, "csv", { operation: "nope" })).rejects.toThrow(
      /csv: operation "nope" não suportada/,
    );
  });
});

// ---------------------------------------------------------------- markdown

describe("markdown node", () => {
  test("to_html converte cabeçalho, lista e ênfase inline", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_html",
      value: "# T\n\n- um\n- dois\n\n**b** e `c`",
    });
    expect(out.html).toBe(
      "<h1>T</h1>\n\n<ul>\n<li>um</li>\n<li>dois</li>\n</ul>\n\n<p><strong>b</strong> e <code>c</code></p>",
    );
  });

  test("to_html respeita o nível do cabeçalho", async () => {
    const out = await run(markdownHandler, "markdown", { operation: "to_html", value: "### T" });
    expect(out.html).toBe("<h3>T</h3>");
  });

  test("to_html converte link em âncora", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_html",
      value: "[l](http://x)",
    });
    expect(out.html).toBe('<p><a href="http://x">l</a></p>');
  });

  test("to_html escapa HTML do usuário (sem XSS por injeção direta)", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_html",
      value: "<script>alert(1)</script>",
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
  });

  test("to_html envolve bloco de código em <pre><code>", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_html",
      value: "```\nx = 1\n```",
    });
    expect(out.html).toBe("<pre><code>\nx = 1\n</code></pre>");
  });

  test("to_html fecha bloco de código não terminado", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_html",
      value: "```\nx = 1",
    });
    expect(String(out.html).endsWith("</code></pre>")).toBe(true);
  });

  test("to_text remove marcação e expande link para 'texto (url)'", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_text",
      value: "# T\n\n- um\n\n[l](http://x)",
    });
    expect(out.text).toBe("T\n• um\n\nl (http://x)");
  });

  test("to_text remove ênfase e crases", async () => {
    const out = await run(markdownHandler, "markdown", {
      operation: "to_text",
      value: "**b** e *i* e `c`",
    });
    expect(out.text).toBe("b e i e c");
  });

  test("string vazia é tratada sem erro nas duas operações", async () => {
    expect(await run(markdownHandler, "markdown", { operation: "to_html", value: "" })).toEqual({
      html: "",
    });
    expect(await run(markdownHandler, "markdown", { operation: "to_text", value: "" })).toEqual({
      text: "",
    });
  });

  test("value ausente vira string vazia", async () => {
    expect(await run(markdownHandler, "markdown", { operation: "to_text" })).toEqual({ text: "" });
  });

  test("operation não suportada é rejeitada", async () => {
    await expect(run(markdownHandler, "markdown", { operation: "nope" })).rejects.toThrow(
      /markdown: operation "nope" não suportada/,
    );
  });
});

// ---------------------------------------------------------------- html_extract

describe("html_extract node", () => {
  const HTML = '<div id="main"><p class="c">um</p><p class="c">dois</p><a href="http://x">l</a></div>';

  test("seletor por tag devolve o innerText do primeiro match", async () => {
    const out = await run(htmlExtractHandler, "html_extract", { value: HTML, selector: "p" });
    expect(out).toEqual({ value: "um", length: 2 });
  });

  test("all=true devolve todos os matches", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: HTML,
      selector: "p.c",
      all: true,
    });
    expect(out).toEqual({ matches: ["um", "dois"], length: 2 });
  });

  test("seletor por #id filtra pelo atributo id", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: HTML,
      selector: "div#main",
    });
    // Nota: a remoção de tags não insere separador, então textos de elementos
    // irmãos ficam colados ("um" + "dois" + "l").
    expect(out.value).toBe("umdoisl");
  });

  test("attribute devolve o valor do atributo em vez do texto", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: HTML,
      selector: "a",
      attribute: "href",
    });
    expect(out).toEqual({ value: "http://x", length: 1 });
  });

  test("attribute inexistente no match devolve null", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: HTML,
      selector: "a",
      attribute: "target",
    });
    expect(out).toEqual({ value: null, length: 1 });
  });

  test("sem match devolve value null e length 0", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: "<p>a</p>",
      selector: "span",
    });
    expect(out).toEqual({ value: null, length: 0 });
  });

  test("innerText descarta script/style e normaliza espaços", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: "<div><script>bad()</script><style>a{}</style>  oi   mundo </div>",
      selector: "div",
    });
    expect(out.value).toBe("oi mundo");
  });

  test("innerText decodifica entidades básicas", async () => {
    const out = await run(htmlExtractHandler, "html_extract", {
      value: "<p>a&nbsp;&amp;&lt;b&gt;&quot;</p>",
      selector: "p",
    });
    expect(out.value).toBe('a &<b>"');
  });

  test("selector ausente é rejeitado", async () => {
    await expect(run(htmlExtractHandler, "html_extract", { value: HTML })).rejects.toThrow(
      /`selector` é obrigatório/,
    );
  });

  test("selector vazio é rejeitado", async () => {
    await expect(
      run(htmlExtractHandler, "html_extract", { value: HTML, selector: "" }),
    ).rejects.toThrow(/`selector` é obrigatório/);
  });

  test("selector complexo (não suportado) é rejeitado", async () => {
    await expect(
      run(htmlExtractHandler, "html_extract", { value: HTML, selector: "div > p" }),
    ).rejects.toThrow(/não suportado/);
  });

  test("value ausente vira HTML vazio e não acha nada", async () => {
    const out = await run(htmlExtractHandler, "html_extract", { selector: "p" });
    expect(out).toEqual({ value: null, length: 0 });
  });
});

// ---------------------------------------------------------------- text_manipulation

describe("text_manipulation node", () => {
  test("replace literal troca todas as ocorrências", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "replace",
      value: "a-b-c",
      search: "-",
      replacement: "+",
    });
    expect(out).toEqual({ text: "a+b+c" });
  });

  test("replace literal não interpreta metacaracteres de regex", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "replace",
      value: "a.b",
      search: ".",
      replacement: "-",
    });
    expect(out).toEqual({ text: "a-b" });
  });

  test("replace com regex=true usa flags (default g)", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "replace",
      value: "a1b2",
      search: "\\d",
      replacement: "#",
      regex: true,
    });
    expect(out).toEqual({ text: "a#b#" });
  });

  test("replace com regex e flags customizadas", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "replace",
      value: "AaA",
      search: "a",
      replacement: "-",
      regex: true,
      flags: "gi",
    });
    expect(out).toEqual({ text: "---" });
  });

  test("split quebra pelo separador", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "split",
      value: "a,b,c",
      separator: ",",
    });
    expect(out).toEqual({ parts: ["a", "b", "c"] });
  });

  test("split respeita limit", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "split",
      value: "a,b,c",
      separator: ",",
      limit: 2,
    });
    expect(out).toEqual({ parts: ["a", "b"] });
  });

  test("join concatena items, tratando null como string vazia", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "join",
      items: ["a", null, 2],
      separator: "-",
    });
    expect(out).toEqual({ text: "a--2" });
  });

  test("join sem items devolve string vazia", async () => {
    expect(
      await run(textManipulationHandler, "text_manipulation", {
        operation: "join",
        separator: ",",
      }),
    ).toEqual({ text: "" });
  });

  test("upper, lower e trim", async () => {
    expect(
      await run(textManipulationHandler, "text_manipulation", { operation: "upper", value: "aB" }),
    ).toEqual({ text: "AB" });
    expect(
      await run(textManipulationHandler, "text_manipulation", { operation: "lower", value: "aB" }),
    ).toEqual({ text: "ab" });
    expect(
      await run(textManipulationHandler, "text_manipulation", {
        operation: "trim",
        value: "  x  ",
      }),
    ).toEqual({ text: "x" });
  });

  test("length conta os caracteres", async () => {
    expect(
      await run(textManipulationHandler, "text_manipulation", { operation: "length", value: "abc" }),
    ).toEqual({ length: 3 });
  });

  test("length de value ausente é 0", async () => {
    expect(
      await run(textManipulationHandler, "text_manipulation", { operation: "length" }),
    ).toEqual({ length: 0 });
  });

  test("substring com start e end", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "substring",
      value: "abcdef",
      start: 1,
      end: 3,
    });
    expect(out).toEqual({ text: "bc" });
  });

  test("substring sem end vai até o fim", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "substring",
      value: "abcdef",
      start: 4,
    });
    expect(out).toEqual({ text: "ef" });
  });

  test("regex_match com flag g devolve só os matches completos", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "regex_match",
      value: "a1b2",
      pattern: "[a-z]\\d",
    });
    expect(out).toEqual({ matches: ["a1", "b2"], first: "a1", length: 2 });
  });

  test("regex_match sem flag g devolve match + grupos de captura", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "regex_match",
      value: "a1b2",
      pattern: "([a-z])(\\d)",
      flags: "",
    });
    expect(out).toEqual({ matches: ["a1", "a", "1"], first: "a1", length: 3 });
  });

  test("regex_match sem match devolve first null", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "regex_match",
      value: "abc",
      pattern: "\\d",
    });
    expect(out).toEqual({ matches: [], first: null, length: 0 });
  });

  test("regex_match sem pattern é rejeitado", async () => {
    await expect(
      run(textManipulationHandler, "text_manipulation", {
        operation: "regex_match",
        value: "x",
      }),
    ).rejects.toThrow(/`pattern` é obrigatório/);
  });

  test("pad preenche à esquerda por padrão", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "pad",
      value: "7",
      length: 3,
      fill: "0",
    });
    expect(out).toEqual({ text: "007" });
  });

  test("pad com side=right preenche à direita", async () => {
    const out = await run(textManipulationHandler, "text_manipulation", {
      operation: "pad",
      value: "7",
      length: 3,
      side: "right",
      fill: "0",
    });
    expect(out).toEqual({ text: "700" });
  });

  test("pad usa espaço como fill default e não trunca valor maior", async () => {
    expect(
      await run(textManipulationHandler, "text_manipulation", {
        operation: "pad",
        value: "7",
        length: 3,
      }),
    ).toEqual({ text: "  7" });
    expect(
      await run(textManipulationHandler, "text_manipulation", {
        operation: "pad",
        value: "abcd",
        length: 2,
      }),
    ).toEqual({ text: "abcd" });
  });

  test("operation ausente ou não suportada é rejeitada", async () => {
    await expect(run(textManipulationHandler, "text_manipulation", {})).rejects.toThrow(
      /operation "" não suportada/,
    );
    await expect(
      run(textManipulationHandler, "text_manipulation", { operation: "nope" }),
    ).rejects.toThrow(/operation "nope" não suportada/);
  });
});

// ---------------------------------------------------------------- template

describe("template node", () => {
  test("interpola o contexto e devolve em `text` por padrão", async () => {
    const out = await run(
      templateHandler,
      "template",
      { template: "oi {{ input.nome }}" },
      ctx({ input: { nome: "ada" } }),
    );
    expect(out).toEqual({ text: "oi ada" });
  });

  test("outputKey customiza a chave de saída", async () => {
    const out = await run(
      templateHandler,
      "template",
      { template: "{{ vars.v }}", outputKey: "assunto" },
      ctx({ vars: { v: "x" } }),
    );
    expect(out).toEqual({ assunto: "x" });
  });

  test("path inexistente vira string vazia na interpolação", async () => {
    expect(await run(templateHandler, "template", { template: "a{{ input.nada }}b" })).toEqual({
      text: "ab",
    });
  });

  test("valor não-string é convertido com String()", async () => {
    const out = await run(
      templateHandler,
      "template",
      { template: "{{ input.n }}" },
      ctx({ input: { n: 42 } }),
    );
    expect(out).toEqual({ text: "42" });
  });

  test("template puro resolvendo objeto vira '[object Object]'", async () => {
    // Comportamento atual: template "inteiro" devolve o valor cru e o nó
    // aplica String() — objeto degrada pra "[object Object]" (ver relatório).
    const out = await run(
      templateHandler,
      "template",
      { template: "{{ input.o }}" },
      ctx({ input: { o: { a: 1 } } }),
    );
    expect(out).toEqual({ text: "[object Object]" });
  });

  test("template sem `{{ }}` passa direto", async () => {
    expect(await run(templateHandler, "template", { template: "estático" })).toEqual({
      text: "estático",
    });
  });

  test("config.template ausente é rejeitada", async () => {
    await expect(run(templateHandler, "template", {})).rejects.toThrow(
      /config.template é obrigatório/,
    );
  });

  test("config.template não-string é rejeitada", async () => {
    await expect(run(templateHandler, "template", { template: 1 })).rejects.toThrow(
      /config.template é obrigatório/,
    );
  });
});

// ---------------------------------------------------------------- url_tools

describe("url_tools node", () => {
  test("parse decompõe a URL e expõe searchParams", async () => {
    const out = await run(urlToolsHandler, "url_tools", {
      operation: "parse",
      url: "https://ex.com:8443/a/b?q=1&r=2#frag",
    });
    expect(out).toMatchObject({
      protocol: "https:",
      hostname: "ex.com",
      port: "8443",
      pathname: "/a/b",
      search: "?q=1&r=2",
      hash: "#frag",
      searchParams: { q: "1", r: "2" },
    });
  });

  test("parse sem url é rejeitado", async () => {
    await expect(run(urlToolsHandler, "url_tools", { operation: "parse" })).rejects.toThrow(
      /config.url é obrigatório/,
    );
  });

  test("parse de URL inválida propaga o erro do construtor URL", async () => {
    await expect(
      run(urlToolsHandler, "url_tools", { operation: "parse", url: "nao-e-url" }),
    ).rejects.toThrow();
  });

  test("build monta URL com query, ignorando valores null", async () => {
    const out = await run(urlToolsHandler, "url_tools", {
      operation: "build",
      parts: { hostname: "ex.com", pathname: "/p" },
      query: { q: "x", n: null },
    });
    expect(out).toEqual({ url: "https://ex.com/p?q=x" });
  });

  test("build usa https e / como defaults e aceita port e hash", async () => {
    const out = await run(urlToolsHandler, "url_tools", {
      operation: "build",
      parts: { hostname: "ex.com", port: 8080, hash: "#f" },
    });
    expect(out).toEqual({ url: "https://ex.com:8080/#f" });
  });

  test("build sem hostname é rejeitado", async () => {
    await expect(
      run(urlToolsHandler, "url_tools", { operation: "build", parts: {} }),
    ).rejects.toThrow(/parts.hostname é obrigatório/);
  });

  test("encode e decode fazem round-trip", async () => {
    const enc = await run(urlToolsHandler, "url_tools", {
      operation: "encode",
      value: "a b&c=d",
    });
    expect(enc).toEqual({ value: "a%20b%26c%3Dd" });
    expect(
      await run(urlToolsHandler, "url_tools", { operation: "decode", value: enc.value }),
    ).toEqual({ value: "a b&c=d" });
  });

  test("encode/decode sem value são rejeitados", async () => {
    await expect(run(urlToolsHandler, "url_tools", { operation: "encode" })).rejects.toThrow(
      /config.value é obrigatório/,
    );
    await expect(run(urlToolsHandler, "url_tools", { operation: "decode" })).rejects.toThrow(
      /config.value é obrigatório/,
    );
  });

  test("encode de string vazia é permitido", async () => {
    expect(await run(urlToolsHandler, "url_tools", { operation: "encode", value: "" })).toEqual({
      value: "",
    });
  });

  test("parse_query aceita query string pura", async () => {
    expect(
      await run(urlToolsHandler, "url_tools", { operation: "parse_query", value: "a=1&b=2" }),
    ).toEqual({ query: { a: "1", b: "2" } });
  });

  test("parse_query extrai a partir do '?' de uma URL completa", async () => {
    expect(
      await run(urlToolsHandler, "url_tools", {
        operation: "parse_query",
        url: "https://ex.com/p?a=1",
      }),
    ).toEqual({ query: { a: "1" } });
  });

  test("parse_query sem entrada devolve query vazia", async () => {
    expect(await run(urlToolsHandler, "url_tools", { operation: "parse_query" })).toEqual({
      query: {},
    });
  });

  test("build_query serializa e ignora null/undefined", async () => {
    expect(
      await run(urlToolsHandler, "url_tools", {
        operation: "build_query",
        query: { a: 1, b: "x y", c: null },
      }),
    ).toEqual({ query: "a=1&b=x+y" });
  });

  test("build_query sem query devolve string vazia", async () => {
    expect(await run(urlToolsHandler, "url_tools", { operation: "build_query" })).toEqual({
      query: "",
    });
  });

  test("operation ausente ou inválida é rejeitada", async () => {
    await expect(run(urlToolsHandler, "url_tools", {})).rejects.toThrow(
      /config.operation inválida/,
    );
    await expect(run(urlToolsHandler, "url_tools", { operation: "nope" })).rejects.toThrow(
      /config.operation inválida/,
    );
  });
});

// ---------------------------------------------------------------- math

describe("math node", () => {
  test("avalia aritmética simples", async () => {
    expect(await run(mathHandler, "math", { expression: "1 + 2 * 3" })).toEqual({ value: 7 });
  });

  test("respeita parênteses e usa vars pelo nome", async () => {
    expect(
      await run(mathHandler, "math", { expression: "(a + b) * 2", vars: { a: 3, b: 4 } }),
    ).toEqual({ value: 14 });
  });

  test("vars são coeridas para número", async () => {
    expect(await run(mathHandler, "math", { expression: "a + 1", vars: { a: "2" } })).toEqual({
      value: 3,
    });
  });

  test("módulo e divisão", async () => {
    expect(await run(mathHandler, "math", { expression: "7 % 4" })).toEqual({ value: 3 });
    expect(await run(mathHandler, "math", { expression: "10 / 4" })).toEqual({ value: 2.5 });
  });

  test("resultado não finito devolve value null com error", async () => {
    expect(await run(mathHandler, "math", { expression: "1 / 0" })).toEqual({
      value: null,
      error: "resultado não numérico",
    });
  });

  test("expression ausente ou vazia é rejeitada", async () => {
    await expect(run(mathHandler, "math", {})).rejects.toThrow(/`expression` é obrigatório/);
    await expect(run(mathHandler, "math", { expression: "   " })).rejects.toThrow(
      /`expression` é obrigatório/,
    );
  });

  test("caracteres fora da allowlist são rejeitados (bloqueia escape)", async () => {
    await expect(
      run(mathHandler, "math", { expression: "1; process.exit()" }),
    ).rejects.toThrow(/caracteres não permitidos/);
    await expect(
      run(mathHandler, "math", { expression: "globalThis['x']" }),
    ).rejects.toThrow(/caracteres não permitidos/);
  });

  test("identificador desconhecido é rejeitado", async () => {
    await expect(run(mathHandler, "math", { expression: "foo + 1" })).rejects.toThrow(
      /identificador "foo" não permitido/,
    );
  });

  // BUG (ver relatório): funções/constantes de Math passam na allowlist mas não
  // existem no escopo do `new Function` — só o objeto `Math` é injetado, e o
  // identificador "Math" não está na allowlist. Logo nenhuma das duas formas
  // funciona. Os testes abaixo fixam o comportamento ATUAL, não o desejado.
  test("BUG: função de Math sem prefixo passa na allowlist mas falha em runtime", async () => {
    await expect(run(mathHandler, "math", { expression: "sqrt(16)" })).rejects.toThrow(
      /math: sqrt is not defined/,
    );
  });

  test("BUG: constante de Math sem prefixo também falha em runtime", async () => {
    await expect(run(mathHandler, "math", { expression: "PI * 2" })).rejects.toThrow(
      /math: PI is not defined/,
    );
  });

  test("BUG: forma prefixada Math.sqrt() é barrada pela allowlist", async () => {
    await expect(run(mathHandler, "math", { expression: "Math.sqrt(16)" })).rejects.toThrow(
      /identificador "Math" não permitido/,
    );
  });
});

// ---------------------------------------------------------------- date_time

describe("date_time node", () => {
  test("now devolve iso e epochMs coerentes entre si", async () => {
    // Sem asserção sobre o "agora": só propriedades invariantes.
    const out = await run(dateTimeHandler, "date_time", { operation: "now" });
    expect(typeof out.iso).toBe("string");
    expect(typeof out.epochMs).toBe("number");
    expect(new Date(out.iso as string).getTime()).toBe(out.epochMs as number);
  });

  test("parse normaliza data fixa para ISO + epochMs", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "parse",
      value: "2024-01-02T03:04:05Z",
    });
    expect(out).toEqual({ iso: "2024-01-02T03:04:05.000Z", epochMs: 1704164645000 });
  });

  test("parse de valor inválido é rejeitado", async () => {
    await expect(
      run(dateTimeHandler, "date_time", { operation: "parse", value: "não é data" }),
    ).rejects.toThrow(/parse: valor inválido/);
  });

  test("parse sem value é rejeitado (string vazia é data inválida)", async () => {
    await expect(run(dateTimeHandler, "date_time", { operation: "parse" })).rejects.toThrow(
      /parse: valor inválido ""/,
    );
  });

  test("format aplica os tokens sobre hora local", async () => {
    // Entrada sem `Z` → Date interpreta como hora LOCAL, então os getters
    // locais do formatter devolvem exatamente estes componentes em qualquer TZ.
    const out = await run(dateTimeHandler, "date_time", {
      operation: "format",
      value: "2024-03-05T14:07:09.123",
      format: "YYYY-MM-DD HH:mm:ss.SSS",
    });
    expect(out).toEqual({ formatted: "2024-03-05 14:07:09.123" });
  });

  test("format usa máscara default quando `format` não é string", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "format",
      value: "2024-03-05T14:07:09",
    });
    expect(out).toEqual({ formatted: "2024-03-05 14:07:09" });
  });

  test("format preserva literais fora dos tokens", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "format",
      value: "2024-03-05T00:00:00",
      format: "DD/MM/YYYY",
    });
    expect(out).toEqual({ formatted: "05/03/2024" });
  });

  test("format de valor inválido é rejeitado", async () => {
    await expect(
      run(dateTimeHandler, "date_time", { operation: "format", value: "xx" }),
    ).rejects.toThrow(/format: valor inválido/);
  });

  test("add soma na unidade indicada", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "add",
      value: "2024-01-01T00:00:00Z",
      amount: 2,
      unit: "d",
    });
    expect(out).toEqual({ iso: "2024-01-03T00:00:00.000Z", epochMs: 1704240000000 });
  });

  test("add aceita amount negativo (subtração)", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "add",
      value: "2024-01-01T00:00:00Z",
      amount: -1,
      unit: "h",
    });
    expect(out.iso).toBe("2023-12-31T23:00:00.000Z");
  });

  test("add usa `seconds` como unidade default", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "add",
      value: "2024-01-01T00:00:00Z",
      amount: 30,
    });
    expect(out.iso).toBe("2024-01-01T00:00:30.000Z");
  });

  test("add aceita aliases longos de unidade", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "add",
      value: "2024-01-01T00:00:00Z",
      amount: 1,
      unit: "minutes",
    });
    expect(out.iso).toBe("2024-01-01T00:01:00.000Z");
  });

  test("add com unit desconhecido é rejeitado", async () => {
    await expect(
      run(dateTimeHandler, "date_time", {
        operation: "add",
        value: "2024-01-01T00:00:00Z",
        amount: 1,
        unit: "weeks",
      }),
    ).rejects.toThrow(/unit "weeks" não suportado/);
  });

  test("add com amount não numérico é rejeitado", async () => {
    await expect(
      run(dateTimeHandler, "date_time", {
        operation: "add",
        value: "2024-01-01T00:00:00Z",
        amount: "x",
      }),
    ).rejects.toThrow(/amount precisa ser número/);
  });

  test("diff devolve o delta em todas as unidades", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "diff",
      from: "2024-01-01T00:00:00Z",
      to: "2024-01-02T00:00:00Z",
    });
    expect(out).toEqual({ ms: 86_400_000, seconds: 86_400, minutes: 1440, hours: 24, days: 1 });
  });

  test("diff é negativo quando `to` é anterior a `from`", async () => {
    const out = await run(dateTimeHandler, "date_time", {
      operation: "diff",
      from: "2024-01-02T00:00:00Z",
      to: "2024-01-01T00:00:00Z",
    });
    expect(out.ms).toBe(-86_400_000);
    expect(out.days).toBe(-1);
  });

  test("diff com from/to inválidos é rejeitado", async () => {
    await expect(
      run(dateTimeHandler, "date_time", { operation: "diff", from: "xx", to: "yy" }),
    ).rejects.toThrow(/diff: from\/to inválidos/);
    await expect(run(dateTimeHandler, "date_time", { operation: "diff" })).rejects.toThrow(
      /diff: from\/to inválidos/,
    );
  });

  test("operation não suportada é rejeitada", async () => {
    await expect(run(dateTimeHandler, "date_time", { operation: "nope" })).rejects.toThrow(
      /date_time: operation "nope" não suportada/,
    );
  });
});
