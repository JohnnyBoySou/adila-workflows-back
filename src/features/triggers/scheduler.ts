import { CronExpressionParser } from "cron-parser";
import { cronSchedulerQueue } from "../../lib/queue";
import { triggersRepository } from "./repository";

/** Verifica se a expressão cron é válida. */
export function isValidCron(expression: string, tz = "UTC") {
  try {
    CronExpressionParser.parse(expression, { tz });
    return true;
  } catch {
    return false;
  }
}

/** Id estável do scheduler no BullMQ — atrelado ao id do trigger. */
function schedulerId(triggerId: string) {
  return `trigger:${triggerId}`;
}

/**
 * Registra (ou atualiza) o cron de um trigger no BullMQ.
 * O upsert é idempotente — chamável várias vezes com o mesmo id.
 */
export async function upsertCronTrigger(
  triggerId: string,
  cronExpression: string,
  timezone = "UTC",
) {
  await cronSchedulerQueue.upsertJobScheduler(
    schedulerId(triggerId),
    { pattern: cronExpression, tz: timezone },
    {
      name: "fire-trigger",
      data: { triggerId },
      opts: { removeOnComplete: 500, removeOnFail: 1000 },
    },
  );
}

const UNIT_MS = {
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
} as const;
export type IntervalUnit = keyof typeof UNIT_MS;

export function intervalToMs(every: number, unit: IntervalUnit): number {
  return every * UNIT_MS[unit];
}

/**
 * Registra um trigger de intervalo fixo. Usa `every` (ms) do BullMQ — fila
 * compartilhada com cron, o worker distingue só pelo `triggerId` (que aponta
 * pra row do tipo correto no DB).
 *
 * Limite mínimo: 1 segundo. Não trava aqui — a validação do `every >= 1` está
 * no schema TypeBox; intervalos curtos demais sobrecarregariam o BullMQ.
 */
export async function upsertIntervalTrigger(triggerId: string, every: number, unit: IntervalUnit) {
  const ms = intervalToMs(every, unit);
  await cronSchedulerQueue.upsertJobScheduler(
    schedulerId(triggerId),
    { every: ms },
    {
      name: "fire-trigger",
      data: { triggerId },
      opts: { removeOnComplete: 500, removeOnFail: 1000 },
    },
  );
}

/** Remove o scheduler — usado ao desabilitar/excluir o trigger. */
export async function removeCronTrigger(triggerId: string) {
  await cronSchedulerQueue.removeJobScheduler(schedulerId(triggerId));
}

/** Alias semântico — `removeCronTrigger` na verdade remove qualquer scheduler. */
export const removeScheduledTrigger = removeCronTrigger;

/**
 * Re-registra no BullMQ todos os triggers cron habilitados do banco.
 * Protege contra perda de estado do Redis (flush, migração, etc).
 * Idempotente — pode ser chamado a cada boot.
 */
export async function resyncEnabledCronTriggers() {
  const rows = await triggersRepository.listEnabledCronRaw();
  let synced = 0;
  let skipped = 0;

  for (const t of rows) {
    if (!t.cronExpression) {
      skipped++;
      continue;
    }
    await upsertCronTrigger(t.id, t.cronExpression, t.timezone ?? "UTC");
    synced++;
  }

  return { synced, skipped, total: rows.length };
}

/**
 * Equivalente do `resyncEnabledCronTriggers` para `interval_trigger`. Lê
 * `every`/`unit` do `config` JSONB; ignora rows com config inválido.
 */
export async function resyncEnabledIntervalTriggers() {
  const rows = await triggersRepository.listEnabledByType("interval_trigger");
  let synced = 0;
  let skipped = 0;

  for (const t of rows) {
    const cfg = t.config as { every?: unknown; unit?: unknown };
    const every = Number(cfg.every);
    const unit = cfg.unit as IntervalUnit;
    if (!Number.isFinite(every) || every < 1 || !(unit in UNIT_MS)) {
      skipped++;
      continue;
    }
    await upsertIntervalTrigger(t.id, every, unit);
    synced++;
  }

  return { synced, skipped, total: rows.length };
}
