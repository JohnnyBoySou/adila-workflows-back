import { renderTemplate, resolvePath } from "../template";
import type { NodeHandler } from "../types";

/**
 * Operações de JSON.
 *
 * Config (discriminado por `operation`):
 *   - parse     → value: string                 → { data }
 *   - stringify → value: unknown, pretty?: bool → { text }
 *   - extract   → value: unknown, path: string  → { value }   (dot-path)
 */
export const jsonHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;
  const op = cfg.operation;

  if (op === "parse") {
    const value = String(cfg.value ?? "");
    try {
      return { output: { data: JSON.parse(value) } };
    } catch (err) {
      throw new Error(`json parse: ${(err as Error).message}`);
    }
  }

  if (op === "stringify") {
    const space = cfg.pretty ? 2 : undefined;
    return { output: { text: JSON.stringify(cfg.value, null, space) } };
  }

  if (op === "extract") {
    const path = cfg.path;
    if (typeof path !== "string" || !path) {
      throw new Error("json extract: `path` é obrigatório");
    }
    return { output: { value: resolvePath(cfg.value, path) } };
  }

  throw new Error(`json: operation "${String(op)}" não suportada`);
};
