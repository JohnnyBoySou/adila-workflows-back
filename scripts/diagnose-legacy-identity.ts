/**
 * Diagnóstico READ-ONLY do legado pré-federação (Identity).
 *
 * A federação trocou os ids de `user`/`organization` (antes: UUID do Better
 * Auth local; agora: id do Identity). Este script mostra o que ficou órfão
 * sob os ids antigos, SEM alterar nada.
 *
 * Rode com: `railway run --service Postgres bun run scripts/diagnose-legacy-identity.ts`
 * (usa DATABASE_PUBLIC_URL — a URL interna só resolve dentro do Railway).
 */
import postgres from "postgres";

const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_PUBLIC_URL/DATABASE_URL ausente no ambiente");

const sql = postgres(url, { max: 1, onnotice: () => {} });

// ids do Identity não são UUID (ex.: "Cmw8LwTiXSLZ2yMbJHNmg4ZklMTQEW9X").
const UUID_RE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

async function main() {
  console.log("\n═══ USERS (looks_legacy = id em formato UUID = pré-federação) ═══");
  console.table(
    await sql`
      SELECT id, email, created_at, (id ~* ${UUID_RE}) AS looks_legacy
      FROM "user" ORDER BY created_at
    `,
  );

  console.log("\n═══ EMAILS DUPLICADOS (legado + Identity = mesma pessoa) ═══");
  console.table(
    await sql`
      SELECT email, COUNT(*)::int AS n, array_agg(id) AS ids
      FROM "user" GROUP BY email HAVING COUNT(*) > 1
    `,
  );

  console.log("\n═══ ORGS — o que CAIRIA EM CASCATA se a org fosse deletada ═══");
  console.table(
    await sql`
      SELECT o.id, o.name, (o.id ~* ${UUID_RE}) AS looks_legacy,
        (SELECT COUNT(*)::int FROM workflows w      WHERE w.organization_id = o.id) AS workflows,
        (SELECT COUNT(*)::int FROM folders f        WHERE f.organization_id = o.id) AS folders,
        (SELECT COUNT(*)::int FROM workflow_runs r  WHERE r.organization_id = o.id) AS runs,
        (SELECT COUNT(*)::int FROM triggers t       WHERE t.organization_id = o.id) AS triggers,
        (SELECT COUNT(*)::int FROM environments e   WHERE e.organization_id = o.id) AS envs,
        (SELECT COUNT(*)::int FROM member m         WHERE m.organization_id = o.id) AS members
      FROM organization o ORDER BY o.created_at
    `,
  );

  console.log("\n═══ MEMBERSHIPS ═══");
  console.table(await sql`SELECT id, user_id, organization_id, role FROM member`);

  console.log("\n═══ WORKFLOWS (quem criou / qual org) ═══");
  console.table(
    await sql`SELECT id, name, organization_id, created_by FROM workflows ORDER BY created_at LIMIT 30`,
  );

  console.log("\n(nenhuma alteração feita — read-only)\n");
}

main()
  .then(() => sql.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("diagnóstico falhou:", err?.message ?? err);
    await sql.end().catch(() => {});
    process.exit(1);
  });
