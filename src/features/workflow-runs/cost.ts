/**
 * Custo/consumo de IA de um workflow: junta a agregação de tokens por modelo
 * (steps-repository) com a tabela de preço (model-pricing) e devolve o total
 * em USD + breakdown por modelo. Modelo sem preço na tabela entra com
 * `costUsd: null` e `priced: false` — os tokens contam, o custo não.
 */
import { costForUsage } from "./model-pricing";
import { workflowRunStepsRepository, type ModelTokenRow } from "./steps-repository";

export type ModelCostRow = ModelTokenRow & {
  costUsd: number | null;
  priced: boolean;
};

export type WorkflowCostSummary = {
  runsAnalyzed: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Soma só dos modelos com preço conhecido. */
    costUsd: number;
  };
  /** true quando TODOS os modelos consumidos têm preço na tabela. */
  costComplete: boolean;
  /** Custo médio por execução analisada (USD). null se nenhum run. */
  avgCostPerRun: number | null;
  byModel: ModelCostRow[];
};

export async function workflowCostSummary(
  organizationId: string,
  workflowId: string,
  limitRuns: number,
): Promise<WorkflowCostSummary> {
  const { runsAnalyzed, byModel } = await workflowRunStepsRepository.tokenUsageByModel(
    organizationId,
    workflowId,
    limitRuns,
  );

  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costUsd = 0;
  let costComplete = true;

  const rows: ModelCostRow[] = byModel.map((r) => {
    const cost = costForUsage(r.model, r.inputTokens, r.outputTokens);
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    totalTokens += r.totalTokens;
    if (cost === null) {
      costComplete = false;
    } else {
      costUsd += cost;
    }
    return {
      model: r.model,
      executions: r.executions,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      totalTokens: r.totalTokens,
      costUsd: cost,
      priced: cost !== null,
    };
  });

  return {
    runsAnalyzed,
    totals: { inputTokens, outputTokens, totalTokens, costUsd },
    costComplete,
    avgCostPerRun: runsAnalyzed > 0 ? costUsd / runsAnalyzed : null,
    byModel: rows,
  };
}
