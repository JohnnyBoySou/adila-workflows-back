import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "../../db";
import { workflowRunEvents, workflowRuns, type NewWorkflowRunEvent } from "../../db/schema";

export const workflowRunEventsRepository = {
  async create(data: NewWorkflowRunEvent) {
    const [row] = await db.insert(workflowRunEvents).values(data).returning();
    return row!;
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
      .orderBy(asc(workflowRunEvents.occurredAt), asc(workflowRunEvents.createdAt));
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
