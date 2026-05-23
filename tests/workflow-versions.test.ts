import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { workflowVersionsController } from "../src/features/workflow-versions/controller";
import { workflowVersionsRepository } from "../src/features/workflow-versions/repository";
import { workflowsController } from "../src/features/workflows/controller";

let orgId: string;
let userId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Versions Tester",
    email: `versions-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Versions Org",
    slug: `versions-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
});

describe("workflow_versions", () => {
  test("publish incrementa monotonicamente e snapshot é imutável", async () => {
    const wf = await workflowsController.create(orgId, userId, {
      name: "vers",
      definition: { steps: ["a"] },
    });
    if ("error" in wf) throw new Error(wf.error);

    const v1 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, {
      name: "primeira",
    });
    if ("error" in v1) throw new Error(v1.error);
    expect(v1.version.version).toBe(1);
    expect(v1.version.definition).toEqual({ steps: ["a"] });

    // Muda o draft — snapshot anterior NÃO pode mudar.
    await workflowsController.update(orgId, wf.workflow.id, {
      definition: { steps: ["a", "b"] },
    });
    const v1Reread = await workflowVersionsController.findById(
      orgId,
      wf.workflow.id,
      v1.version.id,
    );
    expect(v1Reread?.definition).toEqual({ steps: ["a"] });

    // Próxima publish pega o draft atualizado.
    const v2 = await workflowVersionsController.publish(orgId, wf.workflow.id, userId, null);
    if ("error" in v2) throw new Error(v2.error);
    expect(v2.version.version).toBe(2);
    expect(v2.version.definition).toEqual({ steps: ["a", "b"] });
  });

  test("run sem versão prévia auto-publica v1 e linka no workflow_run", async () => {
    const wf = await workflowsController.create(orgId, userId, {
      name: "auto-pub",
      definition: { steps: ["x"] },
    });
    if ("error" in wf) throw new Error(wf.error);

    const result = await workflowsController.run(orgId, wf.workflow.id, userId);
    if ("error" in result) throw new Error(result.error);

    const latest = await workflowVersionsRepository.findLatest(wf.workflow.id);
    expect(latest).not.toBeNull();
    expect(latest?.version).toBe(1);
  });
});
