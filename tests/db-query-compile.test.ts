/**
 * Unit do compilador do query builder (nó `db_query`).
 *
 * Cobre o contrato que o handler depende:
 *  - SELECT/INSERT/UPDATE/DELETE geram SQL + placeholders posicionais
 *  - valores entram sempre como params ($1, $2…), nunca concatenados
 *  - identificadores com caracteres especiais são citados e escapados
 *  - operadores IS NULL / IS NOT NULL não consomem param
 *  - IN expande lista em múltiplos placeholders; IN vazio vira FALSE
 *  - coerção: numérico→number, "true"/"false"→bool, "null"→null
 */
import { describe, expect, test } from "bun:test";
import { compileBuilder, quoteIdent } from "../src/lib/engine/nodes/query-builder/compile";

describe("compileBuilder · SELECT", () => {
  test("seleciona colunas com WHERE parametrizado e ORDER/LIMIT/OFFSET", () => {
    const { sql, params } = compileBuilder({
      op: "select",
      table: "users",
      columns: ["id", "email"],
      filters: [{ id: "1", column: "org_id", op: "=", value: "org-1" }],
      orderBy: { column: "created_at", direction: "desc" },
      limit: 10,
      offset: 5,
    });
    expect(sql).toContain("SELECT id, email");
    expect(sql).toContain("FROM users");
    expect(sql).toContain("WHERE org_id = $1");
    expect(sql).toContain("ORDER BY created_at DESC");
    expect(sql).toContain("LIMIT 10");
    expect(sql).toContain("OFFSET 5");
    expect(params).toEqual(["org-1"]);
  });

  test("sem colunas vira SELECT *", () => {
    const { sql } = compileBuilder({ op: "select", table: "users" });
    expect(sql).toContain("SELECT *");
  });

  test("LIMIT/OFFSET fracionários são truncados", () => {
    const { sql } = compileBuilder({ op: "select", table: "t", limit: 10.9, offset: 2.9 });
    expect(sql).toContain("LIMIT 10");
    expect(sql).toContain("OFFSET 2");
  });
});

describe("compileBuilder · operadores", () => {
  test("IS NULL / IS NOT NULL não consomem param", () => {
    const { sql, params } = compileBuilder({
      op: "select",
      table: "t",
      filters: [
        { id: "1", column: "a", op: "IS NULL", value: "" },
        { id: "2", column: "b", op: "IS NOT NULL", value: "" },
      ],
    });
    expect(sql).toContain("a IS NULL");
    expect(sql).toContain("b IS NOT NULL");
    expect(params).toEqual([]);
  });

  test("IN expande lista em placeholders", () => {
    const { sql, params } = compileBuilder({
      op: "select",
      table: "t",
      filters: [{ id: "1", column: "status", op: "IN", value: "a, b, c" }],
    });
    expect(sql).toContain("status IN ($1, $2, $3)");
    expect(params).toEqual(["a", "b", "c"]);
  });

  test("IN vazio vira FALSE sem param", () => {
    const { sql, params } = compileBuilder({
      op: "select",
      table: "t",
      filters: [{ id: "1", column: "status", op: "IN", value: "  " }],
    });
    expect(sql).toContain("FALSE");
    expect(params).toEqual([]);
  });
});

describe("compileBuilder · coerção de valores", () => {
  test("numérico, boolean e null são coagidos", () => {
    const { params } = compileBuilder({
      op: "select",
      table: "t",
      filters: [
        { id: "1", column: "age", op: ">", value: "18" },
        { id: "2", column: "active", op: "=", value: "true" },
        { id: "3", column: "deleted", op: "=", value: "null" },
      ],
    });
    expect(params).toEqual([18, true, null]);
  });
});

describe("compileBuilder · INSERT / UPDATE / DELETE", () => {
  test("INSERT com RETURNING", () => {
    const { sql, params } = compileBuilder({
      op: "insert",
      table: "users",
      setValues: [
        { id: "1", column: "email", value: "a@b.com" },
        { id: "2", column: "age", value: "30" },
      ],
    });
    expect(sql).toContain("INSERT INTO users (email, age)");
    expect(sql).toContain("VALUES ($1, $2)");
    expect(sql).toContain("RETURNING *");
    expect(params).toEqual(["a@b.com", 30]);
  });

  test("UPDATE com SET + WHERE numera params na ordem certa", () => {
    const { sql, params } = compileBuilder({
      op: "update",
      table: "users",
      setValues: [{ id: "1", column: "status", value: "active" }],
      filters: [{ id: "2", column: "id", op: "=", value: "u-1" }],
    });
    expect(sql).toContain("SET status = $1");
    expect(sql).toContain("WHERE id = $2");
    expect(params).toEqual(["active", "u-1"]);
  });

  test("DELETE com filtro", () => {
    const { sql, params } = compileBuilder({
      op: "delete",
      table: "logs",
      filters: [{ id: "1", column: "level", op: "=", value: "debug" }],
    });
    expect(sql).toContain("DELETE FROM logs");
    expect(sql).toContain("WHERE level = $1");
    expect(params).toEqual(["debug"]);
  });

  test("returning=false omite RETURNING", () => {
    const { sql } = compileBuilder({
      op: "insert",
      table: "t",
      setValues: [{ id: "1", column: "a", value: "1" }],
      returning: false,
    });
    expect(sql).not.toContain("RETURNING");
  });
});

describe("compileBuilder · segurança de identificadores", () => {
  test("nome simples passa cru; nome com caractere especial é citado e escapado", () => {
    expect(quoteIdent("users")).toBe("users");
    expect(quoteIdent("Weird Name")).toBe('"Weird Name"');
    expect(quoteIdent('a"b')).toBe('"a""b"'); // aspas internas duplicadas
  });

  test("tentativa de injeção via nome de tabela não escapa do identificador citado", () => {
    const { sql, params } = compileBuilder({
      op: "select",
      table: "users; DROP TABLE users; --",
      filters: [{ id: "1", column: "id", op: "=", value: "1" }],
    });
    // Vira um identificador citado inválido (Postgres rejeita), nunca SQL solto.
    expect(sql).toContain('"users; DROP TABLE users; --"');
    expect(params).toEqual([1]);
  });

  test("sem tabela lança erro", () => {
    expect(() => compileBuilder({ op: "select" })).toThrow(/table/);
  });
});
