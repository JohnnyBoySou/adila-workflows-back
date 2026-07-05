/**
 * Runner de migrations que SURFACE o erro real do Postgres e ESPERA o banco
 * ficar acessível antes de migrar.
 *
 * Por que não usar `drizzle-kit migrate` direto: o CLI engole a exceção e sai
 * com código 1 mostrando só os NOTICE de bootstrap (`schema "drizzle" already
 * exists`, `__drizzle_migrations already exists`). Num deploy isso deixa a causa
 * raiz invisível. O `migrate()` do drizzle-orm, por outro lado, LANÇA o erro —
 * aqui a gente captura e imprime tudo (code, detail, statement, position).
 *
 * Por que o retry de conexão: o banco é Neon com scale-to-zero — quando fica
 * ocioso o compute desliga, e a primeira conexão dá `ETIMEDOUT` enquanto ele
 * acorda (leva alguns segundos). No deploy o migrate roda ANTES do app (que já
 * é resiliente a isso), então bate no Neon adormecido e morre no primeiro
 * comando (`CREATE SCHEMA IF NOT EXISTS "drizzle"`). O loop de espera dá tempo
 * do compute subir; se o banco for genuinamente inalcançável (URL errada,
 * serviço fora), falha com mensagem clara em vez de crash-loop silencioso.
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

// Erros de conexão são transitórios no boot; erros de SQL/auth não são.
const CONNECTION_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "CONNECT_TIMEOUT",
]);

const MAX_WAIT_MS = Number(process.env.MIGRATE_DB_WAIT_MS ?? 60_000);
const RETRY_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isConnectionError = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
};

/** Faz ping (`select 1`) até o banco responder ou estourar o teto de espera. */
async function waitForDatabase(sql: postgres.Sql): Promise<void> {
  const deadline = Date.now() + MAX_WAIT_MS;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await sql`select 1`;
      if (attempt > 1) console.log(`[migrate] banco acessível (tentativa ${attempt}).`);
      return;
    } catch (error) {
      if (!isConnectionError(error) || Date.now() >= deadline) throw error;
      const code = (error as { code?: string }).code;
      console.warn(
        `[migrate] banco ainda não acessível (${code}); retry em ${RETRY_DELAY_MS}ms...`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// connect_timeout em segundos — evita que uma tentativa fique pendurada além do
// intervalo de retry.
const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

try {
  await waitForDatabase(sql);
  console.log("[migrate] aplicando migrations pendentes...");
  await migrate(drizzle(sql), { migrationsFolder });
  console.log("[migrate] OK — banco atualizado.");
  await sql.end();
  process.exit(0);
} catch (error) {
  console.error("[migrate] FALHOU. Erro real:");
  console.error(error);
  const pgError = error as Record<string, unknown>;
  for (const key of ["code", "detail", "hint", "where", "position", "query", "severity"]) {
    if (pgError[key] !== undefined) {
      console.error(`  ${key}: ${String(pgError[key])}`);
    }
  }
  if (isConnectionError(error)) {
    console.error(
      `[migrate] Dica: erro de CONEXÃO (não de SQL) após esperar ${MAX_WAIT_MS}ms. ` +
        "Se for Neon scale-to-zero, aumente MIGRATE_DB_WAIT_MS; senão verifique se " +
        "DATABASE_URL aponta pro host certo e se o banco está no ar.",
    );
  }
  await sql.end({ timeout: 5 });
  process.exit(1);
}
