import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../config/env";
import * as authSchema from "./auth-schema";
import * as appSchema from "./schema";

// Cliente postgres reutilizável (pool).
const client = postgres(env.DATABASE_URL, { max: 10 });

export const schema = { ...appSchema, ...authSchema };
export const db = drizzle(client, { schema });
