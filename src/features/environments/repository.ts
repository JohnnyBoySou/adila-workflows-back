import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "../../db";
import { environments, type NewEnvironment } from "../../db/schema";

export const environmentsRepository = {
  async list(organizationId: string) {
    return db
      .select()
      .from(environments)
      .where(eq(environments.organizationId, organizationId))
      .orderBy(asc(environments.name));
  },

  async findById(organizationId: string, id: string) {
    const [row] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.id, id), eq(environments.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  },

  async findBySlug(organizationId: string, slug: string) {
    const [row] = await db
      .select()
      .from(environments)
      .where(and(eq(environments.organizationId, organizationId), eq(environments.slug, slug)))
      .limit(1);
    return row ?? null;
  },

  async create(data: NewEnvironment) {
    const [row] = await db.insert(environments).values(data).returning();
    return row!;
  },

  async update(organizationId: string, id: string, patch: Partial<NewEnvironment>) {
    const [row] = await db
      .update(environments)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(environments.id, id), eq(environments.organizationId, organizationId)))
      .returning();
    return row ?? null;
  },

  async remove(organizationId: string, id: string) {
    const [row] = await db
      .delete(environments)
      .where(and(eq(environments.id, id), eq(environments.organizationId, organizationId)))
      .returning({ id: environments.id });
    return row ?? null;
  },

  /** Garante apenas um ambiente default por org (zera os outros). */
  async clearDefaultExcept(organizationId: string, exceptId: string) {
    await db
      .update(environments)
      .set({ isDefault: false })
      .where(and(eq(environments.organizationId, organizationId), ne(environments.id, exceptId)));
  },
};
