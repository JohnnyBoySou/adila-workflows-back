import type { NodeHandler } from "../types";

/**
 * Dispara quando outro workflow falha. Usado para notificar erros,
 * registrar telemetria ou tentar recuperação.
 *
 * Worker enfileira um run quando um workflow referenciado falha, passando
 * input `{ workflowId, runId, error: { message, stack, nodeId } }`.
 *
 * Config:
 *   - watch: "all" | "specific"
 *   - workflowIds?: string[]   (quando watch = "specific")
 */
export const errorTriggerHandler: NodeHandler = async ({ context }) => ({
  output: { error: context.input },
});
