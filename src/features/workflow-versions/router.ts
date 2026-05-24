import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { workflowVersionsController } from "./controller";
import {
  promoteBulkBody,
  publishVersionBody,
  renameVersionBody,
  workflowVersionDiffParams,
  workflowVersionParams,
  workflowVersionsListParams,
} from "./schema";

// Sub-rota de workflows → /workflows/:id/versions.
export const workflowVersionsRouter = new Elysia({
  prefix: "/workflows/:id/versions",
})
  .use(requireOrganization)

  .get(
    "/",
    async ({ organizationId, params, status }) => {
      const result = await workflowVersionsController.list(organizationId, params.id);
      if ("error" in result) return status(404, { error: result.error });
      return result.versions;
    },
    { params: workflowVersionsListParams },
  )

  .get(
    "/:versionId",
    async ({ organizationId, params, status }) => {
      const version = await workflowVersionsController.findById(
        organizationId,
        params.id,
        params.versionId,
      );
      if (!version) return status(404, { error: "not_found" });
      return version;
    },
    { params: workflowVersionParams },
  )

  .post(
    "/",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await workflowVersionsController.publish(
        organizationId,
        params.id,
        user.id,
        body,
      );
      if ("error" in result) return status(404, { error: result.error });
      // Só registra audit quando uma versão nova foi criada.
      if (!result.alreadyExisted) {
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "workflow_version.published",
          resourceType: "workflow_version",
          resourceId: result.version.id,
          metadata: {
            workflowId: params.id,
            version: result.version.version,
            name: result.version.name,
          },
          request,
        });
      }
      // `alreadyExisted` no body permite o front dar feedback sem depender do status HTTP.
      const httpStatus = result.alreadyExisted ? 200 : 201;
      return status(httpStatus, { ...result.version, alreadyExisted: result.alreadyExisted });
    },
    {
      params: workflowVersionsListParams,
      body: publishVersionBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  )

  .get(
    "/:versionId/diff/:toId",
    async ({ organizationId, params, status }) => {
      const result = await workflowVersionsController.diff(
        organizationId,
        params.id,
        params.versionId,
        params.toId,
      );
      if ("error" in result) return status(404, { error: result.error });
      return result;
    },
    { params: workflowVersionDiffParams },
  )

  .patch(
    "/:versionId",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await workflowVersionsController.rename(
        organizationId,
        params.id,
        params.versionId,
        body.name,
      );
      if ("error" in result) return status(404, { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow_version.renamed",
        resourceType: "workflow_version",
        resourceId: result.version.id,
        metadata: {
          workflowId: params.id,
          version: result.version.version,
          from: result.previousName,
          to: result.version.name,
        },
        request,
      });
      return result.version;
    },
    {
      params: workflowVersionParams,
      body: renameVersionBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  )

  .post(
    "/:versionId/restore",
    async ({ organizationId, user, params, status, request }) => {
      const result = await workflowVersionsController.restore(
        organizationId,
        params.id,
        params.versionId,
      );
      if ("error" in result) return status(404, { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "workflow.restored_from_version",
        resourceType: "workflow",
        resourceId: params.id,
        metadata: {
          versionId: result.version.id,
          version: result.version.version,
        },
        request,
      });
      return result.workflow;
    },
    { params: workflowVersionParams, beforeHandle: requireRole("owner", "admin") },
  )

  .post(
    "/:versionId/promote",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await workflowVersionsController.promoteBulk(
        organizationId,
        params.id,
        params.versionId,
        body.triggerIds,
      );
      if ("error" in result) return status(404, { error: result.error });

      // Só audita quando algum trigger foi efetivamente promovido.
      if (result.promoted.length > 0) {
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "workflow.promoted",
          resourceType: "workflow",
          resourceId: params.id,
          metadata: {
            workflowId: params.id,
            workflowVersionId: result.version.id,
            version: result.version.version,
            triggerIds: result.promoted.map((p) => p.trigger.id),
            promoted: result.promoted.map((p) => ({
              triggerId: p.trigger.id,
              from: p.previousWorkflowVersionId,
              to: result.version.id,
            })),
          },
          request,
        });
      }

      return {
        version: result.version,
        promoted: result.promoted.map((p) => ({
          trigger: p.trigger,
          previousWorkflowVersionId: p.previousWorkflowVersionId,
        })),
      };
    },
    {
      params: workflowVersionParams,
      body: promoteBulkBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  );
