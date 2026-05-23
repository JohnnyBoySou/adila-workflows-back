import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { triggersController } from "./controller";
import {
  createTriggerBody,
  triggerListParams,
  triggerListQuery,
  triggerParams,
  updateTriggerBody,
} from "./schema";

const adminOnly = requireRole("owner", "admin");

const ERROR_TO_STATUS: Record<string, number> = {
  not_found: 404,
  environment_not_found: 400,
  invalid_cron: 400,
  cron_fields_on_webhook: 400,
  not_webhook: 400,
};

function statusFor(err: string | undefined): number {
  if (!err) return 400;
  return ERROR_TO_STATUS[err] ?? 400;
}

// Sub-rota de workflows → /workflows/:id/triggers.
export const triggersRouter = new Elysia({ prefix: "/workflows/:id/triggers" })
  .use(requireOrganization)

  .get(
    "/",
    ({ organizationId, params, query }) =>
      triggersController.list(organizationId, params.id, query.type),
    { params: triggerListParams, query: triggerListQuery },
  )

  .get(
    "/:triggerId",
    async ({ organizationId, params, status }) => {
      const trigger = await triggersController.findById(
        organizationId,
        params.id,
        params.triggerId,
      );
      if (!trigger) return status(404, { error: "not_found" });
      return trigger;
    },
    { params: triggerParams },
  )

  .post(
    "/",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await triggersController.create(organizationId, params.id, body);
      if ("error" in result) return status(statusFor(result.error), { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "trigger.created",
        resourceType: "trigger",
        resourceId: result.trigger.id,
        metadata: {
          workflowId: params.id,
          type: result.trigger.type,
          name: result.trigger.name,
        },
        request,
      });
      return status(201, result.trigger);
    },
    { params: triggerListParams, body: createTriggerBody, beforeHandle: adminOnly },
  )

  .patch(
    "/:triggerId",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await triggersController.update(
        organizationId,
        params.id,
        params.triggerId,
        body,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "trigger.updated",
        resourceType: "trigger",
        resourceId: result.trigger.id,
        metadata: { workflowId: params.id, changedKeys: Object.keys(body) },
        request,
      });
      return result.trigger;
    },
    { params: triggerParams, body: updateTriggerBody, beforeHandle: adminOnly },
  )

  .delete(
    "/:triggerId",
    async ({ organizationId, user, params, status, request }) => {
      const removed = await triggersController.remove(organizationId, params.id, params.triggerId);
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "trigger.deleted",
        resourceType: "trigger",
        resourceId: params.triggerId,
        metadata: { workflowId: params.id },
        request,
      });
      return status(204, null);
    },
    { params: triggerParams, beforeHandle: adminOnly },
  )

  .post(
    "/:triggerId/rotate-token",
    async ({ organizationId, user, params, status, request }) => {
      const result = await triggersController.rotateWebhookToken(
        organizationId,
        params.id,
        params.triggerId,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });
      // Não logamos o token novo — só o evento.
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "trigger.token_rotated",
        resourceType: "trigger",
        resourceId: result.trigger.id,
        metadata: { workflowId: params.id },
        request,
      });
      return result.trigger;
    },
    { params: triggerParams, beforeHandle: adminOnly },
  );
