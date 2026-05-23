/**
 * Back-fill: re-grava em formato cifrado todas as rows `environment_variables`
 * com `is_secret=true` cujo `value` ainda esteja em texto puro.
 *
 * Idempotente — pula rows já cifradas (prefixo `enc:v1:`).
 * Rodar: `bun run scripts/encrypt-secrets-backfill.ts`
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { environmentVariables } from "../src/db/schema";
import { encrypt, isEncrypted } from "../src/lib/crypto";
import { logger } from "../src/lib/logger";

const log = logger.child({ component: "encrypt-secrets-backfill" });

async function main() {
  const rows = await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.isSecret, true));

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isEncrypted(row.value)) {
      skipped++;
      continue;
    }
    await db
      .update(environmentVariables)
      .set({ value: encrypt(row.value), updatedAt: new Date() })
      .where(eq(environmentVariables.id, row.id));
    encrypted++;
  }

  log.info({ total: rows.length, encrypted, alreadyEncrypted: skipped }, "backfill complete");
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, "backfill failed");
  process.exit(1);
});
