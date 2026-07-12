/**
 * Seed inicial — cria o usuário dev padrão + organização no espelho local.
 *
 * Rode com: `bun run db:seed`
 * Idempotente: se o usuário já existir, apenas garante a organização e sai 0.
 *
 * Auth é federada no Identity (não há mais senha local): este seed só popula
 * `user`/`organization`/`member` pra dev/testes que não passam pelo login
 * federado. Em produção, o provisioning JIT (`src/lib/identity-auth.ts`) cria
 * essas linhas a partir do token do Identity.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { logger } from "../src/lib/logger";

const log = logger.child({ component: "seed" });

const SEED_USER = {
  name: "João Sousa",
  email: "dev.joaosousa@gmail.com",
} as const;

async function ensureOrganization(userId: string): Promise<string> {
  const [existing] = await db
    .select({ orgId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .limit(1);
  if (existing) return existing.orgId;

  const orgId = crypto.randomUUID();
  await db.insert(organization).values({
    id: orgId,
    name: `${SEED_USER.name}'s Workspace`,
    slug: `dev-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
  return orgId;
}

async function main() {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, SEED_USER.email))
    .limit(1);

  if (existing) {
    const orgId = await ensureOrganization(existing.id);
    log.info({ userId: existing.id, orgId }, "user already exists, organization ready");
    return;
  }

  const userId = crypto.randomUUID();
  await db.insert(user).values({
    id: userId,
    name: SEED_USER.name,
    email: SEED_USER.email,
    emailVerified: true,
  });
  const orgId = await ensureOrganization(userId);
  log.info({ userId, orgId }, "user created, organization ready");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    log.error({ err }, "seed failed");
    process.exit(1);
  });
