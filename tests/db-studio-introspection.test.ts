/**
 * Integração da introspecção de Foreign Keys — roda contra o Postgres efêmero
 * do Testcontainers (setup.ts). Cobre o caminho novo de `fetchPostgresSchema`:
 *  - FK simples aparece em `relationships` com colunas/ref corretos
 *  - ações referenciais (ON DELETE / ON UPDATE) mapeadas do pg_constraint
 *  - FK composta preserva a ordem das colunas (unnest WITH ORDINALITY)
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  fetchPostgresSchema,
  invalidateIntrospection,
} from "../src/features/database-connections/introspection";

const url = process.env.DATABASE_URL!;
const SCHEMA = "studio_fk_test";
const connId = "introspection-fk-test";

beforeAll(async () => {
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await sql.unsafe(`
      CREATE TABLE ${SCHEMA}.authors (
        id uuid PRIMARY KEY
      )
    `);
    await sql.unsafe(`
      CREATE TABLE ${SCHEMA}.posts (
        id uuid PRIMARY KEY,
        author_id uuid REFERENCES ${SCHEMA}.authors(id) ON DELETE CASCADE ON UPDATE RESTRICT
      )
    `);
    // FK composta — chave referenciada com ordem (a, b).
    await sql.unsafe(`
      CREATE TABLE ${SCHEMA}.orders (
        a int,
        b int,
        PRIMARY KEY (a, b)
      )
    `);
    await sql.unsafe(`
      CREATE TABLE ${SCHEMA}.line_items (
        order_a int,
        order_b int,
        CONSTRAINT fk_li_order FOREIGN KEY (order_a, order_b)
          REFERENCES ${SCHEMA}.orders(a, b) ON DELETE SET NULL
      )
    `);
  } finally {
    await sql.end({ timeout: 2 });
  }
  invalidateIntrospection(connId);
});

afterAll(async () => {
  const sql = postgres(url, { max: 1 });
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  } finally {
    await sql.end({ timeout: 2 });
  }
});

describe("fetchPostgresSchema · relationships", () => {
  test("FK simples mapeia colunas, ref e ações referenciais", async () => {
    const schema = await fetchPostgresSchema(connId, url, { force: true });
    const fk = schema.relationships.find(
      (r) => r.schema === SCHEMA && r.table === "posts",
    );
    expect(fk).toBeDefined();
    expect(fk!.columns).toEqual(["author_id"]);
    expect(fk!.refSchema).toBe(SCHEMA);
    expect(fk!.refTable).toBe("authors");
    expect(fk!.refColumns).toEqual(["id"]);
    expect(fk!.onDelete).toBe("CASCADE");
    expect(fk!.onUpdate).toBe("RESTRICT");
  });

  test("FK composta preserva a ordem das colunas", async () => {
    const schema = await fetchPostgresSchema(connId, url, { force: true });
    const fk = schema.relationships.find((r) => r.name === "fk_li_order");
    expect(fk).toBeDefined();
    expect(fk!.table).toBe("line_items");
    expect(fk!.columns).toEqual(["order_a", "order_b"]);
    expect(fk!.refTable).toBe("orders");
    expect(fk!.refColumns).toEqual(["a", "b"]);
    expect(fk!.onDelete).toBe("SET NULL");
    // ON UPDATE não especificado → NO ACTION (default do Postgres).
    expect(fk!.onUpdate).toBe("NO ACTION");
  });

  test("tabela referenciada também é introspectada com sua PK", async () => {
    const schema = await fetchPostgresSchema(connId, url, { force: true });
    const authors = schema.tables.find(
      (t) => t.schema === SCHEMA && t.name === "authors",
    );
    expect(authors).toBeDefined();
    const pk = authors!.columns.find((c) => c.name === "id");
    expect(pk?.isPrimaryKey).toBe(true);
  });
});
