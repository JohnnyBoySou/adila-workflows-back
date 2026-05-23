import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { workflowRuns, type NewWorkflowRun, type WorkflowRunStatus } from "../../db/schema";

export interface ListRunsFilters {
  organizationId: string;
  workflowId: string;
  status?: WorkflowRunStatus;
  limit: number;
  offset: number;
}

export const workflowRunsRepository = {
  async list({ organizationId, workflowId, status, limit, offset }: ListRunsFilters) {
    const conditions = [
      eq(workflowRuns.organizationId, organizationId),
      eq(workflowRuns.workflowId, workflowId),
    ];
    if (status) conditions.push(eq(workflowRuns.status, status));

    return db
      .select()
      .from(workflowRuns)
      .where(and(...conditions))
      .orderBy(desc(workflowRuns.createdAt))
      .limit(limit)
      .offset(offset);
  },

  async findById(organizationId: string, workflowId: string, id: string) {
    const [row] = await db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.id, id),
          eq(workflowRuns.workflowId, workflowId),
          eq(workflowRuns.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async findByIdRaw(id: string) {
    const [row] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
    return row ?? null;
  },

  async create(data: NewWorkflowRun) {
    const [row] = await db.insert(workflowRuns).values(data).returning();
    return row!;
  },

  async update(id: string, patch: Partial<NewWorkflowRun>) {
    const [row] = await db
      .update(workflowRuns)
      .set(patch)
      .where(eq(workflowRuns.id, id))
      .returning();
    return row ?? null;
  },

  /** Marca início — usado pelo worker assim que o job começa. */
  markRunning(id: string, jobId: string) {
    return this.update(id, {
      status: "running",
      startedAt: new Date(),
      jobId,
    });
  },

  markSuccess(id: string, output: Record<string, unknown>) {
    return this.update(id, {
      status: "success",
      output,
      finishedAt: new Date(),
    });
  },

  markFailed(id: string, error: Record<string, unknown>) {
    return this.update(id, {
      status: "failed",
      error,
      finishedAt: new Date(),
    });
  },

  /** Sinaliza pedido de cancelamento — o worker percebe entre nós. */
  requestCancel(id: string) {
    return this.update(id, { cancelRequested: true });
  },

  markCancelled(id: string) {
    return this.update(id, {
      status: "cancelled",
      finishedAt: new Date(),
    });
  },
};
