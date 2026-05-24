import { and, asc, desc, eq, gte } from "drizzle-orm";
import { db } from "../../db";
import { collaborationSnapshots, workflows, type NewCollaborationSnapshot } from "../../db/schema";

export const collaborationRepository = {
  async append(data: NewCollaborationSnapshot) {
    const [row] = await db.insert(collaborationSnapshots).values(data).returning();
    return row!;
  },

  async latestSnapshot(organizationId: string, workflowId: string) {
    const [row] = await db
      .select()
      .from(collaborationSnapshots)
      .where(
        and(
          eq(collaborationSnapshots.organizationId, organizationId),
          eq(collaborationSnapshots.workflowId, workflowId),
          eq(collaborationSnapshots.kind, "snapshot"),
        ),
      )
      .orderBy(desc(collaborationSnapshots.createdAt))
      .limit(1);
    return row ?? null;
  },

  async patchesSince(organizationId: string, workflowId: string, since: Date) {
    return db
      .select()
      .from(collaborationSnapshots)
      .where(
        and(
          eq(collaborationSnapshots.organizationId, organizationId),
          eq(collaborationSnapshots.workflowId, workflowId),
          eq(collaborationSnapshots.kind, "patch"),
          gte(collaborationSnapshots.createdAt, since),
        ),
      )
      .orderBy(asc(collaborationSnapshots.createdAt));
  },

  async workflowInOrg(organizationId: string, workflowId: string) {
    const [row] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
      .limit(1);
    return Boolean(row);
  },
};
