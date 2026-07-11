import { findWorkflowJobAcrossLanes, pickLaneForDefinition, workflowQueues } from "../../lib/queue";
import { publishCancel } from "../../lib/run-events";
import { workflowsRepository } from "../workflows/repository";
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
          // Job pode estar em qualquer lane — varremos todas pra achar.
          const found = await findWorkflowJobAcrossLanes(run.jobId);
          await found?.job.remove();
        } catch {
          // Job pode ter saído da fila entre o check e o remove — ok.
        }
      }
      const updated = await workflowRunsRepository.markCancelled(runId);
      return { run: updated! };
    }

    // status === "running": sinal cooperativo.
    // Dois canais: (1) flag persistido no DB cobre worker que ainda não
    // assinou pubsub ou subiu depois; (2) Redis publish notifica
    // instantaneamente quem já está executando, sem polling.
    const updated = await workflowRunsRepository.requestCancel(runId);
    void publishCancel(runId).catch(() => {
      // Best-effort: a flag no DB já garante eventual cancelamento.
    });
    return { run: updated! };
  },

  /**
   * Reexecuta um run *terminal* (success/failed/cancelled) preservando
   * `workflowVersionId` + `input` originais. Não muta o run velho — cria
   * um novo, com `triggeredBy` apontando pra quem clicou rerun.
   *
   * Decisão: só permite rerun de runs terminados. Rerodar um queued/running
   * abriria janela pra dupla-execução; melhor cancelar o atual antes.
   */
  async rerun(organizationId: string, workflowId: string, runId: string, triggeredBy: string) {
    const original = await workflowRunsRepository.findById(organizationId, workflowId, runId);
    if (!original) return { error: "not_found" as const };
    if (
      original.status !== "success" &&
      original.status !== "failed" &&
      original.status !== "cancelled"
    ) {
      return { error: "not_rerunnable" as const, status: original.status };
    }
    // Salvaguarda: se o workflow foi apagado, não roda.
    const workflow = await workflowsRepository.findById(organizationId, workflowId);
    if (!workflow) return { error: "workflow_not_found" as const };

    const newRun = await workflowRunsRepository.create({
      organizationId,
      workflowId,
      workflowVersionId: original.workflowVersionId,
      environmentId: original.environmentId,
      status: "queued",
      input: original.input,
      triggeredBy,
    });

    const lane = pickLaneForDefinition(workflow.definition);
    const job = await workflowQueues[lane].add(
      "execute",
      {
        runId: newRun.id,
        workflowId,
        workflowVersionId: original.workflowVersionId,
        organizationId,
        environmentId: original.environmentId,
        input: original.input,
      },
      { removeOnComplete: 1000, removeOnFail: 5000 },
    );
    if (job.id) await workflowRunsRepository.update(newRun.id, { jobId: job.id });

    return { run: newRun, sourceRunId: runId };
  },
};
