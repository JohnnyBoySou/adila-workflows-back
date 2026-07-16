/**
 * Cobertura do `triggersRepository` — os lookups globais (webhook token/path,
 * raw por id, listagens de habilitados) e o escopo por org/workflow das
 * mutações. O bulkUpdateVersion tem lógica própria (snapshot do "antes" pro
 * audit log) e ganha casos dedicados.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { triggersRepository } from "../src/features/triggers/repository";
import { workflowVersionsController } from "../src/features/workflow-versions/controller";
import { workflowsController } from "../src/features/workflows/controller";
import type { NewTrigger } from "../src/db/schema";

let orgId: string;
let userId: string;
let workflowId: string;
let otherWorkflowId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Triggers Repo Tester",
    email: `trg-repo-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Triggers Repo Org",
    slug: `trg-repo-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });

  workflowId = (await createWorkflow("repo-wf")).id;
  otherWorkflowId = (await createWorkflow("repo-wf-outro")).id;
});

async function createWorkflow(name: string) {
  const res = await workflowsController.create(orgId, userId, { name, definition: { nodes: [] } });
  if ("error" in res) throw new Error(res.error);
  return res.workflow;
}

/** Nomear a versão fura a idempotência por hash — garante linhas distintas. */
async function publishVersion(wfId: string, name = `v-${crypto.randomUUID().slice(0, 8)}`) {
  const res = await workflowVersionsController.publish(orgId, wfId, userId, { name });
  if ("error" in res) throw new Error(res.error);
  return res.version;
}

function newTrigger(patch: Partial<NewTrigger> & { name: string }) {
  return triggersRepository.create({
    organizationId: orgId,
    workflowId,
    type: "webhook",
    ...patch,
  });
}

describe("triggersRepository.list", () => {
  test("filtra por workflow e ordena por nome", async () => {
    const wf = await createWorkflow("list-wf");
    await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "zeta",
      type: "webhook",
    });
    await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "alpha",
      type: "webhook",
    });
    await newTrigger({ name: "de-outro-workflow" });

    const rows = await triggersRepository.list({ organizationId: orgId, workflowId: wf.id });

    expect(rows.map((r) => r.name)).toEqual(["alpha", "zeta"]);
  });

  test("filtra por type quando informado", async () => {
    const wf = await createWorkflow("list-type-wf");
    await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "hook",
      type: "webhook",
    });
    await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "agendado",
      type: "cron",
      cronExpression: "* * * * *",
    });

    const crons = await triggersRepository.list({
      organizationId: orgId,
      workflowId: wf.id,
      type: "cron",
    });

    expect(crons.map((r) => r.name)).toEqual(["agendado"]);
  });

  test("não vaza triggers de outra organização", async () => {
    const rows = await triggersRepository.list({
      organizationId: crypto.randomUUID(),
      workflowId,
    });

    expect(rows).toEqual([]);
  });
});

describe("triggersRepository.findById", () => {
  test("encontra dentro do escopo org + workflow", async () => {
    const created = await newTrigger({ name: "achavel" });

    const found = await triggersRepository.findById(orgId, workflowId, created.id);

    expect(found?.id).toBe(created.id);
  });

  test("devolve null quando o workflowId não bate", async () => {
    const created = await newTrigger({ name: "escopo-wf" });

    expect(await triggersRepository.findById(orgId, otherWorkflowId, created.id)).toBeNull();
  });

  test("devolve null quando a organização não bate", async () => {
    const created = await newTrigger({ name: "escopo-org" });

    expect(await triggersRepository.findById(crypto.randomUUID(), workflowId, created.id)).toBeNull();
  });
});

describe("lookups globais", () => {
  test("findByWebhookToken acha o trigger sem precisar de org", async () => {
    const token = crypto.randomUUID().replace(/-/g, "");
    const created = await newTrigger({ name: "por-token", webhookToken: token });

    const found = await triggersRepository.findByWebhookToken(token);

    expect(found?.id).toBe(created.id);
  });

  test("findByWebhookToken devolve null para token desconhecido", async () => {
    expect(await triggersRepository.findByWebhookToken("nao-existe")).toBeNull();
  });

  test("findByWebhookPath acha pelo alias amigável", async () => {
    const path = `alias-${crypto.randomUUID().slice(0, 8)}`;
    const created = await newTrigger({ name: "por-path", webhookPath: path });

    expect((await triggersRepository.findByWebhookPath(path))?.id).toBe(created.id);
  });

  test("findByWebhookPath devolve null para path desconhecido", async () => {
    expect(await triggersRepository.findByWebhookPath("path-fantasma")).toBeNull();
  });

  test("findByIdRaw ignora escopo de org — é o lookup do worker", async () => {
    const created = await newTrigger({ name: "raw" });

    expect((await triggersRepository.findByIdRaw(created.id))?.id).toBe(created.id);
    expect(await triggersRepository.findByIdRaw(crypto.randomUUID())).toBeNull();
  });
});

describe("listagens de habilitados", () => {
  test("listEnabledCronRaw traz só cron habilitado", async () => {
    const habilitado = await newTrigger({
      name: "cron-on",
      type: "cron",
      cronExpression: "0 * * * *",
      enabled: true,
    });
    const desabilitado = await newTrigger({
      name: "cron-off",
      type: "cron",
      cronExpression: "0 * * * *",
      enabled: false,
    });
    const webhook = await newTrigger({ name: "hook-on", enabled: true });

    const ids = (await triggersRepository.listEnabledCronRaw()).map((r) => r.id);

    expect(ids).toContain(habilitado.id);
    expect(ids).not.toContain(desabilitado.id);
    expect(ids).not.toContain(webhook.id);
  });

  test("listEnabledByType filtra pelo tipo pedido", async () => {
    const intervalo = await newTrigger({
      name: "interval-on",
      type: "interval_trigger",
      config: { every: 5, unit: "minutes" },
    });
    const cron = await newTrigger({ name: "cron-outro", type: "cron", cronExpression: "* * * * *" });

    const ids = (await triggersRepository.listEnabledByType("interval_trigger")).map((r) => r.id);

    expect(ids).toContain(intervalo.id);
    expect(ids).not.toContain(cron.id);
  });
});

