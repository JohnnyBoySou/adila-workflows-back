/**
 * Unit tests puros de `diffDefinitions` — sem DB, sem testcontainers.
 *
 * Cobre o buraco de cobertura da lógica de diff de definitions:
 *  - nós added/removed/changed por id
 *  - field-paths de `config` (recursivo)
 *  - mudança de `type`
 *  - `position` ignorado (layout)
 *  - contagem de edges por tupla (from,to,label)
 *  - equivalência entre formato engine e formato React Flow
 *  - defs vazias/malformadas não crasham
 */
import { describe, expect, test } from "bun:test";
import { diffDefinitions } from "../src/features/workflow-versions/diff";

describe("diffDefinitions — nós", () => {
  test("nó adicionado aparece em nodes.added com id/type/label", () => {
    // Arrange
    const from = { nodes: [{ id: "a", type: "start", config: {} }], edges: [] };
    const to = {
      nodes: [
        { id: "a", type: "start", config: {} },
        { id: "b", type: "http", label: "Fetch API", config: {} },
      ],
      edges: [],
    };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.added).toHaveLength(1);
    expect(diff.nodes.added[0]).toEqual({ id: "b", type: "http", label: "Fetch API" });
    expect(diff.nodes.removed).toHaveLength(0);
    expect(diff.nodes.changed).toHaveLength(0);
  });

  test("nó removido aparece em nodes.removed com id/type/label", () => {
    // Arrange
    const from = {
      nodes: [
        { id: "a", type: "start", config: {} },
        { id: "b", type: "http", label: "Fetch API", config: {} },
      ],
      edges: [],
    };
    const to = { nodes: [{ id: "a", type: "start", config: {} }], edges: [] };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.removed).toHaveLength(1);
    expect(diff.nodes.removed[0]).toEqual({ id: "b", type: "http", label: "Fetch API" });
    expect(diff.nodes.added).toHaveLength(0);
  });

  test("nó com um campo de config alterado aparece em changed com field-path certo", () => {
    // Arrange
    const from = {
      nodes: [{ id: "q", type: "query", config: { query: "SELECT 1" } }],
      edges: [],
    };
    const to = {
      nodes: [{ id: "q", type: "query", config: { query: "SELECT 2" } }],
      edges: [],
    };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0].id).toBe("q");
    expect(diff.nodes.changed[0].type).toBe("query");
    expect(diff.nodes.changed[0].fields).toEqual(["config.query"]);
  });

  test("múltiplos campos de config alterados listam todos os field-paths", () => {
    // Arrange
    const from = {
      nodes: [{ id: "q", type: "query", config: { query: "SELECT 1", limit: 10 } }],
      edges: [],
    };
    const to = {
      nodes: [{ id: "q", type: "query", config: { query: "SELECT 2", limit: 20 } }],
      edges: [],
    };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0].fields).toEqual(
      expect.arrayContaining(["config.query", "config.limit"]),
    );
    expect(diff.nodes.changed[0].fields).toHaveLength(2);
  });

  test("field-path desce recursivamente em config aninhado", () => {
    // Arrange
    const from = {
      nodes: [{ id: "q", type: "query", config: { db: { conn: { host: "old" } } } }],
      edges: [],
    };
    const to = {
      nodes: [{ id: "q", type: "query", config: { db: { conn: { host: "new" } } } }],
      edges: [],
    };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.changed[0].fields).toEqual(["config.db.conn.host"]);
  });

  test("mudança de type do nó lista 'type' em fields", () => {
    // Arrange
    const from = { nodes: [{ id: "n", type: "http", config: {} }], edges: [] };
    const to = { nodes: [{ id: "n", type: "graphql", config: {} }], edges: [] };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.changed).toHaveLength(1);
    expect(diff.nodes.changed[0].fields).toContain("type");
  });

  test("mudança de type e de config lista ambos em fields", () => {
    // Arrange
    const from = { nodes: [{ id: "n", type: "http", config: { url: "a" } }], edges: [] };
    const to = { nodes: [{ id: "n", type: "graphql", config: { url: "b" } }], edges: [] };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.changed[0].fields).toEqual(
      expect.arrayContaining(["type", "config.url"]),
    );
  });

  test("nó idêntico NÃO aparece em changed", () => {
    // Arrange
    const def = {
      nodes: [{ id: "n", type: "http", config: { url: "https://x", retries: 3 } }],
      edges: [],
    };

    // Act
    const diff = diffDefinitions(def, def);

    // Assert
    expect(diff.nodes.changed).toHaveLength(0);
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.nodes.removed).toHaveLength(0);
  });

  test("position diferente mas config igual NÃO conta como changed (layout ignorado)", () => {
    // Arrange
    const from = {
      nodes: [{ id: "n", type: "http", config: { url: "x" }, position: { x: 0, y: 0 } }],
      edges: [],
    };
    const to = {
      nodes: [{ id: "n", type: "http", config: { url: "x" }, position: { x: 999, y: 42 } }],
      edges: [],
    };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.nodes.changed).toHaveLength(0);
  });
});

