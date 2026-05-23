import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { workflowsController } from "./controller";
import {
  createWorkflowBody,
  importN8nBody,
  listWorkflowsQuery,
  runWorkflowBody,
  updateWorkflowBody,
  workflowIdParam,
} from "./schema";

const adminOnly = requireRole("owner", "admin");

export const workflowsRouter = new Elysia({ prefix: "/workflows" })
  .use(requireOrganization)

  .get("/", ({ organizationId, query }) => workflowsController.list(organizationId, query), {
    query: listWorkflowsQuery,
  })

  .get(
    "/:id",
    async ({ organizationId, params, status }) => {
      const workflow = await workflowsController.findById(organizationId, params.id);
      if (!workflow) return status(404, { error: "not_found" });
      return workflow;
    },
    { params: workflowIdParam },
  )

  .post(
    "/",
    async ({ organizationId, user, body, status, request }) => {
      const result = await workflowsController.create(organizationId, user.id, body);
      if ("error" in result) return status(400, { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.created",
        resourceType: "workflow",
        resourceId: result.workflow.id,
        metadata: { name: result.workflow.name, folderId: result.workflow.folderId },
        request,
      });
      return status(201, result.workflow);
    },
    { body: createWorkflowBody, beforeHandle: adminOnly },
  )

  // Importa um workflow exportado do n8n. Aceita o JSON cru em `body.workflow`.
  // Retorna o workflow criado + `summary` (mapped/unsupported/skipped por tipo).
  .post(
    "/import/n8n",
    async ({ organizationId, user, body, status, request }) => {
      const result = await workflowsController.importFromN8n(organizationId, user.id, body);
      if ("error" in result) {
        const code = result.error === "folder_not_found" ? 404 : 400;
        return status(code, { error: result.error });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.imported",
        resourceType: "workflow",
        resourceId: result.workflow.id,
        metadata: { name: result.workflow.name, summary: result.summary, source: "n8n" },
        request,
      });
      return status(201, { workflow: result.workflow, summary: result.summary });
    },
    { body: importN8nBody, beforeHandle: adminOnly },
  )

  .patch(
    "/:id",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await workflowsController.update(organizationId, params.id, body);
      if ("error" in result) {
        return status(result.error === "not_found" ? 404 : 400, { error: result.error });
      }
      // Patch pode trazer a `definition` inteira; logamos só o conjunto de chaves
      // alteradas pra evitar payload enorme.
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.updated",
        resourceType: "workflow",
        resourceId: result.workflow.id,
        metadata: { changedKeys: Object.keys(body) },
        request,
      });
      return result.workflow;
    },
    { params: workflowIdParam, body: updateWorkflowBody, beforeHandle: adminOnly },
  )

  .delete(
    "/:id",
    async ({ organizationId, user, params, status, request }) => {
      const removed = await workflowsController.remove(organizationId, params.id);
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.deleted",
        resourceType: "workflow",
        resourceId: params.id,
        request,
      });
      return status(204, null);
    },
    { params: workflowIdParam, beforeHandle: adminOnly },
  )

  .post(
    "/:id/run",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await workflowsController.run(organizationId, params.id, user.id, {
        environmentId: body?.environmentId,
        input: body?.input,
        pinnedData: body?.pinnedData,
      });
      if ("error" in result) {
        return status(result.error === "not_found" ? 404 : 400, { error: result.error });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.ran",
        resourceType: "workflow",
        resourceId: params.id,
        metadata: { runId: result.runId, environmentId: body?.environmentId ?? null },
        request,
      });
      return status(202, result);
    },
    { params: workflowIdParam, body: runWorkflowBody },
  );
