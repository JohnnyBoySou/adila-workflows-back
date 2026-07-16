/**
 * Cobertura do scheduler de triggers. Os upserts rodam contra o Redis real do
 * testcontainer (BullMQ de verdade) — o que valida o contrato que importa:
 * idempotência do upsert por triggerId e a limpeza no remove.
 *
 * As funções de resync leem o banco global (todas as orgs), então as asserções
 * são sobre os triggers criados aqui, nunca sobre contagens absolutas.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { member, organization, user } from "../src/db/auth-schema";
import { triggersRepository } from "../src/features/triggers/repository";
import {
  intervalToMs,
  isValidCron,
  removeCronTrigger,
  removeScheduledTrigger,
  resyncEnabledCronTriggers,
  resyncEnabledIntervalTriggers,
  upsertCronTrigger,
  upsertIntervalTrigger,
} from "../src/features/triggers/scheduler";
import { workflowsController } from "../src/features/workflows/controller";
import { cronSchedulerQueue } from "../src/lib/queue";
import type { NewTrigger } from "../src/db/schema";

let orgId: string;
let userId: string;
let workflowId: string;

beforeAll(async () => {
  userId = crypto.randomUUID();
  orgId = crypto.randomUUID();

  await db.insert(user).values({
    id: userId,
    name: "Scheduler Tester",
    email: `sched-${userId}@example.com`,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Scheduler Org",
    slug: `sched-${orgId.slice(0, 8)}`,
  });
  await db.insert(member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId,
    role: "owner",
  });

  const wf = await workflowsController.create(orgId, userId, {
    name: "scheduler-wf",
    definition: { nodes: [] },
  });
  if ("error" in wf) throw new Error(wf.error);
  workflowId = wf.workflow.id;
});

afterAll(async () => {
  await cronSchedulerQueue.close();
});

function newTrigger(patch: Partial<NewTrigger> & { name: string }) {
  return triggersRepository.create({ organizationId: orgId, workflowId, type: "cron", ...patch });
}

async function findScheduler(triggerId: string) {
  const all = await cronSchedulerQueue.getJobSchedulers(0, -1);
  return all.find((s) => s.key === `trigger:${triggerId}`) ?? null;
}

describe("isValidCron", () => {
  test.each([
    ["* * * * *", "a cada minuto"],
    ["0 3 * * 1", "toda segunda às 3h"],
    ["*/15 9-17 * * 1-5", "de 15 em 15 no horário comercial"],
  ])("aceita %s (%s)", (expression) => {
    expect(isValidCron(expression)).toBe(true);
  });

  test.each([["não é cron"], ["99 * * * *"], ["0 0 32 * *"]])(
    "rejeita a expressão inválida %p",
    (expression) => {
      expect(isValidCron(expression)).toBe(false);
    },
  );

  test("valida contra o timezone informado", () => {
    expect(isValidCron("0 3 * * *", "America/Sao_Paulo")).toBe(true);
  });

  // Comportamentos herdados do cron-parser que o schema TypeBox não cobre —
  // ver `docs/` / issue de validação de cron. Fixados aqui para que uma
  // mudança futura de biblioteca (ou o aperto da validação) apareça no diff.
  test("aceita string vazia — o minLength do schema é quem barra na API", () => {
    expect(isValidCron("")).toBe(true);
  });

  test("aceita expressão de 4 campos, reinterpretando os campos", () => {
    expect(isValidCron("* * * *")).toBe(true);
  });

  test("aceita timezone inexistente — o parse não valida a tz", () => {
    expect(isValidCron("0 3 * * *", "Marte/Olympus")).toBe(true);
  });
});

describe("intervalToMs", () => {
  test.each([
    [30, "seconds", 30_000],
    [5, "minutes", 300_000],
    [2, "hours", 7_200_000],
    [1, "days", 86_400_000],
  ] as const)("converte %i %s em %i ms", (every, unit, expected) => {
    expect(intervalToMs(every, unit)).toBe(expected);
  });
});

