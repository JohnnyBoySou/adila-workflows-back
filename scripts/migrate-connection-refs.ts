/**
 * Migra `connectionId` (UUID) → `connectionRef` (nome lógico) em nodes de
 * workflows e workflow_versions já gravados antes da introdução do resolver
 * por nome com fallback de ambiente.
 *
 * O engine é retrocompatível (aceita ambos), mas a UI nova em modo `name`
 * mostra vazio quando lê só UUID. Este script normaliza o legado.
 *
 * Uso:
 *   bun run scripts/migrate-connection-refs.ts --dry-run   # só loga
 *   bun run scripts/migrate-connection-refs.ts             # grava
 *
 * Idempotente: nodes que já têm `connectionRef` são pulados.
 *
 * Workflow versions são imutáveis por design — esta é uma exceção
 * justificada (schema-level rewrite, não mudança de comportamento).
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { databaseConnections, workflows, workflowVersions } from "../src/db/schema";
import { logger } from "../src/lib/logger";

const log = logger.child({ component: "migrate-connection-refs" });

const DRY_RUN = process.argv.includes("--dry-run");

type RewriteCounts = {
  refsConverted: number;
  refsAlreadyMigrated: number;
  refsUnresolved: number;
};

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/**
 * Reescreve in-place os nodes do definition: substitui `connectionId` UUID
 * por `connectionRef` nome quando o UUID é resolúvel via mapa. Retorna
 * `true` se ALGO mudou, junto com os contadores.
 */
function rewriteDefinition(
  definition: unknown,
  uuidToName: Map<string, string>,
  counts: RewriteCounts,
  ctx: string,
): { changed: boolean; definition: unknown } {
  if (!definition || typeof definition !== "object") {
    return { changed: false, definition };
  }
  const def = definition as Record<string, unknown>;
  if (!Array.isArray(def.nodes)) return { changed: false, definition };

  let changed = false;
  const nextNodes = def.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const n = node as Record<string, unknown>;
    const config =
      n.config && typeof n.config === "object" ? (n.config as Record<string, unknown>) : null;
    if (!config) return node;

    // Já migrado — pula.
    if (typeof config.connectionRef === "string" && config.connectionRef.length > 0) {
      if (isUuid(config.connectionId)) {
        // Tem ambos — limpa o UUID antigo pra evitar ambiguidade.
        const { connectionId: _, ...rest } = config;
        counts.refsAlreadyMigrated++;
        changed = true;
        return { ...n, config: rest };
      }
      counts.refsAlreadyMigrated++;
      return node;
    }

    if (!isUuid(config.connectionId)) return node;

    const name = uuidToName.get(config.connectionId);
    if (!name) {
      counts.refsUnresolved++;
      log.warn(
        { ctx, nodeId: n.id, connectionId: config.connectionId },
        "connectionId not resolvable — leaving intact (engine still errors at runtime)",
      );
      return node;
    }

    counts.refsConverted++;
    changed = true;
    const { connectionId: _, ...rest } = config;
    return { ...n, config: { ...rest, connectionRef: name } };
  });

  if (!changed) return { changed: false, definition };
  return { changed: true, definition: { ...def, nodes: nextNodes } };
}

async function main() {
  log.info({ dryRun: DRY_RUN }, "starting migration");

  const allWorkflows = await db.select().from(workflows);
  log.info({ count: allWorkflows.length }, "scanning workflows");

  let workflowsUpdated = 0;
  let versionsUpdated = 0;
  const counts: RewriteCounts = {
    refsConverted: 0,
    refsAlreadyMigrated: 0,
    refsUnresolved: 0,
  };

  for (const wf of allWorkflows) {
    const conns = await db
      .select({ id: databaseConnections.id, name: databaseConnections.name })
      .from(databaseConnections)
      .where(eq(databaseConnections.workflowId, wf.id));
    const uuidToName = new Map(conns.map((c) => [c.id, c.name]));

    if (uuidToName.size === 0) continue;

    const wfResult = rewriteDefinition(wf.definition, uuidToName, counts, `workflow:${wf.id}`);
    if (wfResult.changed) {
      workflowsUpdated++;
      if (!DRY_RUN) {
        await db
          .update(workflows)
          .set({
            definition: wfResult.definition as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(workflows.id, wf.id));
      }
    }

    const versions = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id));

    for (const v of versions) {
      const vResult = rewriteDefinition(
        v.definition,
        uuidToName,
        counts,
        `version:${wf.id}:v${v.version}`,
      );
      if (vResult.changed) {
        versionsUpdated++;
        if (!DRY_RUN) {
          await db
            .update(workflowVersions)
            .set({ definition: vResult.definition as Record<string, unknown> })
            .where(eq(workflowVersions.id, v.id));
        }
      }
    }
  }

  log.info(
    {
      dryRun: DRY_RUN,
      workflowsScanned: allWorkflows.length,
      workflowsUpdated,
      versionsUpdated,
      refsConverted: counts.refsConverted,
      refsAlreadyMigrated: counts.refsAlreadyMigrated,
      refsUnresolved: counts.refsUnresolved,
    },
    DRY_RUN ? "dry-run complete — no rows changed" : "migration complete",
  );
  process.exit(0);
}

main().catch((err) => {
  log.error({ err }, "migration failed");
  process.exit(1);
});