describe("triggersRepository.update", () => {
  test("aplica o patch dentro do escopo e atualiza updatedAt", async () => {
    const created = await newTrigger({ name: "antes" });

    const updated = await triggersRepository.update(orgId, workflowId, created.id, {
      name: "depois",
      enabled: false,
    });

    expect(updated?.name).toBe("depois");
    expect(updated?.enabled).toBe(false);
    expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  test("devolve null quando o escopo não bate", async () => {
    const created = await newTrigger({ name: "fora-de-escopo" });

    const updated = await triggersRepository.update(orgId, otherWorkflowId, created.id, {
      name: "invadido",
    });

    expect(updated).toBeNull();
    expect((await triggersRepository.findByIdRaw(created.id))?.name).toBe("fora-de-escopo");
  });

  test("updateRaw atualiza sem escopo de org — caminho do worker", async () => {
    const created = await newTrigger({ name: "raw-update" });
    const at = new Date();

    const updated = await triggersRepository.updateRaw(created.id, { lastTriggeredAt: at });

    expect(updated?.lastTriggeredAt?.getTime()).toBe(at.getTime());
    expect(await triggersRepository.updateRaw(crypto.randomUUID(), { name: "x" })).toBeNull();
  });
});

describe("triggersRepository.bulkUpdateVersion", () => {
  test("lista vazia é no-op e não vai ao banco", async () => {
    expect(await triggersRepository.bulkUpdateVersion(orgId, workflowId, [], null)).toEqual([]);
  });

  test("pina N triggers e devolve a versão anterior de cada um", async () => {
    const wf = await createWorkflow("bulk-wf");
    const v1 = await publishVersion(wf.id);
    const v2 = await publishVersion(wf.id);

    const semPino = await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "sem-pino",
      type: "webhook",
    });
    const comPino = await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "com-pino",
      type: "webhook",
      workflowVersionId: v1.id,
    });

    const result = await triggersRepository.bulkUpdateVersion(
      orgId,
      wf.id,
      [semPino.id, comPino.id],
      v2.id,
    );

    const byId = new Map(result.map((r) => [r.trigger.id, r]));
    expect(v2.id).not.toBe(v1.id);
    expect(result).toHaveLength(2);
    expect(byId.get(semPino.id)?.previousWorkflowVersionId).toBeNull();
    expect(byId.get(comPino.id)?.previousWorkflowVersionId).toBe(v1.id);
    expect(byId.get(semPino.id)?.trigger.workflowVersionId).toBe(v2.id);
    expect(byId.get(comPino.id)?.trigger.workflowVersionId).toBe(v2.id);
  });

  test("workflowVersionId null despina", async () => {
    const wf = await createWorkflow("bulk-unpin-wf");
    const v1 = await publishVersion(wf.id);
    const trigger = await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "despinar",
      type: "webhook",
      workflowVersionId: v1.id,
    });

    const [result] = await triggersRepository.bulkUpdateVersion(orgId, wf.id, [trigger.id], null);

    expect(result?.trigger.workflowVersionId).toBeNull();
    expect(result?.previousWorkflowVersionId).toBe(v1.id);
  });

  test("ignora ids fora do escopo do workflow", async () => {
    const wf = await createWorkflow("bulk-escopo-wf");
    const v1 = await publishVersion(wf.id);
    const deOutroWorkflow = await newTrigger({ name: "intruso" });

    const result = await triggersRepository.bulkUpdateVersion(
      orgId,
      wf.id,
      [deOutroWorkflow.id],
      v1.id,
    );

    expect(result).toEqual([]);
    expect((await triggersRepository.findByIdRaw(deOutroWorkflow.id))?.workflowVersionId).toBeNull();
  });
});

describe("triggersRepository.remove", () => {
  test("apaga e devolve id + type (o type guia a limpeza do scheduler)", async () => {
    const created = await newTrigger({ name: "removivel", type: "cron", cronExpression: "* * * * *" });

    const removed = await triggersRepository.remove(orgId, workflowId, created.id);

    expect(removed).toEqual({ id: created.id, type: "cron" });
    expect(await triggersRepository.findByIdRaw(created.id)).toBeNull();
  });

  test("devolve null quando o escopo não bate e mantém a linha", async () => {
    const created = await newTrigger({ name: "protegido" });

    expect(await triggersRepository.remove(orgId, otherWorkflowId, created.id)).toBeNull();
    expect(await triggersRepository.findByIdRaw(created.id)).not.toBeNull();
  });
});

describe("triggersRepository.countByVersion", () => {
  test("conta os triggers pinados numa versão", async () => {
    const wf = await createWorkflow("count-wf");
    const version = await publishVersion(wf.id);

    expect(await triggersRepository.countByVersion(version.id)).toBe(0);

    await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "pin-1",
      type: "webhook",
      workflowVersionId: version.id,
    });
    await triggersRepository.create({
      organizationId: orgId,
      workflowId: wf.id,
      name: "pin-2",
      type: "webhook",
      workflowVersionId: version.id,
    });

    expect(await triggersRepository.countByVersion(version.id)).toBe(2);
  });

  test("devolve 0 para versão sem trigger nenhum", async () => {
    expect(await triggersRepository.countByVersion(crypto.randomUUID())).toBe(0);
  });
});
