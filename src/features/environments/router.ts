import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { environmentsController } from "./controller";
import { createEnvironmentBody, environmentIdParam, updateEnvironmentBody } from "./schema";

const adminOnly = requireRole("owner", "admin");

export const environmentsRouter = new Elysia({ prefix: "/environments" })
  .use(requireOrganization)

  .get("/", ({ organizationId }) => environmentsController.list(organizationId))

  .get(
    "/:id",
    async ({ organizationId, params, status }) => {
      const env = await environmentsController.findById(organizationId, params.id);
      if (!env) return status(404, { error: "not_found" });
      return env;
    },
    { params: environmentIdParam },
  )

  .post(
    "/",
    async ({ organizationId, user, body, status, request }) => {
      const result = await environmentsController.create(organizationId, body);
      if ("error" in result) return status(409, { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "environment.created",
        resourceType: "environment",
        resourceId: result.environment.id,
        metadata: { slug: result.environment.slug, kind: result.environment.kind },
        request,
      });
      return status(201, result.environment);
    },
    { body: createEnvironmentBody, beforeHandle: adminOnly },
  )

  .patch(
    "/:id",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await environmentsController.update(organizationId, params.id, body);
      if ("error" in result) {
        return status(result.error === "not_found" ? 404 : 409, { error: result.error });
      }
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "environment.updated",
        resourceType: "environment",
        resourceId: result.environment.id,
        metadata: { patch: body },
        request,
      });
      return result.environment;
    },
    { params: environmentIdParam, body: updateEnvironmentBody, beforeHandle: adminOnly },
  )

  .delete(
    "/:id",
    async ({ organizationId, user, params, status, request }) => {
      const removed = await environmentsController.remove(organizationId, params.id);
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "environment.deleted",
        resourceType: "environment",
        resourceId: params.id,
        request,
      });
      return status(204, null);
    },
    { params: environmentIdParam, beforeHandle: adminOnly },
  );
