/**
 * Back-fill: preenche `workflow_versions.definition_hash` nas rows criadas antes
 * da migração 0013 (coluna adicionada sem backfill → `definition_hash = NULL`).
 *
 * Por que isso importa: a idempotência do publish compara
 * `latest.definitionHash === hashDefinition(draft)`. Com hash NULL, a comparação
 * é sempre falsa (`null === "<hex>"`) → toda republish idêntica cria uma versão
 * duplicada. Preencher o hash fecha esse furo.
 *
 * Idempotente — só toca rows com `definition_hash IS NULL`; rodar de novo é no-op.
 * O hash NÃO é reimplementado aqui: reusa `hashDefinition` (SHA-256 sobre o
 * `definition` serializado com chaves ordenadas) do repository, garantindo que o
 * valor gravado bata byte-a-byte com o que o publish recomputa em runtime.
 *
 * Uso:
 *   bun run scripts/backfill-definition-hash.ts            # aplica
 *   bun run scripts/backfill-definition-hash.ts --dry-run  # só inspeciona
 */
import { count, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "../src/db";
import { workflowVersions } from "../src/db/schema";
import { hashDefinition } from "../src/features/workflow-versions/repository";
import { logger } from "../src/lib/logger";

const log = logger.child({ component: "backfill-definition-hash" });

export interface BackfillResult {
  /** Rows com `definition_hash IS NULL` examinadas. */
  scanned: number;
  /** Rows efetivamente atualizadas (sempre 0 em dry-run). */
  updated: number;
  /** Rows que já tinham hash (puladas). */
  alreadyHashed: number;
}

export interface NullNameHashDuplicate {
  workflowId: string;
  hash: string;
  count: number;
  ids: string[];
}

/**
 * Detecta grupos `(workflow_id, definition_hash-recomputado)` com `name IS NULL`
 * que aparecem em mais de uma versão. Decide se um índice ÚNICO parcial sobre
 * `(workflow_id, definition_hash) WHERE name IS NULL` seria seguro (sem
 * duplicatas) ou rejeitaria dados legítimos (com duplicatas).
 *
 * O hash não dá pra recomputar puro em SQL — `stableStringify` ordena chaves
 * recursivamente antes do SHA-256 — então recomputamos em Bun via `hashDefinition`.
 */
export async function findNullNameHashDuplicates(): Promise<NullNameHashDuplicate[]> {
  const rows = await db
    .select({
      id: workflowVersions.id,
      workflowId: workflowVersions.workflowId,
      definition: workflowVersions.definition,
    })
    .from(workflowVersions)
    .where(isNull(workflowVersions.name));

  const groups = new Map<string, { workflowId: string; hash: string; ids: string[] }>();
  for (const row of rows) {
    const hash = hashDefinition(row.definition);
    const key = `${row.workflowId}:${hash}`;
    const group = groups.get(key) ?? { workflowId: row.workflowId, hash, ids: [] };
    group.ids.push(row.id);
    groups.set(key, group);
  }

  return [...groups.values()]
    .filter((g) => g.ids.length > 1)
    .map((g) => ({ workflowId: g.workflowId, hash: g.hash, count: g.ids.length, ids: g.ids }));
}

export async function backfillDefinitionHash(
  options: { dryRun?: boolean } = {},
): Promise<BackfillResult> {
  const dryRun = options.dryRun ?? false;

  const [alreadyHashedRow] = await db
    .select({ value: count() })
    .from(workflowVersions)
    .where(isNotNull(workflowVersions.definitionHash));
  const alreadyHashed = Number(alreadyHashedRow?.value ?? 0);

  const nullRows = await db
    .select({ id: workflowVersions.id, definition: workflowVersions.definition })
    .from(workflowVersions)
    .where(isNull(workflowVersions.definitionHash));

  let updated = 0;
  for (const row of nullRows) {
    const hash = hashDefinition(row.definition);
    if (dryRun) {
      log.info({ id: row.id, hash }, "would backfill definition_hash");
      continue;
    }
    await db
      .update(workflowVersions)
      .set({ definitionHash: hash })
      .where(eq(workflowVersions.id, row.id));
    updated++;
  }

  const result: BackfillResult = { scanned: nullRows.length, updated, alreadyHashed };
  log.info(result, dryRun ? "backfill dry-run (nada gravado)" : "backfill complete");
  return result;
}

// Só executa quando chamado direto pela CLI — imports (ex: nos testes) não disparam.
if (import.meta.main) {
  const dryRun = process.argv.includes("--dry-run");

  backfillDefinitionHash({ dryRun })
    .then(async () => {
      const duplicates = await findNullNameHashDuplicates();
      if (duplicates.length > 0) {
        log.warn(
          { groups: duplicates.length, sample: duplicates.slice(0, 5) },
          "duplicatas (workflow_id, hash) com name NULL — índice único parcial NÃO é seguro",
        );
      } else {
        log.info({ groups: 0 }, "sem duplicatas (workflow_id, hash) com name NULL");
      }
      process.exit(0);
    })
    .catch((err) => {
      log.error({ err }, "backfill failed");
      process.exit(1);
    });
}
