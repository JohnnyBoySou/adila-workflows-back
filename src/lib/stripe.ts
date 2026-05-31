import Stripe from "stripe";

// Stripe é opcional em dev: só inicializa se a chave existir. Endpoints de
// pagamento retornam 503 quando não configurado (ver service).
let cached: Stripe | null | undefined;

export function getStripe(): Stripe | null {
  if (cached !== undefined) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  cached = key ? new Stripe(key) : null;
  return cached;
}

export function getStripeWebhookSecret(): string | null {
  return process.env.STRIPE_WEBHOOK_SECRET ?? null;
}
