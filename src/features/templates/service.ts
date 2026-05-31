import type Stripe from "stripe";
import { db } from "../../db";
import { type TemplateRating, type WorkflowTemplate, workflows } from "../../db/schema";
import { getStripe, getStripeWebhookSecret } from "../../lib/stripe";
import { logger } from "../../lib/logger";
import { templatesRepository } from "./repository";
import type {
  CheckoutTemplateBody,
  InstallTemplateBody,
  ListTemplatesQuery,
  RateTemplateBody,
} from "./schema";

// View pública do template + se a org já tem direito (entitlement).
export interface TemplateView extends WorkflowTemplate {
  owned: boolean;
}

export type InstallResult =
  | { ok: true; workflowId: string }
  | { ok: false; reason: "not_found" | "payment_required" };

export type CheckoutResult =
  | { ok: true; url: string }
  | { ok: false; reason: "not_found" | "already_owned" | "free_template" | "stripe_unconfigured" };

export type RateResult =
  | { ok: true; rating: TemplateRating }
  // forbidden = template paid sem entitlement (não pode avaliar o que não tem).
  | { ok: false; reason: "not_found" | "forbidden" };

function toView(template: WorkflowTemplate, ownedTemplateIds: Set<string>): TemplateView {
  return {
    ...template,
    owned: template.tier === "free" || ownedTemplateIds.has(template.id),
  };
}

export const templatesService = {
  async list(organizationId: string, query: ListTemplatesQuery): Promise<TemplateView[]> {
    const [templates, purchases] = await Promise.all([
      templatesRepository.list({ tier: query.tier, category: query.category, q: query.q }),
      templatesRepository.listPurchasesByOrg(organizationId),
    ]);
    const owned = new Set(purchases.filter((p) => p.status === "paid").map((p) => p.templateId));
    return templates.map((tpl) => toView(tpl, owned));
  },

  async findById(organizationId: string, id: string): Promise<TemplateView | null> {
    const template = await templatesRepository.findById(id);
    if (!template) return null;
    const purchase = await templatesRepository.findPurchase(organizationId, id);
    const owned = new Set(purchase?.status === "paid" ? [id] : []);
    return toView(template, owned);
  },

  // Instala (clona) o template num workflow novo da org. Paid exige entitlement.
  async install(
    organizationId: string,
    userId: string,
    templateId: string,
    body: InstallTemplateBody,
  ): Promise<InstallResult> {
    const template = await templatesRepository.findById(templateId);
    if (!template) return { ok: false, reason: "not_found" };

    if (template.tier === "paid") {
      const purchase = await templatesRepository.findPurchase(organizationId, templateId);
      if (purchase?.status !== "paid") return { ok: false, reason: "payment_required" };
    }

    const [created] = await db
      .insert(workflows)
      .values({
        organizationId,
        name: body.name?.trim() || template.title,
        description: template.description,
        folderId: body.folderId ?? null,
        // Clona o snapshot — o workflow da org evolui de forma independente.
        definition: template.definition,
        status: "draft",
        createdBy: userId,
      })
      .returning({ id: workflows.id });

    // Métrica da vitrine: cada clone bem-sucedido conta.
    await templatesRepository.incrementCloneCount(templateId);

    return { ok: true, workflowId: created!.id };
  },

  // Abre uma sessão de checkout Stripe para um template paid.
  async createCheckout(
    organizationId: string,
    userId: string,
    templateId: string,
    body: CheckoutTemplateBody,
  ): Promise<CheckoutResult> {
    const template = await templatesRepository.findById(templateId);
    if (!template) return { ok: false, reason: "not_found" };
    if (template.tier !== "paid") return { ok: false, reason: "free_template" };

    const existing = await templatesRepository.findPurchase(organizationId, templateId);
    if (existing?.status === "paid") return { ok: false, reason: "already_owned" };

    const stripe = getStripe();
    if (!stripe) return { ok: false, reason: "stripe_unconfigured" };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: body.successUrl,
      cancel_url: body.cancelUrl,
      // Metadata para reconciliar no webhook sem confiar no client.
      metadata: { organizationId, templateId, purchasedBy: userId },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "brl",
            unit_amount: template.priceCents,
            product_data: {
              name: template.title,
              description: template.description.slice(0, 300),
            },
          },
        },
      ],
    });

    await templatesRepository.upsertPendingPurchase({
      organizationId,
      templateId,
      purchasedBy: userId,
      status: "pending",
      amountCents: template.priceCents,
      currency: "brl",
      stripeSessionId: session.id,
    });

    if (!session.url) return { ok: false, reason: "stripe_unconfigured" };
    return { ok: true, url: session.url };
  },

  // Avalia (nota + observação) um template. Só quem tem direito pode avaliar:
  // free → sempre; paid → apenas se a org já comprou (entitlement 'paid').
  async rateTemplate(
    organizationId: string,
    userId: string,
    templateId: string,
    body: RateTemplateBody,
  ): Promise<RateResult> {
    const template = await templatesRepository.findById(templateId);
    if (!template) return { ok: false, reason: "not_found" };

    if (template.tier === "paid") {
      const purchase = await templatesRepository.findPurchase(organizationId, templateId);
      if (purchase?.status !== "paid") return { ok: false, reason: "forbidden" };
    }

    const rating = await templatesRepository.upsertRating({
      templateId,
      organizationId,
      userId,
      score: body.score,
      comment: body.comment ?? null,
    });

    // Atualiza o agregado (média/total) exibido na vitrine.
    await templatesRepository.recomputeRatingStats(templateId);

    return { ok: true, rating };
  },

  // Lista as avaliações de um template (mais recentes primeiro).
  async listRatings(templateId: string) {
    return templatesRepository.listRatings(templateId);
  },

  // Processa o webhook do Stripe. Verifica assinatura, confirma pagamento.
  async handleWebhook(rawBody: string, signature: string | null): Promise<{ received: boolean }> {
    const stripe = getStripe();
    const secret = getStripeWebhookSecret();
    if (!stripe || !secret || !signature) return { received: false };

    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (err) {
      logger.warn({ err }, "stripe webhook signature verification failed");
      return { received: false };
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const purchase = await templatesRepository.findPurchaseBySession(session.id);
      if (purchase && purchase.status !== "paid") {
        await templatesRepository.markPurchaseStatus(purchase.id, "paid", {
          stripePaymentIntentId:
            typeof session.payment_intent === "string" ? session.payment_intent : undefined,
          paidAt: new Date(),
        });
        logger.info(
          { templateId: purchase.templateId, organizationId: purchase.organizationId },
          "template purchase confirmed",
        );
      }
    }

    return { received: true };
  },
};
