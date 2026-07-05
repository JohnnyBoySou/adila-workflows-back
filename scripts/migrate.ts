/**
 * Runner de migrations que SURFACE o erro real do Postgres.
 *
 * Por que não usar `drizzle-kit migrate` direto: o CLI engole a exceção e sai
 * com código 1 mostrando só os NOTICE de bootstrap (`schema "drizzle" already
 * exists`, `__drizzle_migrations already exists`). Num deploy isso deixa a causa
 * raiz invisível. O `migrate()` do drizzle-orm, por outro lado, LANÇA o erro —
 * aqui a gente captura e imprime tudo (code, detail, statement, position).
 *
 * Idempotente: aplica só as migrations pendentes; rodar de novo é no-op.
 *
 * Uso:
 *   bun run scripts/migrate.ts   # (ou `bun run db:migrate`)
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[migrate] DATABASE_URL não definida no ambiente.");
  process.exit(1);
}

// Caminho resolvido a partir deste arquivo (back/scripts → back/drizzle), não do
// cwd — funciona igual rodando de qualquer diretório.
const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;

const sql = postgres(databaseUrl, { max: 1 });

try {
  console.log("[migrate] aplicando migrations pendentes...");
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("[migrate] OK — banco atualizado.");
  await sql.end();
  process.exit(0);
} catch (error) {
  // postgres-js anexa code/detail/hint/position/where + a query que falhou.
  console.error("[migrate] FALHOU. Erro real do Postgres:");
  console.error(error);
  const pgError = error as Record<string, unknown>;
  for (const key of ["code", "detail", "hint", "where", "position", "query", "severity"]) {
    if (pgError[key] !== undefined) {
      console.error(`  ${key}: ${String(pgError[key])}`);
    }
  }
  await sql.end({ timeout: 5 });
  process.exit(1);
}
