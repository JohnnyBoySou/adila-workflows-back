import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Adiciona, sobrescreve ou remove campos (shallow) num objeto ou em cada
 * item de um array. Equivale ao "Edit Fields (Set)" do n8n no modo manual.
 *
 * Config:
 *   - data: Record<string, unknown> | unknown[]
 *   - set?: Record<string, unknown>   campos a adicionar/sobrescrever
 *   - remove?: string[]               chaves a remover
 *   - keep_only?: boolean             se true, descarta tudo fora de set/keep
 *   - keep?: string[]                 lista de chaves a manter (quando keep_only)
 */
function applyEdit(
  obj: Record<string, unknown>,
  cfg: { set: Record<string, unknown>; remove: string[]; keepOnly: boolean; keep: string[] },
): Record<string, unknown> {
  let base: Record<string, unknown>;
  if (cfg.keepOnly) {
    base = {};
    for (const k of cfg.keep) if (k in obj) base[k] = obj[k];
  } else {
    base = { ...obj };
  }
  for (const [k, v] of Object.entries(cfg.set)) base[k] = v;
  for (const k of cfg.remove) delete base[k];
  return base;
}

export const editFieldsHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const data = cfg.data;
  const set = (cfg.set && typeof cfg.set === "object" ? cfg.set : {}) as Record<string, unknown>;
  const remove = Array.isArray(cfg.remove) ? cfg.remove.map(String) : [];
  const keep = Array.isArray(cfg.keep) ? cfg.keep.map(String) : [];
  const keepOnly = Boolean(cfg.keep_only);
  const opts = { set, remove, keepOnly, keep };

  if (Array.isArray(data)) {
    const items = data.map((it) =>
      it && typeof it === "object" ? applyEdit(it as Record<string, unknown>, opts) : it,
    );
    return { output: { items, length: items.length } };
  }

  if (data && typeof data === "object") {
    return { output: { data: applyEdit(data as Record<string, unknown>, opts) } };
  }

  return { output: { data } };
};
