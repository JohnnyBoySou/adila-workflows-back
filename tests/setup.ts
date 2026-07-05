import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Bootstrap de testes: sobe Postgres + Redis efêmeros via Testcontainers, aplica
 * as migrations e exporta as URLs via env ANTES de qualquer `src/*` importar.
 *
 * Carregado como preload pelo `bunfig.toml` — top-level await garante que
 * `process.env` esteja preenchido antes dos test files importarem `src/`.
 */

const pg = await new PostgreSqlContainer("postgres:16-alpine").start();
const redis = await new RedisContainer("redis:7-alpine").start();

process.env.DATABASE_URL = pg.getConnectionUri();
process.env.REDIS_URL = redis.getConnectionUrl();
process.env.BETTER_AUTH_SECRET = "test-secret-not-real";
// 32 bytes em base64, determinístico — sem segredo real, é teste.
process.env.ENCRYPTION_KEY = Buffer.alloc(32, "test").toString("base64");
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";

// Caminho resolvido a partir deste arquivo (back/tests/setup.ts → back/drizzle),
// não do cwd — assim o preload funciona mesmo rodando `bun test` da raiz do repo.
const migrationsFolder = new URL("../drizzle", import.meta.url).pathname;
const migrationClient = postgres(process.env.DATABASE_URL, { max: 1 });
await migrate(drizzle(migrationClient), { migrationsFolder });
await migrationClient.end();

// Ryuk (reaper do testcontainers) faz o cleanup mesmo se a gente não desligar
// explicitamente, mas tentamos uma parada graciosa no exit normal.
process.on("beforeExit", async () => {
  await Promise.allSettled([pg.stop(), redis.stop()]);
});
