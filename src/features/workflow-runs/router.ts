import { Elysia } from "elysia";
import { requireOrganization } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { workflowRunsController } from "./controller";
import { workflowRunsRepository } from "./repository";
import { workflowRunStepsRepository } from "./steps-repository";
import { listRunsParams, listRunsQuery, runParams } from "./schema";

// Sub-rota de workflows → /workflows/:id/runs.
export const workflowRunsRouter = new Elysia({ prefix: "/workflows/:id/runs" })
  .use(requireOrganization)

  .get(
    "/",
    ({ organizationId, params, query }) =>
      workflowRunsRepository.list({
        organizationId,
        workflowId: params.id,
        status: query.status,
        limit: query.limit ?? 20,
        offset: query.offset ?? 0,
      }),
    { params: listRunsParams, query: listRunsQuery },
  )

  .get(
    "/:runId",
    async ({ organizationId, params, status }) => {
      const run = await workflowRunsRepository.findById(organizationId, params.id, params.runId);
      if (!run) return status(404, { error: "not_found" });
      return run;
    },
    { params: runParams },
  )

  // Trilha de execução nó-a-nó. Útil pra debug visual no editor.
  .get(
    "/:runId/steps",
    async ({ organizationId, params, status }) => {
      const run = await workflowRunsRepository.findById(organizationId, params.id, params.runId);
      if (!run) return status(404, { error: "not_found" });
      return workflowRunStepsRepository.listByRun(run.id);
    },
    { params: runParams },
  )

  // Cancela um run. queued sai da fila; running recebe sinal cooperativo.
  .post(
    "/:runId/cancel",
    async ({ organizationId, user, params, status, request }) => {
      const result = await workflowRunsController.cancel(organizationId, params.id, params.runId);
      if ("error" in result) {
        if (result.error === "not_found") return status(404, { error: result.error });
        return status(409, { error: result.error, status: result.status });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow_run.cancelled",
        resourceType: "workflow_run",
        resourceId: result.run.id,
        metadata: { workflowId: params.id, previousStatus: result.run.status },
        request,
      });
      return result.run;
    },
    { params: runParams },
  );
