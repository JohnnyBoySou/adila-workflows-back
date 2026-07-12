/**
 * Testes da política de delete de versão (Opção A — bloquear se referenciada).
 *
 * Cobre:
 *  - delete de versão não referenciada → sucesso, some da listagem
 *  - delete de versão fixada por trigger → { error: "version_in_use", refs }
 *  - depois de despinar (promote null), o delete passa
 *  - delete de versão inexistente → { error: "version_not_found" }
 *  - delete de versão de outro workflow → { error: "version_not_found" }
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { triggersController } from "../src/features/triggers/controller";
import { workflowRunsRepository } from "../src/features/workflow-runs/repository";
import { workflowVersionsController } from "../src/features/workflow-versions/controller";
import { workflowsController } from "../src/features/workflows/controller";

let orgId: string;
let userId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Delete Tester",
    email: `delete-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Delete Org",
    slug: `delete-${orgId.slice(0, 8)}`,
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

describe("version-delete — política de delete (Opção A)", () => {
  test("remove versão não referenciada com sucesso e some da listagem", async () => {
    // Arrange: duas versões, nenhuma fixada por trigger.
    const wf = await createWorkflow("del-livre", { steps: ["a"] });
    const v1 = await publish(wf.id, "v1");
    await workflowsController.update(orgId, wf.id, { definition: { steps: ["a", "b"] } });
    const v2 = await publish(wf.id, "v2");

    // Act
    const res = await workflowVersionsController.remove(orgId, wf.id, v1.version.id);

    // Assert
    if ("error" in res) throw new Error(`esperava sucesso, veio ${res.error}`);
    expect(res.deleted.id).toBe(v1.version.id);
    expect(res.deleted.version).toBe(v1.version.version);

    const list = await workflowVersionsController.list(orgId, wf.id);
    if ("error" in list) throw new Error(list.error);
    const ids = list.versions.map((v) => v.id);
    expect(ids).not.toContain(v1.version.id);
    expect(ids).toContain(v2.version.id);
  });

  test("bloqueia delete de versão fixada por trigger com version_in_use + refs", async () => {
    // Arrange: versão fixada por um trigger.
    const wf = await createWorkflow("del-pinada", { steps: ["a"] });
    const v1 = await publish(wf.id, "v1");

    const tRes = await triggersController.create(orgId, wf.id, { type: "webhook", name: "wh" });
    if ("error" in tRes) throw new Error(tRes.error);

    const promoted = await workflowVersionsController.promoteBulk(
      orgId,
      wf.id,
      v1.version.id,
      undefined,
    );
    if ("error" in promoted) throw new Error(promoted.error);

    // Act
    const res = await workflowVersionsController.remove(orgId, wf.id, v1.version.id);

    // Assert
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toBe("version_in_use");
      expect(res.refs).toEqual({ triggers: 1, runs: 0 });
    }

    // Continua na listagem — nada foi removido.
    const list = await workflowVersionsController.list(orgId, wf.id);
    if ("error" in list) throw new Error(list.error);
    expect(list.versions.map((v) => v.id)).toContain(v1.version.id);
  });

  test("bloqueia delete de versão que já executou um run (FK RESTRICT) com version_in_use", async () => {
    // Arrange: versão sem trigger pinado, mas com histórico de run.
    const wf = await createWorkflow("del-com-run", { steps: ["a"] });
    const v1 = await publish(wf.id, "v1");

    await workflowRunsRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      workflowVersionId: v1.version.id,
      status: "success",
    });

    // Act
    const res = await workflowVersionsController.remove(orgId, wf.id, v1.version.id);

    // Assert: bloqueado por run, não por trigger — e não estoura 500 de FK.
    expect("error" in res).toBe(true);
    if ("error" in res) {
      expect(res.error).toBe("version_in_use");
      expect(res.refs).toEqual({ triggers: 0, runs: 1 });
    }

    // A versão continua na listagem.
    const list = await workflowVersionsController.list(orgId, wf.id);
    if ("error" in list) throw new Error(list.error);
    expect(list.versions.map((v) => v.id)).toContain(v1.version.id);
  });

  test("depois de despinar (promote null) o delete passa", async () => {
    // Arrange: versão fixada, depois despinada.
    const wf = await createWorkflow("del-despina", { steps: ["a"] });
    const v1 = await publish(wf.id, "v1");

    const tRes = await triggersController.create(orgId, wf.id, { type: "webhook", name: "wh2" });
    if ("error" in tRes) throw new Error(tRes.error);
    const triggerId = tRes.trigger.id;

    const pinned = await workflowVersionsController.promoteBulk(orgId, wf.id, v1.version.id, [
      triggerId,
    ]);
    if ("error" in pinned) throw new Error(pinned.error);

    // Bloqueado enquanto fixada.
    const blocked = await workflowVersionsController.remove(orgId, wf.id, v1.version.id);
    expect("error" in blocked).toBe(true);

    // Despina via promote null.
    const unpinned = await triggersController.promote(orgId, wf.id, triggerId, null);
    if ("error" in unpinned) throw new Error(unpinned.error);

    // Act: agora o delete passa.
    const res = await workflowVersionsController.remove(orgId, wf.id, v1.version.id);

    // Assert
    if ("error" in res) throw new Error(`esperava sucesso, veio ${res.error}`);
    expect(res.deleted.id).toBe(v1.version.id);
  });

  test("delete de versão inexistente retorna version_not_found", async () => {
    const wf = await createWorkflow("del-inexistente", { steps: ["a"] });
    await publish(wf.id);

    const res = await workflowVersionsController.remove(orgId, wf.id, crypto.randomUUID());

    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toBe("version_not_found");
  });

  test("delete de versão de outro workflow retorna version_not_found", async () => {
    // Versão vive em wfA; tentamos removê-la via wfB.
    const wfA = await createWorkflow("del-cross-a", { steps: ["a"] });
    const vA = await publish(wfA.id);
    const wfB = await createWorkflow("del-cross-b", { steps: ["b"] });

    const res = await workflowVersionsController.remove(orgId, wfB.id, vA.version.id);

    expect("error" in res).toBe(true);
    if ("error" in res) expect(res.error).toBe("version_not_found");

    // A versão continua intacta em wfA.
    const list = await workflowVersionsController.list(orgId, wfA.id);
    if ("error" in list) throw new Error(list.error);
    expect(list.versions.map((v) => v.id)).toContain(vA.version.id);
  });
});
