import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { workflows, type NewWorkflow, type WorkflowStatus } from "../../db/schema";

export interface ListWorkflowsFilters {
  organizationId: string;
  status?: WorkflowStatus;
  /** `undefined` lista tudo, `null` lista raiz, string lista os de uma pasta. */
  folderId?: string | null;
  limit: number;
  offset: number;
}

export const workflowsRepository = {
  async list({ organizationId, status, folderId, limit, offset }: ListWorkflowsFilters) {
    const conditions = [eq(workflows.organizationId, organizationId)];
    if (status) conditions.push(eq(workflows.status, status));
    if (folderId === null) conditions.push(isNull(workflows.folderId));
    else if (typeof folderId === "string") conditions.push(eq(workflows.folderId, folderId));

    const where = and(...conditions);

    // Disparamos count e select em paralelo — uma round-trip extra, mas evita
    // tunar o select com window function só pra pegar total.
    const [items, [totalRow]] = await Promise.all([
      db
        .select()
        .from(workflows)
        .where(where)
        .orderBy(desc(workflows.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(workflows).where(where),
    ]);

    return {
      items,
      total: Number(totalRow?.value ?? 0),
      limit,
      offset,
    };
  },

  async findById(organizationId: string, id: string) {
    const [row] = await db
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  },

  async create(data: NewWorkflow) {
    const [row] = await db.insert(workflows).values(data).returning();
    return row!;
  },

  async update(organizationId: string, id: string, patch: Partial<NewWorkflow>) {
    const [row] = await db
      .update(workflows)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(workflows.id, id), eq(workflows.organizationId, organizationId)))
      .returning();
    return row ?? null;
  },

  async remove(organizationId: string, id: string) {
    const [row] = await db
      .delete(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.organizationId, organizationId)))
      .returning({ id: workflows.id });
    return row ?? null;
  },
};
