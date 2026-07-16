/**
 * Limpa o espelho local de identidade (users + organizations) — AMBIENTE DE STAGE.
 *
 * Contexto: o Identity recriou os usuários com ids novos. Os registros antigos
 * no espelho local colidem em `user_email_unique`, quebrando o provisioning JIT
 * (`lib/identity-auth.ts`). Zerar o espelho resolve: no próximo login, o
 * provisioning recria user/organization/member a partir do token do Identity.
 *
 * DESTRUTIVO: deletar `organization` cascateia para workflows, folders, runs,
 * triggers, environments, versions, connections, etc. Só rode em stage.
 *
 *   Dry-run:  railway run --service Postgres bun run scripts/purge-identity-mirror.ts
 *   Executar: railway run --service Postgres bun run scripts/purge-identity-mirror.ts --yes
 */
import postgres from "postgres";

const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_PUBLIC_URL/DATABASE_URL ausente no ambiente");

const APPLY = process.argv.includes("--yes");
const sql = postgres(url, { max: 1, onnotice: () => {} });

async function counts() {
  const [row] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM "user")        AS users,
      (SELECT COUNT(*)::int FROM organization)  AS orgs,
      (SELECT COUNT(*)::int FROM member)        AS members,
      (SELECT COUNT(*)::int FROM workflows)     AS workflows,
      (SELECT COUNT(*)::int FROM folders)       AS folders,
      (SELECT COUNT(*)::int FROM workflow_runs) AS runs,
      (SELECT COUNT(*)::int FROM triggers)      AS triggers,
      (SELECT COUNT(*)::int FROM environments)  AS environments
  `;
  return row;
}

async function main() {
  console.log(`\n${APPLY ? "🔥 EXECUTANDO" : "🔍 DRY-RUN (nada será alterado)"}\n`);

  const before = await counts();
  console.log("Antes:");
  console.table([before]);

  if (!APPLY) {
    console.log(
      "\nSeria deletado: TODAS as organizations (cascata: workflows, folders, runs,\n" +
        "triggers, environments, versions, connections…) e TODOS os users.\n" +
        "Rode de novo com --yes para aplicar.\n",
    );
    return;
  }

  // Orgs primeiro: o CASCADE limpa o domínio e libera os FKs RESTRICT que
  // apontam para `user` (workflows.created_by, folders.created_by, etc.).
  await sql.begin(async (tx) => {
    await tx`DELETE FROM organization`;
    await tx`DELETE FROM "user"`;
  });

  const after = await counts();
  console.log("\nDepois:");
  console.table([after]);
  console.log(
    "\n✅ Espelho zerado. No próximo login, o provisioning JIT recria\n" +
      "   user/organization/member a partir do token do Identity.\n",
  );
}

main()
  .then(() => sql.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("purge falhou:", err?.message ?? err);
    await sql.end().catch(() => {});
    process.exit(1);
  });
