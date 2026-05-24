import { randomUUID } from "node:crypto";

import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Gera identificadores únicos.
 *
 * Config:
 *   version?: "v4" | "nil"   — default "v4"
 *   count?:   number          — default 1; quando >1 devolve `values: string[]`
 *
 * Output:
 *   count=1: { uuid }
 *   count>1: { values }
 */
export const uuidHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const version = cfg.version === "nil" ? "nil" : "v4";
  const count = typeof cfg.count === "number" && cfg.count > 0 ? Math.min(cfg.count, 1000) : 1;

  const gen = () => (version === "nil" ? "00000000-0000-0000-0000-000000000000" : randomUUID());

  if (count === 1) return { output: { uuid: gen() } };
  const values: string[] = [];
  for (let i = 0; i < count; i++) values.push(gen());
  return { output: { values } };
};
