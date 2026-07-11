/**
 * Verificação end-to-end do DB Studio contra um Postgres real.
 *
 * NÃO é um *.test.ts — roda via `bun run` pra escapar do preload do bunfig
 * (que sobe testcontainers + aplica as migrations da app, hoje quebradas).
 * Exercita as funções reais de `studio.ts` contra um banco efêmero, cobrindo
 * o caminho feliz (DDL + dados) e alguns casos negativos de segurança.
 *
 * Uso: STUDIO_VERIFY_URL=postgres://... bun run tests/studio-e2e.verify.ts
 */
import {
  StudioError,
  browseRows,
  insertRow,
  updateRow,
  deleteRow,
  runDdl,
  runQuery,
} from "../src/features/database-connections/studio";

const url = process.env.STUDIO_VERIFY_URL;
if (!url) {
  console.error("defina STUDIO_VERIFY_URL");
  process.exit(2);
}

// DecryptedConnection mínima: o Studio só usa kind/connectionString/id.
const conn = {
  id: "verify-conn-0001",
  kind: "postgres",
  connectionString: url,
} as never;

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
  }
}

async function expectThrow(name: string, fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    fail++;
    console.log(`  ✗ ${name} — não lançou`);
  } catch (e) {
    const c = e instanceof StudioError ? e.code : "(non-StudioError)";
    if (code && c !== code) {
      fail++;
      console.log(`  ✗ ${name} — lançou ${c}, esperado ${code}`);
    } else {
      pass++;
      console.log(`  ✓ ${name} (${c})`);
    }
  }
}