describe("upsertCronTrigger", () => {
  test("registra o scheduler com pattern, timezone e o triggerId no payload", async () => {
    const triggerId = crypto.randomUUID();

    await upsertCronTrigger(triggerId, "0 4 * * *", "America/Sao_Paulo");

    const scheduler = await findScheduler(triggerId);
    expect(scheduler?.pattern).toBe("0 4 * * *");
    expect(scheduler?.tz).toBe("America/Sao_Paulo");
    expect(scheduler?.template?.data).toEqual({ triggerId });

    await removeCronTrigger(triggerId);
  });

  test("usa UTC como timezone default", async () => {
    const triggerId = crypto.randomUUID();

    await upsertCronTrigger(triggerId, "0 4 * * *");

    expect((await findScheduler(triggerId))?.tz).toBe("UTC");

    await removeCronTrigger(triggerId);
  });

  test("é idempotente — reupsert atualiza o mesmo scheduler em vez de duplicar", async () => {
    const triggerId = crypto.randomUUID();

    await upsertCronTrigger(triggerId, "0 4 * * *");
    await upsertCronTrigger(triggerId, "30 6 * * *");

    const all = await cronSchedulerQueue.getJobSchedulers(0, -1);
    const meus = all.filter((s) => s.key === `trigger:${triggerId}`);
    expect(meus).toHaveLength(1);
    expect(meus[0]?.pattern).toBe("30 6 * * *");

    await removeCronTrigger(triggerId);
  });
});

describe("upsertIntervalTrigger", () => {
  test("registra o scheduler com o intervalo em ms", async () => {
    const triggerId = crypto.randomUUID();

    await upsertIntervalTrigger(triggerId, 10, "minutes");

    const scheduler = await findScheduler(triggerId);
    expect(Number(scheduler?.every)).toBe(600_000);
    expect(scheduler?.template?.data).toEqual({ triggerId });

    await removeScheduledTrigger(triggerId);
  });
});

describe("removeScheduledTrigger", () => {
  test("apaga o scheduler registrado", async () => {
    const triggerId = crypto.randomUUID();
    await upsertCronTrigger(triggerId, "0 4 * * *");

    await removeScheduledTrigger(triggerId);

    expect(await findScheduler(triggerId)).toBeNull();
  });

  test("remover scheduler inexistente não estoura", async () => {
    expect(await removeScheduledTrigger(crypto.randomUUID())).toBeUndefined();
  });
});

describe("resyncEnabledCronTriggers", () => {
  test("re-registra os crons habilitados e pula os sem expressão", async () => {
    const comCron = await newTrigger({ name: "resync-ok", cronExpression: "0 5 * * *" });
    // Cron sem expressão: rows legadas/corrompidas não devem derrubar o boot.
    const semCron = await newTrigger({ name: "resync-sem-expr", cronExpression: null });
    const desabilitado = await newTrigger({
      name: "resync-off",
      cronExpression: "0 5 * * *",
      enabled: false,
    });

    const result = await resyncEnabledCronTriggers();

    expect(result.total).toBe(result.synced + result.skipped);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect((await findScheduler(comCron.id))?.pattern).toBe("0 5 * * *");
    expect(await findScheduler(semCron.id)).toBeNull();
    expect(await findScheduler(desabilitado.id)).toBeNull();

    await removeScheduledTrigger(comCron.id);
  });

  test("usa UTC quando o trigger não tem timezone", async () => {
    const trigger = await newTrigger({
      name: "resync-sem-tz",
      cronExpression: "0 6 * * *",
      timezone: null,
    });

    await resyncEnabledCronTriggers();

    expect((await findScheduler(trigger.id))?.tz).toBe("UTC");

    await removeScheduledTrigger(trigger.id);
  });
});

describe("resyncEnabledIntervalTriggers", () => {
  test("re-registra os intervalos válidos", async () => {
    const trigger = await newTrigger({
      name: "resync-interval",
      type: "interval_trigger",
      config: { every: 2, unit: "hours" },
    });

    const result = await resyncEnabledIntervalTriggers();

    expect(result.total).toBe(result.synced + result.skipped);
    expect(result.synced).toBeGreaterThanOrEqual(1);
    expect(Number((await findScheduler(trigger.id))?.every)).toBe(7_200_000);

    await removeScheduledTrigger(trigger.id);
  });

  test.each([
    ["config vazio", {}],
    ["every não numérico", { every: "muito", unit: "minutes" }],
    ["every abaixo de 1", { every: 0, unit: "minutes" }],
    ["unit desconhecida", { every: 5, unit: "quinzenas" }],
  ])("pula config inválido: %s", async (_caso, config) => {
    const trigger = await newTrigger({
      name: `resync-invalido-${crypto.randomUUID().slice(0, 8)}`,
      type: "interval_trigger",
      config: config as Record<string, unknown>,
    });

    const result = await resyncEnabledIntervalTriggers();

    expect(result.skipped).toBeGreaterThanOrEqual(1);
    expect(await findScheduler(trigger.id)).toBeNull();

    await triggersRepository.remove(orgId, workflowId, trigger.id);
  });
});
