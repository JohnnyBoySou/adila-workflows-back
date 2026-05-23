import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { folders, type NewFolder } from "../../db/schema";

export interface ListFoldersFilters {
  organizationId: string;
  /** `undefined` lista tudo, `null` lista raiz, string lista filhos do id informado. */
  parentId?: string | null;
}

export const foldersRepository = {
  async list({ organizationId, parentId }: ListFoldersFilters) {
    const conditions = [eq(folders.organizationId, organizationId)];
    if (parentId === null) conditions.push(isNull(folders.parentId));
    else if (typeof parentId === "string") conditions.push(eq(folders.parentId, parentId));

    return db
      .select()
      .from(folders)
      .where(and(...conditions))
      .orderBy(asc(folders.name));
  },

  async findById(organizationId: string, id: string) {
    const [row] = await db
      .select()
      .from(folders)
      .where(and(eq(folders.id, id), eq(folders.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  },

  async create(data: NewFolder) {
    const [row] = await db.insert(folders).values(data).returning();
    return row!;
  },

  async update(organizationId: string, id: string, patch: Partial<NewFolder>) {
    const [row] = await db
      .update(folders)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(folders.id, id), eq(folders.organizationId, organizationId)))
      .returning();
    return row ?? null;
  },

  async remove(organizationId: string, id: string) {
    const [row] = await db
      .delete(folders)
      .where(and(eq(folders.id, id), eq(folders.organizationId, organizationId)))
      .returning({ id: folders.id });
    return row ?? null;
  },
};
