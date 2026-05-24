import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Diff entre dois arrays de objetos pela chave indicada.
 *
 * Config:
 *   - a: unknown[]   (anterior)
 *   - b: unknown[]   (novo)
 *   - key: dot-path identificando o item em ambos os lados
 *
 * Output:
 *   - added:   itens presentes em b mas não em a
 *   - removed: itens presentes em a mas não em b
 *   - changed: { key, before, after } quando o JSON difere
 *   - equal:   itens iguais
 */
export const compareDatasetsHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const a = Array.isArray(cfg.a) ? cfg.a : [];
  const b = Array.isArray(cfg.b) ? cfg.b : [];
  const key = cfg.key;
  if (typeof key !== "string" || !key) {
    throw new Error("compare_datasets: `key` é obrigatório");
  }

  const mapA = new Map<string, unknown>();
  for (const it of a) mapA.set(JSON.stringify(resolvePath(it, key) ?? null), it);
  const mapB = new Map<string, unknown>();
  for (const it of b) mapB.set(JSON.stringify(resolvePath(it, key) ?? null), it);

  const added: unknown[] = [];
  const removed: unknown[] = [];
  const changed: { key: unknown; before: unknown; after: unknown }[] = [];
  const equal: unknown[] = [];

  for (const [k, item] of mapB) {
    if (!mapA.has(k)) added.push(item);
  }
  for (const [k, item] of mapA) {
    if (!mapB.has(k)) {
      removed.push(item);
      continue;
    }
    const after = mapB.get(k);
    if (JSON.stringify(item) === JSON.stringify(after)) {
      equal.push(item);
    } else {
      changed.push({ key: JSON.parse(k), before: item, after });
    }
  }

  return { output: { added, removed, changed, equal } };
};
