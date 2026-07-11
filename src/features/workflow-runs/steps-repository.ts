import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { workflowRunSteps, workflowRuns } from "../../db/schema";

/**
 * Leitura dos steps de um run. Escrita fica isolada no executor — o
 * workflow_run_steps é escrita de uma única origem (o motor).
 */
export const workflowRunStepsRepository = {
  listByRun(runId: string) {
    return db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runId))
      .orderBy(asc(workflowRunSteps.index));
  },

  // Agrega durationMs por nó dos últimos `limitRuns` runs do workflow.
  // Usado pelo painel de performance pra apontar gargalos.
  async durationsByNode(organizationId: string, workflowId: string, limitRuns = 50) {
    const recentRuns = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.organizationId, organizationId),
          eq(workflowRuns.workflowId, workflowId),
        ),
      )
      .orderBy(desc(workflowRuns.createdAt))
      .limit(limitRuns);

    if (recentRuns.length === 0) return [];
    const runIds = recentRuns.map((r) => r.id);

    return db
      .select({
        nodeId: workflowRunSteps.nodeId,
        nodeType: workflowRunSteps.nodeType,
        executions: sql<number>`count(*)::int`,
        avgMs: sql<number>`coalesce(avg(${workflowRunSteps.durationMs})::int, 0)`,
        p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${workflowRunSteps.durationMs})::int, 0)`,
        maxMs: sql<number>`coalesce(max(${workflowRunSteps.durationMs}), 0)::int`,
        failures: sql<number>`sum(case when ${workflowRunSteps.status} = 'failed' then 1 else 0 end)::int`,
      })
      .from(workflowRunSteps)
      .where(and(inArray(workflowRunSteps.runId, runIds), isNotNull(workflowRunSteps.durationMs)))
      .groupBy(workflowRunSteps.nodeId, workflowRunSteps.nodeType)
      .orderBy(desc(sql`avg(${workflowRunSteps.durationMs})`));
  },
};
