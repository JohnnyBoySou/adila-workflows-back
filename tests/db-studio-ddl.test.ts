/**
 * Unit dos construtores de DDL do Studio — a parte crítica de segurança que
 * não depende de banco. Cobre:
 *  - identificadores válidos citados; inválidos rejeitados (sem SQL solto)
 *  - allowlist de tipos de coluna + modificador de tamanho
 *  - rejeição de defaults com tokens perigosos (`;`, `--`, comentários)
 *  - cada operação DDL produz o statement esperado
 */
import { describe, expect, test } from "bun:test";
import {
  assertColumnType,
  assertFkAction,
  buildDdl,
  StudioError,
} from "../src/features/database-connections/studio";

describe("assertColumnType", () => {
  test("aceita tipos do allowlist", () => {
    expect(assertColumnType("text")).toBe("text");
    expect(assertColumnType("TIMESTAMPTZ")).toBe("timestamptz");
    expect(assertColumnType("varchar(255)")).toBe("varchar(255)");
    expect(assertColumnType("numeric(10,2)")).toBe("numeric(10,2)");
  });

  test("rejeita tipo fora do allowlist", () => {
    expect(() => assertColumnType("money; DROP TABLE x")).toThrow(StudioError);
    expect(() => assertColumnType("text); --")).toThrow(StudioError);
  });
});

describe("buildDdl · create_table", () => {
  test("monta CREATE TABLE com colunas citadas", () => {
    const sql = buildDdl({
      op: "create_table",
      table: "users",
      columns: [
        { name: "id", type: "uuid", primaryKey: true },
        { name: "email", type: "text", nullable: false },
        { name: "age", type: "integer", default: "0" },
      ],
    });
    expect(sql).toContain('CREATE TABLE "public"."users"');
    expect(sql).toContain('"id" uuid PRIMARY KEY');
    expect(sql).toContain('"email" text NOT NULL');
    expect(sql).toContain('"age" integer DEFAULT 0');
  });

  test("default com ponto-e-vírgula é rejeitado", () => {
    expect(() =>
      buildDdl({
        op: "create_table",
        table: "t",
        columns: [{ name: "a", type: "text", default: "'x'; DROP TABLE t" }],
      }),
    ).toThrow(StudioError);
  });

  test("nome de tabela inválido é rejeitado (nunca vira SQL solto)", () => {
    expect(() =>
      buildDdl({
        op: "create_table",
        table: "users; DROP TABLE users",
        columns: [{ name: "a", type: "text" }],
      }),
    ).toThrow(StudioError);
  });
});

describe("buildDdl · alter / index / drop", () => {
  test("add_column", () => {
    expect(buildDdl({ op: "add_column", table: "t", column: { name: "x", type: "boolean" } })).toBe(
      'ALTER TABLE "public"."t" ADD COLUMN "x" boolean',
    );
  });

  test("drop_column", () => {
    expect(buildDdl({ op: "drop_column", table: "t", column: "x" })).toBe(
      'ALTER TABLE "public"."t" DROP COLUMN "x"',
    );
  });

  test("rename_table e rename_column", () => {
    expect(buildDdl({ op: "rename_table", table: "a", to: "b" })).toBe(
      'ALTER TABLE "public"."a" RENAME TO "b"',
    );
    expect(buildDdl({ op: "rename_column", table: "a", column: "c", to: "d" })).toBe(
      'ALTER TABLE "public"."a" RENAME COLUMN "c" TO "d"',
    );
  });

  test("create_index unique com nome derivado", () => {
    const sql = buildDdl({ op: "create_index", table: "users", columns: ["email"], unique: true });
    expect(sql).toBe('CREATE UNIQUE INDEX "idx_users_email" ON "public"."users" ("email")');
  });

  test("drop_table e drop_index", () => {
    expect(buildDdl({ op: "drop_table", table: "t" })).toBe('DROP TABLE "public"."t"');
    expect(buildDdl({ op: "drop_index", index: "idx_x" })).toBe('DROP INDEX "public"."idx_x"');
  });

  test("schema customizado é citado", () => {
    expect(buildDdl({ op: "drop_table", schema: "app", table: "t" })).toBe('DROP TABLE "app"."t"');
  });
});

