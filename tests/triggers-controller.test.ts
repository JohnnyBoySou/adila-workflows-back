/**
 * Cobertura do `triggersController` — a camada onde moram as regras de negócio
 * dos triggers: bloqueio de tipos sem dispatch, validação cruzada de
 * ambiente/versão, campos cron-vs-webhook, e a sincronização do scheduler
 * BullMQ a cada create/update/remove.
 *
 * Roda contra Postgres e Redis reais (testcontainers), então as asserções de
 * scheduler verificam o estado efetivo no Redis, não chamadas mockadas.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { environmentsRepository } from "../src/features/environments/repository";
import { triggersController } from "../src/features/triggers/controller";
import { triggersRepository } from "../src/features/triggers/repository";
import { workflowVersionsController } from "../src/features/workflow-versions/controller";
import { workflowsController } from "../src/features/workflows/controller";
import { cronSchedulerQueue } from "../src/lib/queue";
import type { CreateTriggerBody } from "../src/features/triggers/schema";

let orgId: string;
let userId: string;
let workflowId: string;
let otherWorkflowId: string;
let environmentId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Triggers Ctrl Tester",
    email: `trg-ctrl-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Triggers Ctrl Org",
    slug: `trg-ctrl-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });

  workflowId = (await createWorkflow("ctrl-wf")).id;
  otherWorkflowId = (await createWorkflow("ctrl-wf-outro")).id;
  environmentId = (
    await environmentsRepository.create({
      organizationId: orgId,
      slug: "prod",
      name: "Production",
      kind: "production",
    })
  ).id;
});

afterAll(async () => {
  await cronSchedulerQueue.close();
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

async function create(body: CreateTriggerBody, wfId = workflowId) {
  const res = await triggersController.create(orgId, wfId, body);
  if ("error" in res) throw new Error(`create falhou: ${res.error}`);
  return res.trigger;
}

async function findScheduler(triggerId: string) {
  const all = await cronSchedulerQueue.getJobSchedulers(0, -1);
  return all.find((s) => s.key === `trigger:${triggerId}`) ?? null;
}

describe("create", () => {
  test("cron habilitado registra o scheduler no BullMQ", async () => {
    const trigger = await create({
      type: "cron",
      name: "diario",
      cronExpression: "0 4 * * *",
      timezone: "America/Sao_Paulo",
    });

    expect(trigger.type).toBe("cron");
    expect(trigger.cronExpression).toBe("0 4 * * *");
    expect(trigger.timezone).toBe("America/Sao_Paulo");
    expect(trigger.webhookToken).toBeNull();

    const scheduler = await findScheduler(trigger.id);
    expect(scheduler?.pattern).toBe("0 4 * * *");
    expect(scheduler?.tz).toBe("America/Sao_Paulo");

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("cron sem timezone assume UTC", async () => {
    const trigger = await create({ type: "cron", name: "utc", cronExpression: "0 4 * * *" });

    expect(trigger.timezone).toBe("UTC");

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("cron desabilitado não registra scheduler", async () => {
    const trigger = await create({
      type: "cron",
      name: "cron-off",
      cronExpression: "0 4 * * *",
      enabled: false,
    });

    expect(await findScheduler(trigger.id)).toBeNull();
  });

  test("cron inválido é rejeitado antes de tocar o banco", async () => {
    const res = await triggersController.create(orgId, workflowId, {
      type: "cron",
      name: "quebrado",
      cronExpression: "99 * * * *",
    });

    expect(res).toEqual({ error: "invalid_cron" });
    const rows = await triggersController.list(orgId, workflowId);
    expect(rows.some((r) => r.name === "quebrado")).toBe(false);
  });

  test("webhook ganha token hex de 64 chars e defaults de resposta", async () => {
    const trigger = await create({ type: "webhook", name: "hook" });

    expect(trigger.webhookToken).toMatch(/^[0-9a-f]{64}$/);
    expect(trigger.webhookResponseMode).toBe("async");
    expect(trigger.webhookResponseTimeoutMs).toBe(30_000);
    expect(trigger.allowedMethods).toEqual(["POST"]);
    expect(trigger.hmacSecret).toBeNull();
    expect(trigger.cronExpression).toBeNull();
  });

  test("cada webhook recebe um token distinto", async () => {
    const a = await create({ type: "webhook", name: "hook-a" });
    const b = await create({ type: "webhook", name: "hook-b" });

    expect(a.webhookToken).not.toBe(b.webhookToken);
  });

  test("webhook respeita os overrides informados", async () => {
    const trigger = await create({
      type: "webhook",
      name: "hook-custom",
      webhookResponseMode: "sync",
      webhookResponseTimeoutMs: 5_000,
      allowedMethods: ["GET", "POST"],
      hmacSecret: "segredo-de-16-chars",
    });

    expect(trigger.webhookResponseMode).toBe("sync");
    expect(trigger.webhookResponseTimeoutMs).toBe(5_000);
    expect(trigger.allowedMethods).toEqual(["GET", "POST"]);
    expect(trigger.hmacSecret).toBe("segredo-de-16-chars");
  });

  test("interval_trigger habilitado registra o scheduler com o every em ms", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "a-cada-5min",
      config: { every: 5, unit: "minutes" },
    });

    expect(trigger.config).toEqual({ every: 5, unit: "minutes" });
    expect(Number((await findScheduler(trigger.id))?.every)).toBe(300_000);

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("interval_trigger desabilitado não registra scheduler", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "interval-off",
      config: { every: 5, unit: "minutes" },
      enabled: false,
    });

    expect(await findScheduler(trigger.id)).toBeNull();
  });

  test.each([
    ["email_trigger"],
    ["form_trigger"],
    ["chat_trigger"],
    ["rss_trigger"],
    ["postgres_trigger"],
    ["redis_trigger"],
  ])("bloqueia %s — tipo sem mecanismo de dispatch", async (type) => {
    const res = await triggersController.create(orgId, workflowId, {
      type,
      name: "orfao",
    } as CreateTriggerBody);

    expect(res).toEqual({ error: "trigger_type_unavailable" });
  });

  test("permite os tipos opacos que já têm dispatch (ex: error_trigger)", async () => {
    const trigger = await create({ type: "error_trigger", name: "on-error" });

    expect(trigger.type).toBe("error_trigger");
    expect(trigger.config).toEqual({});
  });

  test("rejeita environmentId inexistente", async () => {
    const res = await triggersController.create(orgId, workflowId, {
      type: "webhook",
      name: "env-fantasma",
      environmentId: crypto.randomUUID(),
    });

    expect(res).toEqual({ error: "environment_not_found" });
  });

  test("aceita environmentId válido da própria org", async () => {
    const trigger = await create({ type: "webhook", name: "com-env", environmentId });

    expect(trigger.environmentId).toBe(environmentId);
  });

  test("rejeita versão de outro workflow — protege o invariante do pino", async () => {
    const versaoAlheia = await publishVersion(otherWorkflowId);

    const res = await triggersController.create(orgId, workflowId, {
      type: "webhook",
      name: "versao-alheia",
      workflowVersionId: versaoAlheia.id,
    });

    expect(res).toEqual({ error: "workflow_version_not_found" });
  });

  test("rejeita versão inexistente", async () => {
    const res = await triggersController.create(orgId, workflowId, {
      type: "webhook",
      name: "versao-fantasma",
      workflowVersionId: crypto.randomUUID(),
    });

    expect(res).toEqual({ error: "workflow_version_not_found" });
  });

  test("aceita versão do próprio workflow", async () => {
    const wf = await createWorkflow("create-pin-wf");
    const version = await publishVersion(wf.id);

    const trigger = await create({ type: "webhook", name: "pinado", workflowVersionId: version.id }, wf.id);

    expect(trigger.workflowVersionId).toBe(version.id);
  });
});

describe("update", () => {
  test("devolve not_found para trigger inexistente", async () => {
    const res = await triggersController.update(orgId, workflowId, crypto.randomUUID(), {
      name: "x",
    });

    expect(res).toEqual({ error: "not_found" });
  });

  test("devolve not_found quando o trigger é de outro workflow", async () => {
    const trigger = await create({ type: "webhook", name: "escopo" });

    const res = await triggersController.update(orgId, otherWorkflowId, trigger.id, { name: "x" });

    expect(res).toEqual({ error: "not_found" });
  });

  test("bloqueia troca de versão — obriga o endpoint /promote", async () => {
    const trigger = await create({ type: "webhook", name: "sem-atalho" });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      workflowVersionId: null,
    });

    expect(res).toEqual({ error: "use_promote_endpoint" });
  });

  test("rejeita environmentId inexistente", async () => {
    const trigger = await create({ type: "webhook", name: "env-update" });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      environmentId: crypto.randomUUID(),
    });

    expect(res).toEqual({ error: "environment_not_found" });
  });

  test("rejeita campos de cron num trigger webhook", async () => {
    const trigger = await create({ type: "webhook", name: "hook-sem-cron" });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      cronExpression: "0 4 * * *",
    });

    expect(res).toEqual({ error: "cron_fields_on_webhook" });
  });

  test("rejeita campos de webhook num trigger cron", async () => {
    const trigger = await create({ type: "cron", name: "cron-sem-hook", cronExpression: "0 4 * * *" });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      hmacSecret: "segredo-de-16-chars",
    });

    expect(res).toEqual({ error: "webhook_fields_on_cron" });

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("rejeita cron inválido no update", async () => {
    const trigger = await create({ type: "cron", name: "cron-update", cronExpression: "0 4 * * *" });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      cronExpression: "99 * * * *",
    });

    expect(res).toEqual({ error: "invalid_cron" });

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("trocar a expressão re-registra o scheduler com o novo pattern", async () => {
    const trigger = await create({ type: "cron", name: "resched", cronExpression: "0 4 * * *" });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      cronExpression: "30 7 * * *",
    });
    if ("error" in res) throw new Error(res.error);

    expect(res.trigger.cronExpression).toBe("30 7 * * *");
    expect((await findScheduler(trigger.id))?.pattern).toBe("30 7 * * *");

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("desabilitar cron remove o scheduler; reabilitar recoloca", async () => {
    const trigger = await create({ type: "cron", name: "toggle", cronExpression: "0 4 * * *" });
    expect(await findScheduler(trigger.id)).not.toBeNull();

    await triggersController.update(orgId, workflowId, trigger.id, { enabled: false });
    expect(await findScheduler(trigger.id)).toBeNull();

    await triggersController.update(orgId, workflowId, trigger.id, { enabled: true });
    expect((await findScheduler(trigger.id))?.pattern).toBe("0 4 * * *");

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("desabilitar interval_trigger remove o scheduler", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "interval-toggle",
      config: { every: 5, unit: "minutes" },
    });
    expect(await findScheduler(trigger.id)).not.toBeNull();

    await triggersController.update(orgId, workflowId, trigger.id, { enabled: false });

    expect(await findScheduler(trigger.id)).toBeNull();
  });

  test("mudar o every do interval re-registra com o novo intervalo", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "interval-resched",
      config: { every: 5, unit: "minutes" },
    });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      config: { every: 2, unit: "hours" },
    });
    if ("error" in res) throw new Error(res.error);

    expect(Number((await findScheduler(trigger.id))?.every)).toBe(7_200_000);

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("config faz merge raso — chaves não citadas sobrevivem", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "merge-config",
      config: { every: 5, unit: "minutes" },
    });
    await triggersRepository.updateRaw(trigger.id, {
      config: { every: 5, unit: "minutes", extra: "preservar" },
    });

    const res = await triggersController.update(orgId, workflowId, trigger.id, {
      config: { every: 9 },
    });
    if ("error" in res) throw new Error(res.error);

    expect(res.trigger.config).toEqual({ every: 9, unit: "minutes", extra: "preservar" });

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test("interval com config inválido remove o scheduler em vez de registrar lixo", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "interval-corrompido",
      config: { every: 5, unit: "minutes" },
    });

    await triggersController.update(orgId, workflowId, trigger.id, {
      config: { every: "muito" },
    });

    expect(await findScheduler(trigger.id)).toBeNull();
  });
});

describe("remove", () => {
  test("apaga o trigger e limpa o scheduler do cron", async () => {
    const trigger = await create({ type: "cron", name: "adeus", cronExpression: "0 4 * * *" });

    const removed = await triggersController.remove(orgId, workflowId, trigger.id);

    expect(removed).toEqual({ id: trigger.id, type: "cron" });
    expect(await findScheduler(trigger.id)).toBeNull();
    expect(await triggersController.findById(orgId, workflowId, trigger.id)).toBeNull();
  });

  test("apaga interval_trigger e limpa o scheduler", async () => {
    const trigger = await create({
      type: "interval_trigger",
      name: "adeus-interval",
      config: { every: 5, unit: "minutes" },
    });

    await triggersController.remove(orgId, workflowId, trigger.id);

    expect(await findScheduler(trigger.id)).toBeNull();
  });

  test("devolve null para trigger inexistente", async () => {
    expect(await triggersController.remove(orgId, workflowId, crypto.randomUUID())).toBeNull();
  });
});

describe("promote", () => {
  test("pina a versão e devolve a anterior para o audit log", async () => {
    const wf = await createWorkflow("promote-wf");
    const v1 = await publishVersion(wf.id);
    const v2 = await publishVersion(wf.id);
    const trigger = await create({ type: "webhook", name: "promovido", workflowVersionId: v1.id }, wf.id);

    const res = await triggersController.promote(orgId, wf.id, trigger.id, v2.id);
    if ("error" in res) throw new Error(res.error);

    expect(res.trigger.workflowVersionId).toBe(v2.id);
    expect(res.previousWorkflowVersionId).toBe(v1.id);
  });

  test("workflowVersionId null despina e volta ao comportamento latest", async () => {
    const wf = await createWorkflow("unpin-wf");
    const v1 = await publishVersion(wf.id);
    const trigger = await create({ type: "webhook", name: "despinado", workflowVersionId: v1.id }, wf.id);

    const res = await triggersController.promote(orgId, wf.id, trigger.id, null);
    if ("error" in res) throw new Error(res.error);

    expect(res.trigger.workflowVersionId).toBeNull();
    expect(res.previousWorkflowVersionId).toBe(v1.id);
  });

  test("rejeita versão de outro workflow", async () => {
    const trigger = await create({ type: "webhook", name: "promote-alheio" });
    const versaoAlheia = await publishVersion(otherWorkflowId);

    const res = await triggersController.promote(orgId, workflowId, trigger.id, versaoAlheia.id);

    expect(res).toEqual({ error: "workflow_version_not_found" });
  });

  test("devolve not_found para trigger inexistente", async () => {
    const res = await triggersController.promote(orgId, workflowId, crypto.randomUUID(), null);

    expect(res).toEqual({ error: "not_found" });
  });
});

describe("segredos de webhook", () => {
  test("rotateHmacSecret gera segredo hex novo e devolve em claro", async () => {
    const trigger = await create({ type: "webhook", name: "hmac" });

    const res = await triggersController.rotateHmacSecret(orgId, workflowId, trigger.id);
    if ("error" in res) throw new Error(res.error);

    expect(res.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.trigger?.hmacSecret).toBe(res.secret);
  });

  test("rotateHmacSecret duas vezes produz segredos diferentes", async () => {
    const trigger = await create({ type: "webhook", name: "hmac-2x" });

    const first = await triggersController.rotateHmacSecret(orgId, workflowId, trigger.id);
    const second = await triggersController.rotateHmacSecret(orgId, workflowId, trigger.id);
    if ("error" in first || "error" in second) throw new Error("rotate falhou");

    expect(first.secret).not.toBe(second.secret);
  });

  test("clearHmacSecret zera o segredo", async () => {
    const trigger = await create({ type: "webhook", name: "hmac-clear" });
    await triggersController.rotateHmacSecret(orgId, workflowId, trigger.id);

    const res = await triggersController.clearHmacSecret(orgId, workflowId, trigger.id);
    if ("error" in res) throw new Error(res.error);

    expect(res.trigger?.hmacSecret).toBeNull();
  });

  test("rotateWebhookToken invalida a URL antiga", async () => {
    const trigger = await create({ type: "webhook", name: "token-rotate" });
    const tokenAntigo = trigger.webhookToken!;

    const res = await triggersController.rotateWebhookToken(orgId, workflowId, trigger.id);
    if ("error" in res) throw new Error(res.error);

    expect(res.trigger?.webhookToken).toMatch(/^[0-9a-f]{64}$/);
    expect(res.trigger?.webhookToken).not.toBe(tokenAntigo);
    expect(await triggersRepository.findByWebhookToken(tokenAntigo)).toBeNull();
  });

  test.each([
    ["rotateHmacSecret", triggersController.rotateHmacSecret],
    ["clearHmacSecret", triggersController.clearHmacSecret],
    ["rotateWebhookToken", triggersController.rotateWebhookToken],
  ] as const)("%s recusa trigger que não é webhook", async (_nome, fn) => {
    const trigger = await create({ type: "cron", name: `nao-hook-${_nome}`, cronExpression: "0 4 * * *" });

    expect(await fn(orgId, workflowId, trigger.id)).toEqual({ error: "not_webhook" });

    await triggersController.remove(orgId, workflowId, trigger.id);
  });

  test.each([
    ["rotateHmacSecret", triggersController.rotateHmacSecret],
    ["clearHmacSecret", triggersController.clearHmacSecret],
    ["rotateWebhookToken", triggersController.rotateWebhookToken],
  ] as const)("%s devolve not_found para trigger inexistente", async (_nome, fn) => {
    expect(await fn(orgId, workflowId, crypto.randomUUID())).toEqual({ error: "not_found" });
  });
});

describe("list e findById", () => {
  test("list filtra por tipo", async () => {
    const wf = await createWorkflow("ctrl-list-wf");
    await create({ type: "webhook", name: "hook-list" }, wf.id);
    await create({ type: "cron", name: "cron-list", cronExpression: "0 4 * * *", enabled: false }, wf.id);

    const crons = await triggersController.list(orgId, wf.id, "cron");

    expect(crons.map((r) => r.name)).toEqual(["cron-list"]);
  });

  test("findById respeita o escopo de organização", async () => {
    const trigger = await create({ type: "webhook", name: "escopo-org" });

    expect(
      await triggersController.findById(crypto.randomUUID(), workflowId, trigger.id),
    ).toBeNull();
  });
});
