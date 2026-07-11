import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { user } from "../../db/auth-schema";
import {
  type NewTemplatePurchase,
  type NewTemplateRating,
  type TemplatePurchaseStatus,
  templatePurchases,
  templateRatings,
  type TemplateTier,
  workflowTemplates,
} from "../../db/schema";

export interface ListTemplatesFilters {
  tier?: TemplateTier;
  category?: string;
  q?: string;
}

export const templatesRepository = {
  async list({ tier, category, q }: ListTemplatesFilters) {
    const conditions = [eq(workflowTemplates.published, true)];
    if (tier) conditions.push(eq(workflowTemplates.tier, tier));
    if (category) conditions.push(eq(workflowTemplates.category, category));
    if (q && q.trim()) {
      const term = `%${q.trim().toLowerCase()}%`;
      conditions.push(
        sql`(lower(${workflowTemplates.title}) like ${term} or lower(${workflowTemplates.description}) like ${term} or lower(${workflowTemplates.tags}::text) like ${term})`,
      );
    }

    return db
      .select()
      .from(workflowTemplates)
      .where(and(...conditions))
      .orderBy(asc(workflowTemplates.sortOrder), asc(workflowTemplates.title));
  },

  async findById(id: string) {
    const [row] = await db
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.id, id), eq(workflowTemplates.published, true)))
      .limit(1);
    return row ?? null;
  },

  async findBySlug(slug: string) {
    const [row] = await db
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.slug, slug))
      .limit(1);
    return row ?? null;
  },

  /** Incrementa o contador de clones (chamado a cada instalação bem-sucedida). */
  async incrementCloneCount(id: string): Promise<void> {
    await db
      .update(workflowTemplates)
      .set({ cloneCount: sql`${workflowTemplates.cloneCount} + 1` })
      .where(eq(workflowTemplates.id, id));
  },

  // ── Compras / entitlement ──────────────────────────────────────────────

  async findPurchase(organizationId: string, templateId: string) {
    const [row] = await db
      .select()
      .from(templatePurchases)
      .where(
        and(
          eq(templatePurchases.organizationId, organizationId),
          eq(templatePurchases.templateId, templateId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  async listPurchasesByOrg(organizationId: string) {
    return db
      .select()
      .from(templatePurchases)
      .where(eq(templatePurchases.organizationId, organizationId));
  },

  async upsertPendingPurchase(data: NewTemplatePurchase) {
    // Reaproveita a linha existente (entitlement único por org+template).
    const [row] = await db
      .insert(templatePurchases)
      .values(data)
      .onConflictDoUpdate({
        target: [templatePurchases.organizationId, templatePurchases.templateId],
        set: {
          status: data.status,
          amountCents: data.amountCents,
          currency: data.currency,
          stripeSessionId: data.stripeSessionId,
          purchasedBy: data.purchasedBy,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  },

  async findPurchaseBySession(stripeSessionId: string) {
    const [row] = await db
      .select()
      .from(templatePurchases)
      .where(eq(templatePurchases.stripeSessionId, stripeSessionId))
      .limit(1);
    return row ?? null;
  },

  async markPurchaseStatus(
    id: string,
    status: TemplatePurchaseStatus,
    extra: { stripePaymentIntentId?: string; paidAt?: Date } = {},
  ) {
    const [row] = await db
      .update(templatePurchases)
      .set({
        status,
        ...(extra.stripePaymentIntentId !== undefined && {
          stripePaymentIntentId: extra.stripePaymentIntentId,
        }),
        ...(extra.paidAt !== undefined && { paidAt: extra.paidAt }),
        updatedAt: new Date(),
      })
      .where(eq(templatePurchases.id, id))
      .returning();
    return row ?? null;
  },

  // ── Avaliações (nota + observação) ─────────────────────────────────────

  /** Cria/atualiza a avaliação do usuário (uma por usuário+template). */
  async upsertRating(data: NewTemplateRating) {
    const [row] = await db
      .insert(templateRatings)
      .values(data)
      .onConflictDoUpdate({
        target: [templateRatings.templateId, templateRatings.userId],
        set: {
          score: data.score,
          comment: data.comment ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row!;
  },

  /**
   * Recalcula o agregado (média de notas → stars, total → ratingCount) do
   * template a partir das avaliações individuais. Fonte da verdade do resumo.
   */
  async recomputeRatingStats(templateId: string): Promise<void> {
    const [stats] = await db
      .select({
        avg: sql<number>`coalesce(avg(${templateRatings.score}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(templateRatings)
      .where(eq(templateRatings.templateId, templateId));

    await db
      .update(workflowTemplates)
      .set({
        stars: Number(stats?.avg ?? 0),
        ratingCount: Number(stats?.count ?? 0),
      })
      .where(eq(workflowTemplates.id, templateId));
  },

  async getRatingByUser(templateId: string, userId: string) {
    const [row] = await db
      .select()
      .from(templateRatings)
      .where(and(eq(templateRatings.templateId, templateId), eq(templateRatings.userId, userId)))
      .limit(1);
    return row ?? null;
  },

  async listRatings(templateId: string) {
    return db
      .select({
        id: templateRatings.id,
        score: templateRatings.score,
        comment: templateRatings.comment,
        userId: templateRatings.userId,
        authorName: user.name,
        authorImage: user.image,
        createdAt: templateRatings.createdAt,
        updatedAt: templateRatings.updatedAt,
      })
      .from(templateRatings)
      .innerJoin(user, eq(user.id, templateRatings.userId))
      .where(eq(templateRatings.templateId, templateId))
      .orderBy(desc(templateRatings.updatedAt));
  },
};
