/**
 * Tabela de preço por modelo (USD por 1M de tokens) e cálculo de custo.
 *
 * Fonte da verdade em TS, não no banco: o step guarda só tokens + model, e o
 * custo é calculado no read. Assim, reajuste de preço vale retroativo e não
 * congelamos valor defasado. Modelo desconhecido → custo `null` (a UI mostra
 * "—", nunca um número errado).
 *
 * Preços de referência (jul/2026). Atualize aqui quando o provider mudar. O
 * match é por prefixo pra tolerar sufixos de versão/data (ex.:
 * "claude-sonnet-4-6", "gpt-4o-2024-08-06").
 */

export type ModelPrice = {
  /** USD por 1M de tokens de input. */
  inputPer1M: number;
  /** USD por 1M de tokens de output. Embeddings = 0 (só input). */
  outputPer1M: number;
};

// Ordem importa: prefixos mais específicos primeiro (o primeiro match vence).
const PRICE_TABLE: Array<{ prefix: string; price: ModelPrice }> = [
  // ── Anthropic Claude ──
  { prefix: "claude-opus-4", price: { inputPer1M: 15, outputPer1M: 75 } },
  { prefix: "claude-sonnet-4", price: { inputPer1M: 3, outputPer1M: 15 } },
  { prefix: "claude-haiku-4", price: { inputPer1M: 1, outputPer1M: 5 } },
  { prefix: "claude-3-5-haiku", price: { inputPer1M: 0.8, outputPer1M: 4 } },
  { prefix: "claude-3-5-sonnet", price: { inputPer1M: 3, outputPer1M: 15 } },
  { prefix: "claude-3-opus", price: { inputPer1M: 15, outputPer1M: 75 } },
  { prefix: "claude-3-haiku", price: { inputPer1M: 0.25, outputPer1M: 1.25 } },
  // ── OpenAI GPT ──
  { prefix: "gpt-4o-mini", price: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { prefix: "gpt-4o", price: { inputPer1M: 2.5, outputPer1M: 10 } },
  { prefix: "gpt-4.1-mini", price: { inputPer1M: 0.4, outputPer1M: 1.6 } },
  { prefix: "gpt-4.1", price: { inputPer1M: 2, outputPer1M: 8 } },
  { prefix: "o3-mini", price: { inputPer1M: 1.1, outputPer1M: 4.4 } },
  // ── OpenAI embeddings (só input) ──
  { prefix: "text-embedding-3-small", price: { inputPer1M: 0.02, outputPer1M: 0 } },
  { prefix: "text-embedding-3-large", price: { inputPer1M: 0.13, outputPer1M: 0 } },
  { prefix: "text-embedding-ada-002", price: { inputPer1M: 0.1, outputPer1M: 0 } },
];

/** Preço do modelo, ou `null` se não estiver na tabela. */
export function priceForModel(model: string | null | undefined): ModelPrice | null {
  if (!model) return null;
  const normalized = model.toLowerCase();
  for (const entry of PRICE_TABLE) {
    if (normalized.startsWith(entry.prefix)) return entry.price;
  }
  return null;
}

/**
 * Custo em USD de um consumo. `null` quando o modelo é desconhecido — quem
 * chama decide como somar (tratamos desconhecido como custo não-contabilizado,
 * mas os tokens ainda contam).
 */
export function costForUsage(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputPer1M + (outputTokens / 1_000_000) * price.outputPer1M;
}
