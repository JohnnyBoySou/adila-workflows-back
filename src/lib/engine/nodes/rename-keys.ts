import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Renomeia chaves do objeto (ou de cada item do array). Shallow only.
 *
 * Config:
 *   - data: Record<string, unknown> | unknown[]
 *   - mapping: { [oldKey: string]: newKey }
 */
function applyMapping(
  obj: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const dest = mapping[k] ?? k;
    out[dest] = v;
  }
  return out;
}

export const renameKeysHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const mappingRaw = cfg.mapping;
  if (!mappingRaw || typeof mappingRaw !== "object") {
    throw new Error("rename_keys: `mapping` é obrigatório");
  }
  const mapping = mappingRaw as Record<string, string>;
  const data = cfg.data;

  if (Array.isArray(data)) {
    const items = data.map((it) =>
      it && typeof it === "object" ? applyMapping(it as Record<string, unknown>, mapping) : it,
    );
    return { output: { items, length: items.length } };
  }

  if (data && typeof data === "object") {
    return { output: { data: applyMapping(data as Record<string, unknown>, mapping) } };
  }

  return { output: { data } };
};
