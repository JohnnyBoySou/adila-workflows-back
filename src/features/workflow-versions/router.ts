import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { workflowVersionsController } from "./controller";
import { publishVersionBody, workflowVersionParams, workflowVersionsListParams } from "./schema";

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
      return status(201, result.version);
    },
    {
      params: workflowVersionsListParams,
      body: publishVersionBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  );
