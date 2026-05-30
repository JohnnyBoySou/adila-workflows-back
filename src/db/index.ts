import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";
import * as authSchema from "./auth-schema";
import * as appSchema from "./schema";

// Cliente postgres reutilizável (pool).
// Pool size tunável via env DB_POOL_MAX (default 50 — dimensiona pra ~200 concurrency
// do worker + tráfego HTTP simultâneo sem saturar antes do back, mas precisa de
// `max_connections` ≥ pool × N_processos no Postgres).
const client = postgres(env.DATABASE_URL, {
  max: Number(process.env.DB_POOL_MAX ?? 50),
  idle_timeout: 20,
  connect_timeout: 10,
});

export const schema = { ...appSchema, ...authSchema };
export const db = drizzle(client, { schema });
