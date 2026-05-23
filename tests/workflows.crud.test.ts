import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { workflowsController } from "../src/features/workflows/controller";

let orgId: string;
let userId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Smoke Tester",
    email: `smoke-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Smoke Org",
    slug: `smoke-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });
});

describe("workflows CRUD", () => {
  test("create → list → update → remove", async () => {
    const created = await workflowsController.create(orgId, userId, {
      name: "smoke",
      definition: { foo: "bar" },
    });
    if ("error" in created) throw new Error(`create falhou: ${created.error}`);
    const id = created.workflow.id;

    const list = await workflowsController.list(orgId, { limit: 20, offset: 0 });
    expect(list.items.some((w) => w.id === id)).toBe(true);
    expect(list.total).toBeGreaterThan(0);

    const updated = await workflowsController.update(orgId, id, {
      name: "smoke-renamed",
    });
    if ("error" in updated) throw new Error(`update falhou: ${updated.error}`);
    expect(updated.workflow.name).toBe("smoke-renamed");

    const removed = await workflowsController.remove(orgId, id);
    expect(removed).not.toBeNull();

    const after = await workflowsController.findById(orgId, id);
    expect(after).toBeNull();
  });

  test("isolamento por organizationId", async () => {
    const created = await workflowsController.create(orgId, userId, {
      name: "isolation",
    });
    if ("error" in created) throw new Error(`create falhou: ${created.error}`);

    const otherOrg = crypto.randomUUID();
    const found = await workflowsController.findById(otherOrg, created.workflow.id);
    expect(found).toBeNull();

    await workflowsController.remove(orgId, created.workflow.id);
  });
});
