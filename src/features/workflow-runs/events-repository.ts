import { and, asc, eq, gt, gte } from "drizzle-orm";
import { db } from "../../db";
import { workflowRunEvents, workflowRuns, type NewWorkflowRunEvent } from "../../db/schema";

export const workflowRunEventsRepository = {
  async create(data: NewWorkflowRunEvent) {
    const [row] = await db.insert(workflowRunEvents).values(data).returning();
    return row!;
  },

  /**
   * Insere múltiplos eventos em um único INSERT — usado pelo batcher do
   * worker pra reduzir IO em workflows com muitos nós.
   * Retorna as rows com `seq` preenchido pelo bigserial (ordem preservada).
   */
  async createMany(rows: NewWorkflowRunEvent[]) {
    if (rows.length === 0) return [];
    return db.insert(workflowRunEvents).values(rows).returning();
  },

  async listByRun(organizationId: string, workflowId: string, runId: string) {
    return db
      .select({
        id: workflowRunEvents.id,
        runId: workflowRunEvents.runId,
        nodeId: workflowRunEvents.nodeId,
        eventType: workflowRunEvents.eventType,
        source: workflowRunEvents.source,
        payload: workflowRunEvents.payload,
        occurredAt: workflowRunEvents.occurredAt,
        seq: workflowRunEvents.seq,
      })
      .from(workflowRunEvents)
      .innerJoin(workflowRuns, eq(workflowRuns.id, workflowRunEvents.runId))
      .where(
        and(
          eq(workflowRunEvents.runId, runId),
          eq(workflowRuns.organizationId, organizationId),
          eq(workflowRuns.workflowId, workflowId),
        ),
      )
      .orderBy(asc(workflowRunEvents.seq));
  },

  /**
   * Lista eventos do run com `seq > sinceSeq`. Usado pelo SSE para
   * replay no resume (header `Last-Event-Id`).
   */
  async listByRunSinceSeq(runId: string, sinceSeq: number) {
    return db
      .select({
        id: workflowRunEvents.id,
        runId: workflowRunEvents.runId,
        nodeId: workflowRunEvents.nodeId,
        eventType: workflowRunEvents.eventType,
        source: workflowRunEvents.source,
        payload: workflowRunEvents.payload,
        occurredAt: workflowRunEvents.occurredAt,
        seq: workflowRunEvents.seq,
      })
      .from(workflowRunEvents)
      .where(and(eq(workflowRunEvents.runId, runId), gt(workflowRunEvents.seq, sinceSeq)))
      .orderBy(asc(workflowRunEvents.seq));
  },

  async listWorkflowFinishedEvents(organizationId: string, workflowId: string, since: Date) {
    return db
      .select({ occurredAt: workflowRunEvents.occurredAt })
      .from(workflowRunEvents)
      .where(
        and(
          eq(workflowRunEvents.organizationId, organizationId),
          eq(workflowRunEvents.workflowId, workflowId),
          eq(workflowRunEvents.eventType, "workflow.finished"),
          gte(workflowRunEvents.occurredAt, since),
        ),
      )
      .orderBy(asc(workflowRunEvents.occurredAt));
  },
};
