import { workflowQueue } from "../../lib/queue";
import { workflowRunsRepository } from "./repository";

/**
 * Lógica de cancelamento de runs. Três caminhos, escolhidos pelo status:
 *
 * - terminal (success/failed/cancelled) → erro `not_cancellable`
 * - queued (job ainda na fila)          → remove o job + marca cancelled
 * - running (job em execução)           → seta `cancelRequested`; o executor
 *   checa entre nós e aborta com CancelledError, o worker grava cancelled
 */
export const workflowRunsController = {
  async cancel(organizationId: string, workflowId: string, runId: string) {
    const run = await workflowRunsRepository.findById(organizationId, workflowId, runId);
    if (!run) return { error: "not_found" as const };

    if (run.status === "success" || run.status === "failed" || run.status === "cancelled") {
      return { error: "not_cancellable" as const, status: run.status };
    }

    if (run.status === "queued") {
      // Ainda não pegou worker — basta tirar da fila.
      if (run.jobId) {
        try {
          const job = await workflowQueue.getJob(run.jobId);
          await job?.remove();
        } catch {
          // Job pode ter saído da fila entre o check e o remove — ok.
        }
      }
      const updated = await workflowRunsRepository.markCancelled(runId);
      return { run: updated! };
    }

    // status === "running": sinal cooperativo.
    const updated = await workflowRunsRepository.requestCancel(runId);
    return { run: updated! };
  },
};
