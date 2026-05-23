import { renderTemplate } from "../template";
import type { NodeHandler } from "../types";

/**
 * Invoca outro workflow como sub-execução — equivalente ao
 * `n8n-nodes-base.executeWorkflow`.
 *
 * Config:
 *   - workflowId: string (uuid)
 *   - input?: unknown    — vira o `input` do sub-run; default {}
 *   - environmentId?: string
 *   - timeoutMs?: number — espera máx pelo término; default 60s, máx 5min
 *
 * Output:
 *   - { runId, status, output }
 *
 * O orchestrator real (enfileirar + esperar) é injetado pelo worker via
 * `context.subWorkflowRunner`. Quando rodando fora de worker (ex: dry-run
 * futuro), o handler falha cedo em vez de adivinhar.
 */
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;

export const executeWorkflowHandler: NodeHandler = async ({ node, context }) => {
  const cfg = renderTemplate(node.config, context) as Record<string, unknown>;

  if (!context.subWorkflowRunner) {
    throw new Error("execute_workflow: runner não disponível neste contexto");
  }

  const workflowId = cfg.workflowId;
  if (typeof workflowId !== "string" || !workflowId) {
    throw new Error("execute_workflow: config.workflowId é obrigatório (uuid)");
  }

  const timeoutRaw = cfg.timeoutMs;
  const timeoutMs = Math.min(
    typeof timeoutRaw === "number" && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  );

  const input =
    cfg.input && typeof cfg.input === "object" ? (cfg.input as Record<string, unknown>) : {};
  const environmentId = typeof cfg.environmentId === "string" ? cfg.environmentId : null;

  const result = await context.subWorkflowRunner({
    workflowId,
    input,
    environmentId,
    timeoutMs,
  });

  return {
    output: {
      runId: result.runId,
      status: result.status,
      output: result.output ?? {},
    },
  };
};
