/**
 * Resolução em camadas de variáveis de ambiente (org + workflow).
 *
 * Contrato da Phase 1:
 *  - var da org (workflowId NULL) é a base de qualquer run
 *  - var do workflow sobrepõe a da org quando a key colide
 *  - a MESMA key pode existir nos dois escopos ao mesmo tempo (índices parciais)
 *  - resolveForRun sem workflowId enxerga só as da org
 *  - escopo de workflow é isolado: workflow B não vê vars do workflow A
 *  - secrets continuam cifrados em repouso mas resolvem em texto puro
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { environmentVariables } from "../src/db/schema";
import { environmentsRepository } from "../src/features/environments/repository";
import { environmentVariablesController } from "../src/features/environment-variables/controller";
import { workflowsController } from "../src/features/workflows/controller";

let orgId: string;
let userId: string;
let envId: string;
let wfA: string;
let wfB: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Env Tester",
    email: `env-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Env Org",
    slug: `env-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });

  const env = await environmentsRepository.create({
    organizationId: orgId,
    slug: "production",
    name: "Production",
    kind: "production",
  });
  envId = env.id;

  const a = await workflowsController.create(orgId, userId, { name: "wf-a", definition: {} });
  const b = await workflowsController.create(orgId, userId, { name: "wf-b", definition: {} });
  if ("error" in a || "error" in b) throw new Error("workflow create falhou");
  wfA = a.workflow.id;
  wfB = b.workflow.id;
});

describe("env vars em camadas (org + workflow)", () => {
  test("var da org aparece na resolução de run", async () => {
    await environmentVariablesController.create(orgId, envId, null, {
      key: "SHARED_URL",
      value: "https://org.example.com",
    });

    const resolved = await environmentVariablesController.resolveForRun(orgId, envId, wfA);
    expect(resolved.SHARED_URL).toBe("https://org.example.com");
  });

  test("var do workflow sobrepõe a da org para a mesma key", async () => {
    // Mesma key SHARED_URL — agora no escopo do workflow A.
    const created = await environmentVariablesController.create(orgId, envId, wfA, {
      key: "SHARED_URL",
      value: "https://wf-a.example.com",
    });
    expect("error" in created).toBe(false);

    const resolvedA = await environmentVariablesController.resolveForRun(orgId, envId, wfA);
    expect(resolvedA.SHARED_URL).toBe("https://wf-a.example.com");

    // Workflow B não tem override → continua vendo a da org.
    const resolvedB = await environmentVariablesController.resolveForRun(orgId, envId, wfB);
    expect(resolvedB.SHARED_URL).toBe("https://org.example.com");
  });

  test("key exclusiva do workflow não vaza para outro workflow", async () => {
    await environmentVariablesController.create(orgId, envId, wfA, {
      key: "WF_A_ONLY",
      value: "secret-of-a",
    });

    const resolvedA = await environmentVariablesController.resolveForRun(orgId, envId, wfA);
    const resolvedB = await environmentVariablesController.resolveForRun(orgId, envId, wfB);
    expect(resolvedA.WF_A_ONLY).toBe("secret-of-a");
    expect(resolvedB.WF_A_ONLY).toBeUndefined();
  });

  test("resolveForRun sem workflowId enxerga só as da org", async () => {
    const resolved = await environmentVariablesController.resolveForRun(orgId, envId);
    expect(resolved.SHARED_URL).toBe("https://org.example.com");
    expect(resolved.WF_A_ONLY).toBeUndefined();
  });

  test("a mesma key coexiste nos dois escopos sem violar unicidade", async () => {
    // SHARED_URL existe na org (1 row workflow_id NULL) e no wf-a (1 row).
    const rows = await db
      .select()
      .from(environmentVariables)
      .where(eq(environmentVariables.environmentId, envId));
    const shared = rows.filter((r) => r.key === "SHARED_URL");
    expect(shared).toHaveLength(2);
    const scopes = shared.map((r) => r.workflowId).sort();
    expect(scopes).toEqual([null, wfA].sort());
  });

  test("key duplicada no MESMO escopo é rejeitada", async () => {
    const dup = await environmentVariablesController.create(orgId, envId, wfA, {
      key: "SHARED_URL",
      value: "outra",
    });
    expect("error" in dup && dup.error).toBe("key_taken");
  });

  test("secret resolve em texto puro mas fica cifrado em repouso", async () => {
    await environmentVariablesController.create(orgId, envId, wfA, {
      key: "API_TOKEN",
      value: "sk-live-123",
      isSecret: true,
    });

    const resolved = await environmentVariablesController.resolveForRun(orgId, envId, wfA);
    expect(resolved.API_TOKEN).toBe("sk-live-123");

    const [stored] = await db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.workflowId, wfA),
          eq(environmentVariables.key, "API_TOKEN"),
        ),
      )
      .limit(1);
    expect(stored?.value.startsWith("enc:v1:")).toBe(true);
  });
});
