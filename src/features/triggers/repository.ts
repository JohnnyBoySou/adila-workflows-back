import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { triggers, type NewTrigger, type TriggerType } from "../../db/schema";

export interface ListTriggersFilters {
  organizationId: string;
  workflowId: string;
  type?: TriggerType;
}

export const triggersRepository = {
  async list({ organizationId, workflowId, type }: ListTriggersFilters) {
    const conditions = [
      eq(triggers.organizationId, organizationId),
      eq(triggers.workflowId, workflowId),
    ];
    if (type) conditions.push(eq(triggers.type, type));

    return db
      .select()
      .from(triggers)
      .where(and(...conditions))
      .orderBy(asc(triggers.name));
  },

  async findById(organizationId: string, workflowId: string, id: string) {
    const [row] = await db
      .select()
      .from(triggers)
      .where(
        and(
          eq(triggers.id, id),
          eq(triggers.workflowId, workflowId),
          eq(triggers.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /** Lookup global usado pelo endpoint público de webhook. */
  async findByWebhookToken(token: string) {
    const [row] = await db.select().from(triggers).where(eq(triggers.webhookToken, token)).limit(1);
    return row ?? null;
  },

  /** Lookup global usado pelo worker do cron scheduler. */
  async findByIdRaw(id: string) {
    const [row] = await db.select().from(triggers).where(eq(triggers.id, id)).limit(1);
    return row ?? null;
  },

  /** Lista global de triggers cron habilitados — usado no boot resync. */
  async listEnabledCronRaw() {
    return db
      .select()
      .from(triggers)
      .where(and(eq(triggers.type, "cron"), eq(triggers.enabled, true)));
  },

  /**
   * Lista global de triggers habilitados por tipo. Usado pelos workers de
   * polling/listener no boot e em respostas a `trigger-updates` (futuro).
   */
  async listEnabledByType(type: TriggerType) {
    return db
      .select()
      .from(triggers)
      .where(and(eq(triggers.type, type), eq(triggers.enabled, true)));
  },

  async create(data: NewTrigger) {
    const [row] = await db.insert(triggers).values(data).returning();
    return row!;
  },

  async update(organizationId: string, workflowId: string, id: string, patch: Partial<NewTrigger>) {
    const [row] = await db
      .update(triggers)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(triggers.id, id),
          eq(triggers.workflowId, workflowId),
          eq(triggers.organizationId, organizationId),
        ),
      )
      .returning();
    return row ?? null;
  },

  /** Update sem escopo de org — usado pelo worker pra registrar lastTriggeredAt/lastRunId. */
  async updateRaw(id: string, patch: Partial<NewTrigger>) {
    const [row] = await db
      .update(triggers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(triggers.id, id))
      .returning();
    return row ?? null;
  },

  /**
   * Atualiza `workflowVersionId` em N triggers de uma vez. Devolve as linhas
   * com os `id` e a versão anterior, pra audit log "from → to".
   * Usado pelo bulk promote — escopo por workflow garante atomicidade.
   */
  async bulkUpdateVersion(
    organizationId: string,
    workflowId: string,
    ids: string[],
    workflowVersionId: string | null,
  ) {
    if (ids.length === 0) return [];
    // Snapshot do estado atual para o audit log (versão anterior por trigger).
    const before = await db
      .select({ id: triggers.id, workflowVersionId: triggers.workflowVersionId })
      .from(triggers)
      .where(
        and(
          inArray(triggers.id, ids),
          eq(triggers.workflowId, workflowId),
          eq(triggers.organizationId, organizationId),
        ),
      );
    const previousByTrigger = new Map(before.map((r) => [r.id, r.workflowVersionId]));

    const updated = await db
      .update(triggers)
      .set({ workflowVersionId, updatedAt: new Date() })
      .where(
        and(
          inArray(triggers.id, ids),
          eq(triggers.workflowId, workflowId),
          eq(triggers.organizationId, organizationId),
        ),
      )
      .returning();

    return updated.map((row) => ({
      trigger: row,
      previousWorkflowVersionId: previousByTrigger.get(row.id) ?? null,
    }));
  },

  async remove(organizationId: string, workflowId: string, id: string) {
    const [row] = await db
      .delete(triggers)
      .where(
        and(
          eq(triggers.id, id),
          eq(triggers.workflowId, workflowId),
          eq(triggers.organizationId, organizationId),
        ),
      )
      .returning({ id: triggers.id, type: triggers.type });
    return row ?? null;
  },
};
