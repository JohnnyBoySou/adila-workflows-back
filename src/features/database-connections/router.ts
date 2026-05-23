import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { databaseConnectionsController } from "./controller";
import {
  connectionListParams,
  connectionListQuery,
  connectionParams,
  createConnectionBody,
  schemaQuery,
  updateConnectionBody,
} from "./schema";

const adminOnly = requireRole("owner", "admin");

const ERROR_TO_STATUS: Record<string, number> = {
  not_found: 404,
  name_taken: 409,
  environment_not_found: 400,
  invalid_protocol: 400,
  app_owned_url: 400,
  not_supported_for_kind: 400,
  introspection_failed: 502,
};
function statusFor(err: string | undefined): number {
  if (!err) return 400;
  return ERROR_TO_STATUS[err] ?? 400;
}

/**
 * Coage o query param `environmentId` em três estados: ausente (undefined),
 * "null" literal (filtrar só defaults) e uuid (env específico).
 */
function parseEnvFilter(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "null" || raw === "") return null;
  return raw;
}

// Sub-rota de workflows → /workflows/:id/database-connections.
export const databaseConnectionsRouter = new Elysia({
  prefix: "/workflows/:id/database-connections",
})
  .use(requireOrganization)

  .get(
    "/",
    async ({ organizationId, params, query, status }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });
      return databaseConnectionsController.list(params.id, {
        kind: query.kind,
        environmentId: parseEnvFilter(query.environmentId),
      });
    },
    { params: connectionListParams, query: connectionListQuery },
  )

  .get(
    "/:connectionId",
    async ({ organizationId, params, status }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });
      const row = await databaseConnectionsController.findById(params.id, params.connectionId);
      if (!row) return status(404, { error: "not_found" });
      return row;
    },
    { params: connectionParams },
  )

  .post(
    "/",
    async ({ organizationId, user, params, body, status, request }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });

      const result = await databaseConnectionsController.create(
        organizationId,
        params.id,
        user.id,
        body,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });

      // Nunca logamos a connection string — só metadados.
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "database_connection.created",
        resourceType: "database_connection",
        resourceId: result.connection.id,
        metadata: {
          workflowId: params.id,
          name: result.connection.name,
          kind: result.connection.kind,
          environmentId: result.connection.environmentId,
        },
        request,
      });
      return status(201, result.connection);
    },
    { params: connectionListParams, body: createConnectionBody, beforeHandle: adminOnly },
  )

  .patch(
    "/:connectionId",
    async ({ organizationId, user, params, body, status, request }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });

      const result = await databaseConnectionsController.update(
        organizationId,
        params.id,
        params.connectionId,
        body,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });

      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "database_connection.updated",
        resourceType: "database_connection",
        resourceId: result.connection.id,
        metadata: {
          workflowId: params.id,
          changedKeys: Object.keys(body),
          connectionStringChanged: body.connectionString !== undefined,
        },
        request,
      });
      return result.connection;
    },
    { params: connectionParams, body: updateConnectionBody, beforeHandle: adminOnly },
  )

  .delete(
    "/:connectionId",
    async ({ organizationId, user, params, status, request }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });

      const removed = await databaseConnectionsController.remove(params.id, params.connectionId);
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "database_connection.deleted",
        resourceType: "database_connection",
        resourceId: params.connectionId,
        metadata: { workflowId: params.id },
        request,
      });
      return status(204, null);
    },
    { params: connectionParams, beforeHandle: adminOnly },
  )

  .post(
    "/:connectionId/test",
    async ({ organizationId, params, status }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });

      const result = await databaseConnectionsController.test(params.id, params.connectionId);
      if ("error" in result) return status(404, { error: result.error });
      return result;
    },
    { params: connectionParams, beforeHandle: adminOnly },
  )

  .get(
    "/:connectionId/schema",
    async ({ organizationId, params, query, status }) => {
      const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
      if (!wf) return status(404, { error: "workflow_not_found" });

      const result = await databaseConnectionsController.schema(params.id, params.connectionId, {
        force: query.refresh === true,
      });
      if ("error" in result) {
        return status(statusFor(result.error), {
          error: result.error,
          ...("message" in result && { message: result.message }),
        });
      }
      return result.schema;
    },
    { params: connectionParams, query: schemaQuery },
  );