describe("assertFkAction", () => {
  test("aceita e normaliza ações do allowlist", () => {
    expect(assertFkAction("cascade")).toBe("CASCADE");
    expect(assertFkAction("set null")).toBe("SET NULL");
    expect(assertFkAction("  no   action ")).toBe("NO ACTION");
    expect(assertFkAction("RESTRICT")).toBe("RESTRICT");
    expect(assertFkAction("set default")).toBe("SET DEFAULT");
  });

  test("rejeita ação fora do allowlist (sem SQL solto)", () => {
    expect(() => assertFkAction("CASCADE; DROP TABLE x")).toThrow(StudioError);
    expect(() => assertFkAction("DELETE")).toThrow(StudioError);
    expect(() => assertFkAction("")).toThrow(StudioError);
  });
});

describe("buildDdl · add_foreign_key", () => {
  test("FK simples com nome derivado e ações referenciais", () => {
    const sql = buildDdl({
      op: "add_foreign_key",
      table: "posts",
      columns: ["author_id"],
      refTable: "users",
      refColumns: ["id"],
      onDelete: "cascade",
      onUpdate: "restrict",
    });
    expect(sql).toBe(
      'ALTER TABLE "public"."posts" ADD CONSTRAINT "fk_posts_author_id" ' +
        'FOREIGN KEY ("author_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
  });

  test("FK composta preserva ordem das colunas e usa nome explícito", () => {
    const sql = buildDdl({
      op: "add_foreign_key",
      schema: "app",
      table: "line_items",
      columns: ["order_id", "tenant_id"],
      refSchema: "app",
      refTable: "orders",
      refColumns: ["id", "tenant_id"],
      name: "fk_li_order",
    });
    expect(sql).toBe(
      'ALTER TABLE "app"."line_items" ADD CONSTRAINT "fk_li_order" ' +
        'FOREIGN KEY ("order_id", "tenant_id") REFERENCES "app"."orders" ("id", "tenant_id")',
    );
  });

  test("refSchema cai pro schema da tabela quando ausente", () => {
    const sql = buildDdl({
      op: "add_foreign_key",
      schema: "app",
      table: "posts",
      columns: ["author_id"],
      refTable: "users",
      refColumns: ["id"],
    });
    expect(sql).toContain('REFERENCES "app"."users"');
  });

  test("número de colunas divergente é rejeitado", () => {
    expect(() =>
      buildDdl({
        op: "add_foreign_key",
        table: "posts",
        columns: ["a", "b"],
        refTable: "users",
        refColumns: ["id"],
      }),
    ).toThrow(StudioError);
  });

  test("ação referencial inválida é rejeitada", () => {
    expect(() =>
      buildDdl({
        op: "add_foreign_key",
        table: "posts",
        columns: ["author_id"],
        refTable: "users",
        refColumns: ["id"],
        onDelete: "DROP",
      }),
    ).toThrow(StudioError);
  });

  test("coluna inválida nunca vira SQL solto", () => {
    expect(() =>
      buildDdl({
        op: "add_foreign_key",
        table: "posts",
        columns: ["author_id) ; DROP TABLE posts --"],
        refTable: "users",
        refColumns: ["id"],
      }),
    ).toThrow(StudioError);
  });
});

describe("buildDdl · drop_constraint", () => {
  test("DROP CONSTRAINT com identificadores citados", () => {
    expect(buildDdl({ op: "drop_constraint", table: "posts", name: "fk_posts_author_id" })).toBe(
      'ALTER TABLE "public"."posts" DROP CONSTRAINT "fk_posts_author_id"',
    );
  });

  test("nome de constraint inválido é rejeitado", () => {
    expect(() =>
      buildDdl({ op: "drop_constraint", table: "posts", name: "x; DROP TABLE posts" }),
    ).toThrow(StudioError);
  });
});

describe("buildDdl · alter_column_type", () => {
  test("ALTER COLUMN TYPE simples", () => {
    expect(buildDdl({ op: "alter_column_type", table: "t", column: "amount", type: "numeric(10,2)" })).toBe(
      'ALTER TABLE "public"."t" ALTER COLUMN "amount" TYPE numeric(10,2)',
    );
  });

  test("com cláusula USING", () => {
    expect(
      buildDdl({
        op: "alter_column_type",
        table: "t",
        column: "id",
        type: "integer",
        using: "id::integer",
      }),
    ).toBe('ALTER TABLE "public"."t" ALTER COLUMN "id" TYPE integer USING id::integer');
  });

  test("USING com tokens perigosos é rejeitado", () => {
    expect(() =>
      buildDdl({
        op: "alter_column_type",
        table: "t",
        column: "id",
        type: "integer",
        using: "id::integer; DROP TABLE t",
      }),
    ).toThrow(StudioError);
  });

  test("tipo fora do allowlist é rejeitado", () => {
    expect(() =>
      buildDdl({ op: "alter_column_type", table: "t", column: "id", type: "money" }),
    ).toThrow(StudioError);
  });
});
