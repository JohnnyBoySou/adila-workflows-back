import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  workflowComments,
  type NewWorkflowComment,
  type WorkflowComment,
} from "../../db/schema";

export const commentsRepository = {
  /** Lista threads (raízes) ordenadas por criação asc, junto com replies. */
  async listByWorkflow(organizationId: string, workflowId: string): Promise<WorkflowComment[]> {
    return db
      .select()
      .from(workflowComments)
      .where(
        and(
          eq(workflowComments.organizationId, organizationId),
          eq(workflowComments.workflowId, workflowId),
        ),
      )
      .orderBy(asc(workflowComments.createdAt));
  },

  async findById(
    organizationId: string,
    workflowId: string,
    id: string,
  ): Promise<WorkflowComment | null> {
    const [row] = await db
      .select()
      .from(workflowComments)
      .where(
        and(
          eq(workflowComments.id, id),
          eq(workflowComments.workflowId, workflowId),
          eq(workflowComments.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /** Conta replies de uma raiz — usado pra mostrar "N respostas" no pin. */
  async countReplies(workflowId: string, parentId: string): Promise<number> {
    const rows = await db
      .select({ id: workflowComments.id })
      .from(workflowComments)
      .where(
        and(eq(workflowComments.workflowId, workflowId), eq(workflowComments.parentId, parentId)),
      );
    return rows.length;
  },

  /** Raízes (parentId IS NULL) — usado quando o front quer só os pins. */
  async listRoots(organizationId: string, workflowId: string): Promise<WorkflowComment[]> {
    return db
      .select()
      .from(workflowComments)
      .where(
        and(
          eq(workflowComments.organizationId, organizationId),
          eq(workflowComments.workflowId, workflowId),
          isNull(workflowComments.parentId),
        ),
      )
      .orderBy(asc(workflowComments.createdAt));
  },

  async create(row: NewWorkflowComment): Promise<WorkflowComment> {
    const [created] = await db.insert(workflowComments).values(row).returning();
    return created!;
  },

  async updateBody(
    id: string,
    patch: { body?: string; mentions?: string[]; resolved?: boolean },
  ): Promise<WorkflowComment | null> {
    const [updated] = await db
      .update(workflowComments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(workflowComments.id, id))
      .returning();
    return updated ?? null;
  },

  async delete(id: string): Promise<void> {
    await db.delete(workflowComments).where(eq(workflowComments.id, id));
  },
};
