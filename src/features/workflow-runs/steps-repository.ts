import { asc, eq } from "drizzle-orm";
import { db } from "../../db";
import { workflowRunSteps } from "../../db/schema";

/**
 * Leitura dos steps de um run. Escrita fica isolada no executor — o
 * workflow_run_steps é escrita de uma única origem (o motor).
 */
export const workflowRunStepsRepository = {
  listByRun(runId: string) {
    return db
      .select()
      .from(workflowRunSteps)
      .where(eq(workflowRunSteps.runId, runId))
      .orderBy(asc(workflowRunSteps.index));
  },
};
