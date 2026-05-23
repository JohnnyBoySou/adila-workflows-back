import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Itera sobre um array em lotes — equivalente ao `splitInBatches` do n8n.
 *
 * Config:
 *   - items: unknown[] (templatable; tipicamente `{{ steps.foo.rows }}`)
 *   - batchSize?: number (default 1)
 *
 * Saídas (labels de aresta):
 *   - "loop": liberada enquanto há items; output inclui o `batch` corrente
 *   - "done": liberada quando o cursor esgota o array
 *
 * Funcionamento:
 *   o estado iterativo vive em `context.loopState[node.id]`. Primeira visita
 *   resolve `items` uma única vez (snapshot) e zera o cursor. Visitas
 *   subsequentes só avançam — o array original não é re-resolvido (evita
 *   re-disparar templates a cada iteração).
 */
const MAX_ITEMS = 10_000;

export const splitInBatchesHandler: NodeHandler = async ({ node, context }) => {
  const state = (context.loopState ??= {});
  let entry = state[node.id];

  if (!entry) {
    const itemsRaw = renderTemplate(node.config.items, context);
    if (!Array.isArray(itemsRaw)) {
      throw new Error("split_in_batches: config.items precisa resolver pra um array");
    }
    if (itemsRaw.length > MAX_ITEMS) {
      throw new Error(`split_in_batches: array de ${itemsRaw.length} excede o limite ${MAX_ITEMS}`);
    }
    entry = { cursor: 0, items: itemsRaw };
    state[node.id] = entry;
  }

  const batchSizeRaw = node.config.batchSize;
  const batchSize =
    typeof batchSizeRaw === "number" && batchSizeRaw > 0 ? Math.floor(batchSizeRaw) : 1;

  if (entry.cursor >= entry.items.length) {
    // Acabou — limpa o state pra um eventual loop externo poder reusar o nó.
    delete state[node.id];
    return {
      output: { done: true, total: entry.items.length },
      nextLabel: "done",
    };
  }

  const batch = entry.items.slice(entry.cursor, entry.cursor + batchSize);
  const batchIndex = Math.floor(entry.cursor / batchSize);
  entry.cursor += batchSize;

  return {
    output: {
      batch,
      batchIndex,
      cursor: entry.cursor,
      total: entry.items.length,
      done: false,
    },
    nextLabel: "loop",
  };
};
