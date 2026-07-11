import { Elysia } from "elysia";
import { requireOrganization } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { templatesController } from "./controller";
import {
  checkoutTemplateBody,
  installTemplateBody,
  listTemplatesQuery,
  rateTemplateBody,
  templateIdParam,
} from "./schema";

// Catálogo + instalação + checkout. Leitura/instalação abertas a qualquer member
// da org (a "compra" é o gate dos paid, não o papel).
export const templatesRouter = new Elysia({ prefix: "/templates" })
  .use(requireOrganization)

  .get("/", ({ organizationId, query }) => templatesController.list(organizationId, query), {
    query: listTemplatesQuery,
  })

  .get(
    "/:id",
    async ({ organizationId, params, status }) => {
      const tpl = await templatesController.findById(organizationId, params.id);
      if (!tpl) return status(404, { error: "not_found" });
      return tpl;
    },
    { params: templateIdParam },
  )

  .post(
    "/:id/install",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await templatesController.install(organizationId, user.id, params.id, body);
      if (!result.ok) {
        if (result.reason === "not_found") return status(404, { error: "not_found" });
        // Paid sem entitlement → 402 Payment Required.
        return status(402, { error: "payment_required" });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "template.installed",
        resourceType: "template",
        resourceId: params.id,
        metadata: { workflowId: result.workflowId },
        request,
      });
      return status(201, { workflowId: result.workflowId });
    },
    { params: templateIdParam, body: installTemplateBody },
  )

  .post(
    "/:id/checkout",
    async ({ organizationId, user, params, body, status }) => {
      const result = await templatesController.checkout(organizationId, user.id, params.id, body);
      if (!result.ok) {
        switch (result.reason) {
          case "not_found":
            return status(404, { error: "not_found" });
          case "already_owned":
            return status(409, { error: "already_owned" });
          case "free_template":
            return status(400, { error: "free_template" });
          case "stripe_unconfigured":
            return status(503, { error: "stripe_unconfigured" });
        }
      }
      return { url: result.url };
    },
    { params: templateIdParam, body: checkoutTemplateBody },
  )

  // Lista as avaliações (nota + observação) de um template.
  .get("/:id/ratings", ({ params }) => templatesController.listRatings(params.id), {
    params: templateIdParam,
  })

  // Avalia um template: nota (1–5) + observação opcional. Gate de entitlement.
  .post(
    "/:id/rating",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await templatesController.rate(organizationId, user.id, params.id, body);
      if (!result.ok) {
        if (result.reason === "not_found") return status(404, { error: "not_found" });
        // Paid sem entitlement → não pode avaliar.
        return status(403, { error: "forbidden" });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "template.rated",
        resourceType: "template",
        resourceId: params.id,
        metadata: { score: result.rating.score },
        request,
      });
      return status(201, result.rating);
    },
    { params: templateIdParam, body: rateTemplateBody },
  );

// Webhook do Stripe — público, sem auth, precisa do raw body para verificar a
// assinatura. Mountado na raiz (igual ao webhook-router de triggers).
export const stripeWebhookRouter = new Elysia().post(
  "/webhooks/stripe",
  async ({ request, status }) => {
    const rawBody = await request.text();
    const signature = request.headers.get("stripe-signature");
    const result = await templatesController.handleWebhook(rawBody, signature);
    if (!result.received) return status(400, { error: "invalid_signature" });
    return { received: true };
  },
);
