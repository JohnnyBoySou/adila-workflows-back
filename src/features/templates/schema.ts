import { t } from "elysia";

// Vitrine pública (catálogo). Filtros opcionais de tier, categoria e busca.
export const listTemplatesQuery = t.Object({
  tier: t.Optional(t.Union([t.Literal("free"), t.Literal("paid")])),
  category: t.Optional(t.String()),
  // Busca textual simples em title/description/tags.
  q: t.Optional(t.String()),
});

export const templateIdParam = t.Object({
  id: t.String({ format: "uuid" }),
});

// Instalação: opcionalmente nome customizado e pasta de destino.
export const installTemplateBody = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  folderId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
});

// Checkout: URLs de retorno do Stripe (success/cancel) vindas do front.
export const checkoutTemplateBody = t.Object({
  successUrl: t.String({ format: "uri" }),
  cancelUrl: t.String({ format: "uri" }),
});

// Avaliação: nota de 1 a 5 + observação opcional.
export const rateTemplateBody = t.Object({
  score: t.Integer({ minimum: 1, maximum: 5 }),
  comment: t.Optional(t.String({ maxLength: 2000 })),
});

export type ListTemplatesQuery = typeof listTemplatesQuery.static;
export type InstallTemplateBody = typeof installTemplateBody.static;
export type CheckoutTemplateBody = typeof checkoutTemplateBody.static;
export type RateTemplateBody = typeof rateTemplateBody.static;
