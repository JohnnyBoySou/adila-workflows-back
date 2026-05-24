import { Elysia } from "elysia";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { LANE_NAMES, cronSchedulerQueue, workflowQueues } from "../../lib/queue";
import { connection } from "../../lib/redis";

/**
 * Endpoints operacionais — pra Railway/k8s/uptime monitor.
 *
 *   GET /livez   — processo respira (sempre 200, nem checa deps)
 *   GET /readyz  — pronto pra receber tráfego (DB + Redis OK)
 *   GET /health  — alias legado de /livez
 *
 * Liveness ≠ readiness: orquestradores precisam dos dois. Live=false
 * dispara restart; ready=false só tira do load balancer.
 */
const READY_TIMEOUT_MS = 2000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: timeout ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkDb(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await withTimeout(db.execute(sql`SELECT 1`), READY_TIMEOUT_MS, "db");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function checkRedis(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const reply = await withTimeout(connection.ping(), READY_TIMEOUT_MS, "redis");
    if (reply !== "PONG") return { ok: false, error: `unexpected reply: ${reply}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export const healthRouter = new Elysia()
  .get("/livez", () => ({ status: "ok" }))
  .get("/health", () => ({ status: "ok" }))

  .get("/readyz", async ({ status }) => {
    const [database, redis] = await Promise.all([checkDb(), checkRedis()]);
    const ready = database.ok && redis.ok;
    if (!ready) {
      logger.warn({ database, redis }, "readiness check failed");
      return status(503, { status: "degraded", checks: { database, redis } });
    }
    return { status: "ok", checks: { database, redis } };
  })

  /**
   * Métricas operacionais das filas BullMQ.
   *
   * `failed` é a DLQ — jobs esgotaram attempts. Inspecionáveis com
   * `workflowQueue.getFailed(start, end)` se precisar de detalhe;
   * aqui exponho só os contadores pra monitoração externa.
   */
  .get("/health/queue", async () => {
    const lanesEntries = await Promise.all(
      LANE_NAMES.map(
        async (lane) =>
          [
            lane,
            await workflowQueues[lane].getJobCounts(
              "waiting",
              "prioritized",
              "active",
              "delayed",
              "completed",
              "failed",
            ),
          ] as const,
      ),
    );
    const scheduler = await cronSchedulerQueue.getJobCounts(
      "waiting",
      "prioritized",
      "active",
      "delayed",
      "completed",
      "failed",
    );
    return {
      at: new Date().toISOString(),
      queues: {
        workflows: Object.fromEntries(lanesEntries),
        scheduler,
      },
    };
  });
