/**
 * Seed inicial — cria o usuário dev padrão via Better Auth (com hashing correto).
 *
 * Rode com: `bun run db:seed`
 * Idempotente: se o usuário já existir, apenas avisa e sai 0.
 */
import { eq } from "drizzle-orm";
import { auth, ensureUserOrganization } from "../src/lib/auth";
import { db } from "../src/db";
import { user } from "../src/db/auth-schema";
import { logger } from "../src/lib/logger";

const log = logger.child({ component: "seed" });

const SEED_USER = {
  name: "João Sousa",
  email: "dev.joaosousa@gmail.com",
  password: "Eco.2020@",
} as const;

async function main() {
  const existing = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, SEED_USER.email))
    .limit(1);

  if (existing.length > 0) {
    const userId = existing[0]!.id;
    log.info({ userId, email: SEED_USER.email }, "user already exists, ensuring organization");
    const orgId = await ensureUserOrganization({
      userId,
      email: SEED_USER.email,
      name: SEED_USER.name,
    });
    log.info({ userId, orgId }, "organization ready");
    return;
  }

  const result = await auth.api.signUpEmail({
    body: SEED_USER,
  });

  log.info({ userId: result.user.id, email: result.user.email }, "user created");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, "seed failed");
    process.exit(1);
  });