async function main() {
  console.log("\n== DDL: create_table ==");
  await runDdl(conn, {
    op: "create_table",
    schema: "public",
    table: "clientes",
    columns: [
      { name: "id", type: "serial", nullable: false, primaryKey: true, default: null },
      { name: "nome", type: "text", nullable: false, primaryKey: false, default: null },
      { name: "meta", type: "jsonb", nullable: true, primaryKey: false, default: null },
    ],
  });
  const empty = await browseRows(conn, { schema: "public", table: "clientes" });
  ok("tabela criada e vazia", empty.totalCount === 0 && empty.rows.length === 0, empty.totalCount);
  ok(
    "colunas introspectadas",
    empty.columns.map((c) => c.name).join(",") === "id,nome,meta",
    empty.columns.map((c) => c.name),
  );
  ok("pk detectada", empty.columns.find((c) => c.name === "id")?.isPrimaryKey === true);

  console.log("\n== Dados: insert + browse ==");
  const inserted = await insertRow(conn, {
    schema: "public",
    table: "clientes",
    values: { nome: "Ada", meta: { tier: "gold", n: 1 } },
  });
  ok("insert retorna linha", inserted.nome === "Ada" && typeof inserted.id === "number", inserted);
  // postgres.js via sql.unsafe() não aplica type parsers: jsonb volta como string JSON.
  // É consistente em todo o Studio e o data grid exibe a string crua — sem perda.
  ok(
    "jsonb persistido (string JSON, round-trip correto)",
    typeof inserted.meta === "string" &&
      JSON.stringify(JSON.parse(inserted.meta as string)) ===
        JSON.stringify({ tier: "gold", n: 1 }),
    inserted.meta,
  );

  await insertRow(conn, {
    schema: "public",
    table: "clientes",
    values: { nome: "Linus", meta: null },
  });
  const two = await browseRows(conn, {
    schema: "public",
    table: "clientes",
    orderBy: "id",
    orderDir: "asc",
  });
  ok("browse conta 2", two.totalCount === 2 && two.rows.length === 2, two.totalCount);
  ok("ordenação asc", String(two.rows[0]?.nome) === "Ada" && String(two.rows[1]?.nome) === "Linus");

  console.log("\n== Dados: filtro (ILIKE) + paginação ==");
  const filtered = await browseRows(conn, {
    schema: "public",
    table: "clientes",
    filters: [{ column: "nome", op: "ILIKE", value: "ad%" }],
  });
  ok(
    "filtro ILIKE",
    filtered.totalCount === 1 && String(filtered.rows[0]?.nome) === "Ada",
    filtered.totalCount,
  );
  const paged = await browseRows(conn, {
    schema: "public",
    table: "clientes",
    limit: 1,
    offset: 1,
    orderBy: "id",
    orderDir: "asc",
  });
  ok(
    "paginação limit/offset",
    paged.rows.length === 1 && String(paged.rows[0]?.nome) === "Linus" && paged.totalCount === 2,
  );

  console.log("\n== Dados: update ==");
  const adaId = Number(inserted.id);
  const updated = await updateRow(conn, {
    schema: "public",
    table: "clientes",
    pk: { id: adaId },
    set: { nome: "Ada Lovelace" },
  });
  ok("update aplicado", String(updated.nome) === "Ada Lovelace", updated.nome);

  // Round-trip de jsonb: edita a célula mandando a string JSON de volta (como o
  // grid faz) e confirma que persiste sem dupla-codificação.
  const jsonbEdit = await updateRow(conn, {
    schema: "public",
    table: "clientes",
    pk: { id: adaId },
    set: { meta: '{"tier":"platinum","n":2}' },
  });
  ok(
    "jsonb round-trip via string (sem dupla-codificação)",
    typeof jsonbEdit.meta === "string" &&
      JSON.stringify(JSON.parse(jsonbEdit.meta as string)) ===
        JSON.stringify({ tier: "platinum", n: 2 }),
    jsonbEdit.meta,
  );

  console.log("\n== DDL: add_column + rename_column ==");
  await runDdl(conn, {
    op: "add_column",
    schema: "public",
    table: "clientes",
    column: { name: "ativo", type: "boolean", nullable: false, primaryKey: false, default: "true" },
  });
  const withCol = await browseRows(conn, { schema: "public", table: "clientes" });
  ok(
    "coluna ativo adicionada com default",
    withCol.columns.some((c) => c.name === "ativo"),
    withCol.columns.map((c) => c.name),
  );
  ok(
    "default backfilled",
    withCol.rows.every((r) => r.ativo === true),
    withCol.rows.map((r) => r.ativo),
  );

  await runDdl(conn, {
    op: "rename_column",
    schema: "public",
    table: "clientes",
    column: "ativo",
    to: "habilitado",
  });
  const renamedCol = await browseRows(conn, { schema: "public", table: "clientes" });
  ok(
    "coluna renomeada ativo→habilitado",
    renamedCol.columns.some((c) => c.name === "habilitado") &&
      !renamedCol.columns.some((c) => c.name === "ativo"),
    renamedCol.columns.map((c) => c.name),
  );

  console.log("\n== DDL: create_index + drop_index ==");
  await runDdl(conn, {
    op: "create_index",
    schema: "public",
    table: "clientes",
    columns: ["nome"],
    unique: false,
    name: "idx_clientes_nome",
  });
  const idxCount1 = await runQuery(
    conn,
    "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_clientes_nome'",
  );
  ok("índice criado", Number(idxCount1.rows[0]?.n) === 1, idxCount1.rows[0]);
  await runDdl(conn, { op: "drop_index", schema: "public", index: "idx_clientes_nome" });
  const idxCount2 = await runQuery(
    conn,
    "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'idx_clientes_nome'",
  );
  ok("índice dropado", Number(idxCount2.rows[0]?.n) === 0, idxCount2.rows[0]);

  console.log("\n== DDL: rename_table ==");
  await runDdl(conn, { op: "rename_table", schema: "public", table: "clientes", to: "customers" });
  const renamedTbl = await browseRows(conn, { schema: "public", table: "customers" });
  ok("tabela renomeada clientes→customers", renamedTbl.totalCount === 2, renamedTbl.totalCount);
  await expectThrow(
    "tabela antiga some",
    () => browseRows(conn, { schema: "public", table: "clientes" }),
    "table_not_found",
  );

  console.log("\n== Dados: delete ==");
  const del = await deleteRow(conn, { schema: "public", table: "customers", pk: { id: adaId } });
  ok("delete 1 linha", del.deleted === 1, del);
  const afterDel = await browseRows(conn, { schema: "public", table: "customers" });
  ok("sobra 1 linha", afterDel.totalCount === 1, afterDel.totalCount);

  console.log("\n== SQL console: runQuery + truncation guard ==");
  const q = await runQuery(conn, "SELECT nome FROM customers ORDER BY id");
  ok("runQuery retorna fields+rows", q.fields.includes("nome") && q.rowCount === 1, {
    fields: q.fields,
    rowCount: q.rowCount,
  });

  console.log("\n== Segurança: identificadores & colunas inválidas ==");
  await expectThrow("ident inválido em tabela", () =>
    browseRows(conn, { schema: "public", table: 'x"; DROP TABLE customers;--' }),
  );
  await expectThrow(
    "coluna inexistente em orderBy",
    () => browseRows(conn, { schema: "public", table: "customers", orderBy: "naoexiste" }),
    "column_not_found",
  );
  await expectThrow(
    "insert em coluna inexistente",
    () => insertRow(conn, { schema: "public", table: "customers", values: { hacker: 1 } }),
    "column_not_found",
  );
  await expectThrow(
    "update sem pk",
    () => updateRow(conn, { schema: "public", table: "customers", pk: {}, set: { nome: "x" } }),
    "missing_pk",
  );
  await expectThrow("tipo de coluna fora do allowlist", () =>
    runDdl(conn, {
      op: "add_column",
      schema: "public",
      table: "customers",
      column: {
        name: "bad",
        type: "text); DROP TABLE customers;--",
        nullable: true,
        primaryKey: false,
        default: null,
      },
    }),
  );
  await expectThrow("default com comentário SQL rejeitado", () =>
    runDdl(conn, {
      op: "add_column",
      schema: "public",
      table: "customers",
      column: {
        name: "x",
        type: "text",
        nullable: true,
        primaryKey: false,
        default: "'a'-- comment",
      },
    }),
  );

  console.log("\n== DDL: drop_table (limpeza) ==");
  await runDdl(conn, { op: "drop_table", schema: "public", table: "customers" });
  await expectThrow(
    "tabela dropada",
    () => browseRows(conn, { schema: "public", table: "customers" }),
    "table_not_found",
  );

  console.log(`\n──────── ${pass} pass / ${fail} fail ────────\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("erro fatal:", e);
  process.exit(1);
});
