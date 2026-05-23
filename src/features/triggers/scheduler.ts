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

/** Remove o scheduler — usado ao desabilitar/excluir o trigger. */
export async function removeCronTrigger(triggerId: string) {
  await cronSchedulerQueue.removeJobScheduler(schedulerId(triggerId));
}

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