describe("diffDefinitions — edges", () => {
  test("conta added e removed por tupla (from,to,label)", () => {
    // Arrange
    const from = {
      nodes: [],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    const to = {
      nodes: [],
      edges: [
        { from: "a", to: "b" },
        { from: "c", to: "d" },
      ],
    };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    // (b→c) removida, (c→d) adicionada, (a→b) mantida.
    expect(diff.edges.added).toBe(1);
    expect(diff.edges.removed).toBe(1);
  });

  test("mudar só o label de uma edge conta como 1 removed + 1 added", () => {
    // Arrange
    const from = { nodes: [], edges: [{ from: "a", to: "b", label: "sim" }] };
    const to = { nodes: [], edges: [{ from: "a", to: "b", label: "nao" }] };

    // Act
    const diff = diffDefinitions(from, to);

    // Assert
    expect(diff.edges.added).toBe(1);
    expect(diff.edges.removed).toBe(1);
  });

  test("edges idênticas não geram diff", () => {
    // Arrange
    const def = {
      nodes: [],
      edges: [
        { from: "a", to: "b", label: "x" },
        { from: "b", to: "c" },
      ],
    };

    // Act
    const diff = diffDefinitions(def, def);

    // Assert
    expect(diff.edges.added).toBe(0);
    expect(diff.edges.removed).toBe(0);
  });
});

describe("diffDefinitions — formato React Flow", () => {
  test("nós com data.label são interpretados igual ao label solto do formato engine", () => {
    // Arrange
    const engine = {
      nodes: [{ id: "n", type: "http", label: "Chamada HTTP", config: {} }],
      edges: [],
    };
    const reactFlow = {
      nodes: [{ id: "n", type: "http", data: { label: "Chamada HTTP" }, config: {} }],
      edges: [],
    };

    // Act: adicionar o mesmo nó (a partir do vazio) nos dois formatos.
    const fromEmpty = { nodes: [], edges: [] };
    const diffEngine = diffDefinitions(fromEmpty, engine);
    const diffReactFlow = diffDefinitions(fromEmpty, reactFlow);

    // Assert: ambos produzem o mesmo added com label resolvido.
    expect(diffEngine.nodes.added[0]).toEqual({ id: "n", type: "http", label: "Chamada HTTP" });
    expect(diffReactFlow.nodes.added[0]).toEqual(diffEngine.nodes.added[0]);
  });

  test("edges com source/target são interpretadas igual a from/to", () => {
    // Arrange
    const engine = { nodes: [], edges: [{ from: "a", to: "b" }] };
    const reactFlow = { nodes: [], edges: [{ source: "a", target: "b" }] };

    // Act: diff engine→reactFlow deve ser vazio (mesma edge lógica).
    const diff = diffDefinitions(engine, reactFlow);

    // Assert
    expect(diff.edges.added).toBe(0);
    expect(diff.edges.removed).toBe(0);
  });
});

describe("diffDefinitions — defs vazias/malformadas", () => {
  test("duas defs vazias produzem diff vazio sem crashar", () => {
    // Arrange / Act
    const diff = diffDefinitions({}, {});

    // Assert
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.nodes.removed).toHaveLength(0);
    expect(diff.nodes.changed).toHaveLength(0);
    expect(diff.edges.added).toBe(0);
    expect(diff.edges.removed).toBe(0);
  });

  test("def sem nodes/edges é tratada como vazia", () => {
    // Arrange
    const from = { nodes: [{ id: "a", type: "start", config: {} }], edges: [{ from: "a", to: "b" }] };
    const to = {};

    // Act
    const diff = diffDefinitions(from, to);

    // Assert: tudo que existia em `from` é removido.
    expect(diff.nodes.removed).toHaveLength(1);
    expect(diff.edges.removed).toBe(1);
    expect(diff.nodes.added).toHaveLength(0);
    expect(diff.edges.added).toBe(0);
  });

  test("nós malformados (sem id/type) são ignorados sem crashar", () => {
    // Arrange
    const from = { nodes: [], edges: [] };
    const to = {
      nodes: [
        { id: "ok", type: "http", config: {} },
        { type: "sem-id", config: {} },
        { id: "sem-type", config: {} },
        null,
        "lixo",
      ],
      edges: [{ to: "b" }, { from: "a" }, null],
    };

    // Act
    const diff = diffDefinitions(from, to as Record<string, unknown>);

    // Assert: só o nó válido entra; edges incompletas são descartadas.
    expect(diff.nodes.added).toHaveLength(1);
    expect(diff.nodes.added[0].id).toBe("ok");
    expect(diff.edges.added).toBe(0);
  });
});
