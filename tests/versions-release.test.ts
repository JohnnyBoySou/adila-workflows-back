/**
 * Testes de integração do pipeline de release focados em lacunas ainda NÃO
 * cobertas por `tests/promote-pipeline.test.ts`:
 *  - promoteBulk sem triggerIds num workflow SEM triggers → { promoted: [], version }
 *  - unpin/troca em massa rastreando previousWorkflowVersionId (from → to)
 *  - re-promote sequencial via bulk reporta a versão anterior correta
 *  - diff com versão inexistente → { error: "version_not_found" }
 *  - promoteBulk com versão de outro workflow → { error: "workflow_version_not_found" }
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { triggersController } from "../src/features/triggers/controller";
import { workflowVersionsController } from "../src/features/workflow-versions/controller";
import { workflowsController } from "../src/features/workflows/controller";

let orgId: string;
let userId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Release Tester",
    email: `release-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Release Org",
    slug: `release-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
});

async function createWorkflow(name: string, definition: Record<string, unknown>) {
  const res = await workflowsController.create(orgId, userId, { name, definition });
  if ("error" in res) throw new Error(res.error);
  return res.workflow;
}

async function publish(workflowId: string, name?: string) {
  const res = await workflowVersionsController.publish(
    orgId,
    workflowId,
    userId,
    name ? { name } : null,
  );
  if ("error" in res) throw new Error(res.error);
  return res;
}

describe("versions-release — promoteBulk e diff (casos não cobertos)", () => {
  test("promoteBulk sem triggerIds num workflow SEM triggers retorna promoted vazio, não erro", async () => {
    // Arrange
    const wf = await createWorkflow("bulk-sem-triggers", { steps: ["x"] });
    const v1 = await publish(wf.id);

    // Act
    const res = await workflowVersionsController.promoteBulk(orgId, wf.id, v1.version.id, undefined);

    // Assert
    if ("error" in res) throw new Error(`esperava sucesso, veio ${res.error}`);
    expect(res.promoted).toEqual([]);
    expect(res.version.id).toBe(v1.version.id);
  });

  test("unpin em massa troca o pino e rastreia previousWorkflowVersionId (from → to)", async () => {
    // Arrange: workflow com duas versões e um trigger.
    const wf = await createWorkflow("bulk-unpin", { steps: ["a"] });
    const v1 = await publish(wf.id, "v1");
    await workflowsController.update(orgId, wf.id, { definition: { steps: ["a", "b"] } });
    const v2 = await publish(wf.id, "v2");

    const tRes = await triggersController.create(orgId, wf.id, { type: "webhook", name: "wh" });
    if ("error" in tRes) throw new Error(tRes.error);
    const triggerId = tRes.trigger.id;

    // Act 1: promove pra v1 em massa (todos os triggers).
    const toV1 = await workflowVersionsController.promoteBulk(orgId, wf.id, v1.version.id, undefined);
    if ("error" in toV1) throw new Error(toV1.error);

    // Assert 1: pino anterior era null.
    expect(toV1.promoted).toHaveLength(1);
    expect(toV1.promoted[0].trigger.workflowVersionId).toBe(v1.version.id);
    expect(toV1.promoted[0].previousWorkflowVersionId).toBeNull();

    // Act 2: troca o pino pra v2 em massa.
    const toV2 = await workflowVersionsController.promoteBulk(orgId, wf.id, v2.version.id, [triggerId]);
    if ("error" in toV2) throw new Error(toV2.error);

    // Assert 2: novo pino é v2, anterior era v1 (rastreio from → to).
    expect(toV2.promoted).toHaveLength(1);
    expect(toV2.promoted[0].trigger.workflowVersionId).toBe(v2.version.id);
    expect(toV2.promoted[0].previousWorkflowVersionId).toBe(v1.version.id);
  });

  test("re-promote sequencial via bulk (v1 → v2) reporta previousWorkflowVersionId === v1", async () => {
    // Arrange
    const wf = await createWorkflow("bulk-repromote", { steps: ["a"] });
    const v1 = await publish(wf.id, "v1");
    await workflowsController.update(orgId, wf.id, { definition: { steps: ["a", "b"] } });
    const v2 = await publish(wf.id, "v2");

    const tRes = await triggersController.create(orgId, wf.id, { type: "webhook", name: "wh2" });
    if ("error" in tRes) throw new Error(tRes.error);
    const triggerId = tRes.trigger.id;

    // Act: primeiro promove v1, depois v2 — ambos via bulk com id explícito.
    const first = await workflowVersionsController.promoteBulk(orgId, wf.id, v1.version.id, [triggerId]);
    if ("error" in first) throw new Error(first.error);
    const second = await workflowVersionsController.promoteBulk(orgId, wf.id, v2.version.id, [triggerId]);
    if ("error" in second) throw new Error(second.error);

    // Assert
    expect(first.promoted[0].previousWorkflowVersionId).toBeNull();
    expect(second.promoted[0].trigger.workflowVersionId).toBe(v2.version.id);
    expect(second.promoted[0].previousWorkflowVersionId).toBe(v1.version.id);
  });

  test("diff com fromVersionId inexistente retorna version_not_found", async () => {
    // Arrange
    const wf = await createWorkflow("diff-from-inexistente", { steps: ["a"] });
    const v1 = await publish(wf.id);

    // Act
    const res = await workflowVersionsController.diff(
      orgId,
      wf.id,
      crypto.randomUUID(),
      v1.version.id,
    );

    // Assert
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toBe("version_not_found");
  });

  test("diff com toVersionId inexistente retorna version_not_found", async () => {
    // Arrange
    const wf = await createWorkflow("diff-to-inexistente", { steps: ["a"] });
    const v1 = await publish(wf.id);

    // Act
    const res = await workflowVersionsController.diff(
      orgId,
      wf.id,
      v1.version.id,
      crypto.randomUUID(),
    );

    // Assert
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toBe("version_not_found");
  });

  test("promoteBulk com versão que não pertence ao workflow retorna workflow_version_not_found", async () => {
    // Arrange: versão vive em wfA; tentamos promover triggers de wfB pra ela.
    const wfA = await createWorkflow("bulk-cross-a", { steps: ["a"] });
    const vA = await publish(wfA.id);
    const wfB = await createWorkflow("bulk-cross-b", { steps: ["b"] });

    const tRes = await triggersController.create(orgId, wfB.id, { type: "webhook", name: "wb" });
    if ("error" in tRes) throw new Error(tRes.error);

    // Act
    const res = await workflowVersionsController.promoteBulk(orgId, wfB.id, vA.version.id, [
      tRes.trigger.id,
    ]);

    // Assert
    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toBe("workflow_version_not_found");
  });
});
