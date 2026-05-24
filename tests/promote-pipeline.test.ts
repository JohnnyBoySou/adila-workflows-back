/**
 * E2E do pipeline de release — publicar → promover → rollback → diff.
 *
 * Cobre o contrato cross-feature que os unit tests não alcançam:
 *  - publish é append-only e idempotente por hash
 *  - promote pinia um trigger numa versão e o pino sobrevive a edits no draft
 *  - bulk promote rejeita lote inteiro se algum trigger não bate
 *  - rename muda só o nome (definition imutável)
 *  - restore traz versão antiga pro draft sem alterar triggers nem publicar
 *  - diff compara duas versões publicadas em qualquer ordem
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
    name: "Pipeline Tester",
    email: `pipeline-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Pipeline Org",
    slug: `pipeline-${orgId.slice(0, 8)}`,
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

describe("pipeline publicar → promover → rollback → diff", () => {
  test("ciclo completo preserva imutabilidade e pino do trigger", async () => {
    // 1) Workflow + v1
    const wf = await createWorkflow("release-pipeline", { steps: ["fetch"] });
    const v1Res = await publish(wf.id, "alpha");
    expect(v1Res.version.version).toBe(1);
    expect(v1Res.alreadyExisted).toBe(false);

    // 2) Idempotência: republicar sem nome reusa v1 (hash bate)
    const v1Again = await publish(wf.id);
    expect(v1Again.version.id).toBe(v1Res.version.id);
    expect(v1Again.alreadyExisted).toBe(true);

    // 3) Edita draft + publica v2
    await workflowsController.update(orgId, wf.id, {
      definition: { steps: ["fetch", "transform"] },
    });
    const v2Res = await publish(wf.id, "beta");
    expect(v2Res.version.version).toBe(2);
    expect(v2Res.alreadyExisted).toBe(false);

    // 4) Cria webhook trigger e promove pra v1 (rodando versão "antiga")
    const tRes = await triggersController.create(orgId, wf.id, {
      type: "webhook",
      name: "wh-prod",
    });
    if ("error" in tRes) throw new Error(tRes.error);
    const trigger = tRes.trigger;
    expect(trigger.workflowVersionId).toBeNull();

    const promoteRes = await triggersController.promote(orgId, wf.id, trigger.id, v1Res.version.id);
    if ("error" in promoteRes) throw new Error(promoteRes.error);
    expect(promoteRes.trigger.workflowVersionId).toBe(v1Res.version.id);
    expect(promoteRes.previousWorkflowVersionId).toBeNull();

    // 5) Edição no draft NÃO muda o pino do trigger nem o snapshot de v1
    await workflowsController.update(orgId, wf.id, {
      definition: { steps: ["fetch", "transform", "notify"] },
    });
    const triggerAfterEdit = await triggersController.findById(orgId, wf.id, trigger.id);
    expect(triggerAfterEdit?.workflowVersionId).toBe(v1Res.version.id);
    const v1Reread = await workflowVersionsController.findById(orgId, wf.id, v1Res.version.id);
    expect(v1Reread?.definition).toEqual({ steps: ["fetch"] });

    // 6) Rollback: restaura v1 como draft (sem despinpinar trigger nem publicar)
    const restoreRes = await workflowVersionsController.restore(orgId, wf.id, v1Res.version.id);
    if ("error" in restoreRes) throw new Error(restoreRes.error);
    expect(restoreRes.workflow.definition).toEqual({ steps: ["fetch"] });

    const triggerAfterRestore = await triggersController.findById(orgId, wf.id, trigger.id);
    expect(triggerAfterRestore?.workflowVersionId).toBe(v1Res.version.id);

    // 7) Publish após restore cria v3 com o MESMO definition de v1.
    // A idempotência compara só contra a LATEST (que é v2 aqui, diferente),
    // então não reusa — mas o snapshot resultante bate byte-a-byte com v1.
    const v3 = await publish(wf.id);
    expect(v3.version.version).toBe(3);
    expect(v3.alreadyExisted).toBe(false);
    expect(v3.version.definition).toEqual(v1Res.version.definition);

    // 8) Diff entre v1 e v2 — em qualquer ordem
    const diff = await workflowVersionsController.diff(
      orgId,
      wf.id,
      v1Res.version.id,
      v2Res.version.id,
    );
    if ("error" in diff) throw new Error(diff.error);
    expect(diff.from.version).toBe(1);
    expect(diff.to.version).toBe(2);
    expect(diff.diff).toBeDefined();

    const diffReverse = await workflowVersionsController.diff(
      orgId,
      wf.id,
      v2Res.version.id,
      v1Res.version.id,
    );
    if ("error" in diffReverse) throw new Error(diffReverse.error);
    expect(diffReverse.from.version).toBe(2);
    expect(diffReverse.to.version).toBe(1);

    // 9) Despinpinar trigger (workflowVersionId=null) volta ao modo latest
    const unpin = await triggersController.promote(orgId, wf.id, trigger.id, null);
    if ("error" in unpin) throw new Error(unpin.error);
    expect(unpin.trigger.workflowVersionId).toBeNull();
    expect(unpin.previousWorkflowVersionId).toBe(v1Res.version.id);
  });

  test("rename só muda o nome, snapshot fica imutável", async () => {
    const wf = await createWorkflow("rename-test", { steps: ["s1"] });
    const v1 = await publish(wf.id, "old-name");
    const originalDef = v1.version.definition;

    const renamed = await workflowVersionsController.rename(
      orgId,
      wf.id,
      v1.version.id,
      "new-name",
    );
    if ("error" in renamed) throw new Error(renamed.error);
    expect(renamed.version.name).toBe("new-name");
    expect(renamed.previousName).toBe("old-name");
    expect(renamed.version.definition).toEqual(originalDef);
  });

  test("bulk promote rejeita lote inteiro se algum trigger não pertence ao workflow", async () => {
    const wf = await createWorkflow("bulk-promote", { steps: ["a"] });
    const v1 = await publish(wf.id);

    const t1 = await triggersController.create(orgId, wf.id, { type: "webhook", name: "t1" });
    const t2 = await triggersController.create(orgId, wf.id, { type: "webhook", name: "t2" });
    if ("error" in t1 || "error" in t2) throw new Error("trigger create falhou");

    // Inclui um id forasteiro — o lote inteiro deve ser rejeitado.
    const stranger = crypto.randomUUID();
    const bulk = await workflowVersionsController.promoteBulk(orgId, wf.id, v1.version.id, [
      t1.trigger.id,
      stranger,
      t2.trigger.id,
    ]);
    expect("error" in bulk).toBe(true);
    if ("error" in bulk) expect(bulk.error).toBe("trigger_not_found");

    // Nenhum dos triggers válidos deve ter sido alterado.
    const t1After = await triggersController.findById(orgId, wf.id, t1.trigger.id);
    const t2After = await triggersController.findById(orgId, wf.id, t2.trigger.id);
    expect(t1After?.workflowVersionId).toBeNull();
    expect(t2After?.workflowVersionId).toBeNull();

    // Lote válido (sem triggerIds = todos) promove ambos.
    const bulkOk = await workflowVersionsController.promoteBulk(orgId, wf.id, v1.version.id, undefined);
    if ("error" in bulkOk) throw new Error(bulkOk.error);
    expect(bulkOk.promoted).toHaveLength(2);
    for (const p of bulkOk.promoted) {
      expect(p.trigger.workflowVersionId).toBe(v1.version.id);
      expect(p.previousWorkflowVersionId).toBeNull();
    }
  });

  test("promote rejeita versão de outro workflow (cross-tenant invariant)", async () => {
    const wfA = await createWorkflow("wf-a", { steps: ["a"] });
    const wfB = await createWorkflow("wf-b", { steps: ["b"] });
    const vA = await publish(wfA.id);

    const tB = await triggersController.create(orgId, wfB.id, { type: "webhook", name: "wb" });
    if ("error" in tB) throw new Error(tB.error);

    const cross = await triggersController.promote(orgId, wfB.id, tB.trigger.id, vA.version.id);
    if (!("error" in cross)) throw new Error("expected cross-workflow promote to fail");
    expect(cross.error).toBe("workflow_version_not_found");
  });
});
