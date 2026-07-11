import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { workflowVersions } from "../src/db/schema";
import { workflowVersionsController } from "../src/features/workflow-versions/controller";
import { workflowVersionsRepository } from "../src/features/workflow-versions/repository";
import { workflowsController } from "../src/features/workflows/controller";
import { backfillDefinitionHash } from "../scripts/backfill-definition-hash";

let orgId: string;
let userId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Idempotency Tester",
    email: `idem-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Idempotency Org",
    slug: `idem-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
});

/** Conta quantas versões o workflow tem. */
async function countVersions(workflowId: string): Promise<number> {
  const versions = await workflowVersionsRepository.list(orgId, workflowId);
  return versions.length;
}

/** Zera o definition_hash de uma versão — simula row legada pré-migração 0013. */
async function nullifyHash(versionId: string): Promise<void> {
  await db
    .update(workflowVersions)
    .set({ definitionHash: null })
    .where(eq(workflowVersions.id, versionId));
}

describe("idempotência de publish e backfill de definition_hash", () => {
  test("hash NULL fura a idempotência e cria versão duplicada (o gap)", async () => {
    // Arrange: workflow publicado, depois com hash zerado (estado legado).
    const wf = await workflowsController.create(orgId, userId, {
      name: "gap",
      definition: { steps: ["a"] },
    });
    if ("error" in wf) throw new Error(wf.error);
    const v1 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    if ("error" in v1) throw new Error(v1.error);
    await nullifyHash(v1.version.id);

    // Act: republish sem nome, draft idêntico, mas hash da latest é NULL.
    const again = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    if ("error" in again) throw new Error(again.error);

    // Assert: `null === hash` é sempre falso → criou v2 em vez de reusar.
    expect(again.alreadyExisted).toBe(false);
    expect(again.version.version).toBe(2);
    expect(await countVersions(wf.workflow.id)).toBe(2);
  });

  test("após o backfill, republish idêntico reusa a versão em vez de criar v+1", async () => {
    // Arrange: workflow publicado com hash zerado (row legada).
    const wf = await workflowsController.create(orgId, userId, {
      name: "backfill-fix",
      definition: { steps: ["a"] },
    });
    if ("error" in wf) throw new Error(wf.error);
    const v1 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    if ("error" in v1) throw new Error(v1.error);
    await nullifyHash(v1.version.id);

    // Act: backfill recomputa e grava o hash; depois republish sem nome.
    const result = await backfillDefinitionHash();
    const republish = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    if ("error" in republish) throw new Error(republish.error);

    // Assert: reusou a v1 — nenhuma versão nova.
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(republish.alreadyExisted).toBe(true);
    expect(republish.version.id).toBe(v1.version.id);
    expect(await countVersions(wf.workflow.id)).toBe(1);
  });

  test("publish COM name sempre cria versão nova mesmo com definition idêntico", async () => {
    // Arrange: workflow com um definition estável.
    const wf = await workflowsController.create(orgId, userId, {
      name: "named",
      definition: { steps: ["a"] },
    });
    if ("error" in wf) throw new Error(wf.error);

    // Act: dois publishes nomeados sobre o MESMO draft.
    const v1 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, {
      name: "marco-1",
    });
    if ("error" in v1) throw new Error(v1.error);
    const v2 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, {
      name: "marco-2",
    });
    if ("error" in v2) throw new Error(v2.error);

    // Assert: nome explícito ignora a idempotência — cria versão a cada publish.
    expect(v1.alreadyExisted).toBe(false);
    expect(v2.alreadyExisted).toBe(false);
    expect(v2.version.version).toBe(2);
    expect(await countVersions(wf.workflow.id)).toBe(2);
  });

  test("restore de versão inexistente retorna version_not_found", async () => {
    // Arrange: workflow real, id de versão inexistente.
    const wf = await workflowsController.create(orgId, userId, {
      name: "restore-missing",
      definition: { steps: ["a"] },
    });
    if ("error" in wf) throw new Error(wf.error);

    // Act
    const result = await workflowVersionsController.restore(
      orgId,
      wf.workflow.id,
      crypto.randomUUID(),
    );

    // Assert
    expect(result).toEqual({ error: "version_not_found" });
  });

  test("restore traz o definition da versão pro draft e NÃO cria versão nova", async () => {
    // Arrange: publica v1 (D1), edita o draft pra D2, publica v2 (D2).
    const d1 = { steps: ["a"] };
    const d2 = { steps: ["a", "b"] };
    const wf = await workflowsController.create(orgId, userId, {
      name: "restore-draft",
      definition: d1,
    });
    if ("error" in wf) throw new Error(wf.error);
    const v1 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    if ("error" in v1) throw new Error(v1.error);
    await workflowsController.update(orgId, wf.workflow.id, { definition: d2 });
    await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    const before = await countVersions(wf.workflow.id);
    expect(before).toBe(2);

    // Act: restaura a v1 (D1) como draft corrente.
    const result = await workflowVersionsController.restore(orgId, wf.workflow.id, v1.version.id);
    if ("error" in result) throw new Error(result.error);

    // Assert: draft voltou pra D1 e a contagem de versões não mudou.
    expect(result.workflow.definition).toEqual(d1);
    const reread = await workflowsController.findById(orgId, wf.workflow.id);
    expect(reread?.definition).toEqual(d1);
    expect(await countVersions(wf.workflow.id)).toBe(before);
  });
});
