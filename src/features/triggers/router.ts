import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { workflowRuns } from "../../db/schema";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { triggersController } from "./controller";
import {
  createTriggerBody,
  promoteTriggerBody,
  triggerListParams,
  triggerListQuery,
  triggerParams,
  updateTriggerBody,
} from "./schema";

const adminOnly = requireRole("owner", "admin");

const ERROR_TO_STATUS: Record<string, number> = {
  not_found: 404,
  environment_not_found: 400,
  workflow_version_not_found: 400,
  invalid_cron: 400,
  cron_fields_on_webhook: 400,
  webhook_fields_on_cron: 400,
  not_webhook: 400,
  use_promote_endpoint: 400,
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
    "/:triggerId/promote",
    async ({ organizationId, user, params, body, status, request }) => {
      const result = await triggersController.promote(
        organizationId,
        params.id,
        params.triggerId,
        body.workflowVersionId,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        // Verbo distinto de `trigger.updated` pra dashboard de release ficar
        // limpo — quem audita uma promoção quer só essas linhas.
        action: "trigger.promoted",
        resourceType: "trigger",
        resourceId: result.trigger.id,
        metadata: {
          workflowId: params.id,
          from: result.previousWorkflowVersionId,
          to: body.workflowVersionId,
        },
        request,
      });
      return result.trigger;
    },
    { params: triggerParams, body: promoteTriggerBody, beforeHandle: adminOnly },
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
  )

  // Gera/regenera o segredo HMAC. Devolve o segredo em claro UMA vez.
  .post(
    "/:triggerId/rotate-hmac",
    async ({ organizationId, user, params, status, request }) => {
      const result = await triggersController.rotateHmacSecret(
        organizationId,
        params.id,
        params.triggerId,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "trigger.hmac_rotated",
        resourceType: "trigger",
        resourceId: result.trigger!.id,
        metadata: { workflowId: params.id },
        request,
      });
      return { trigger: result.trigger, secret: result.secret };
    },
    { params: triggerParams, beforeHandle: adminOnly },
  )

  .delete(
    "/:triggerId/hmac",
    async ({ organizationId, user, params, status, request }) => {
      const result = await triggersController.clearHmacSecret(
        organizationId,
        params.id,
        params.triggerId,
      );
      if ("error" in result) return status(statusFor(result.error), { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "trigger.hmac_cleared",
        resourceType: "trigger",
        resourceId: result.trigger!.id,
        metadata: { workflowId: params.id },
        request,
      });
      return result.trigger;
    },
    { params: triggerParams, beforeHandle: adminOnly },
  )

  // Histórico recente de runs disparados por este trigger.
  .get(
    "/:triggerId/invocations",
    async ({ organizationId, params, query }) => {
      const limit = query.limit ?? 25;
      const rows = await db
        .select({
          id: workflowRuns.id,
          status: workflowRuns.status,
          input: workflowRuns.input,
          output: workflowRuns.output,
          error: workflowRuns.error,
          startedAt: workflowRuns.startedAt,
          finishedAt: workflowRuns.finishedAt,
          createdAt: workflowRuns.createdAt,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.workflowId, params.id),
            eq(workflowRuns.triggerId, params.triggerId),
          ),
        )
        .orderBy(desc(workflowRuns.createdAt))
        .limit(limit);
      return rows;
    },
    {
      params: triggerParams,
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 25 })),
      }),
    },
  )

  // Métricas de saúde do trigger nas últimas 24h: taxa de sucesso + p95.
  .get(
    "/:triggerId/health",
    async ({ organizationId, params }) => {
      const since = new Date(Date.now() - 24 * 60 * 60_000);
      const [agg] = await db
        .select({
          total: sql<number>`count(*)::int`,
          success: sql<number>`sum(case when ${workflowRuns.status} = 'success' then 1 else 0 end)::int`,
          failed: sql<number>`sum(case when ${workflowRuns.status} = 'failed' then 1 else 0 end)::int`,
          avgMs: sql<number>`coalesce(avg(extract(epoch from (${workflowRuns.finishedAt} - ${workflowRuns.startedAt})) * 1000)::int, 0)`,
          p95Ms: sql<number>`coalesce(percentile_cont(0.95) within group (order by extract(epoch from (${workflowRuns.finishedAt} - ${workflowRuns.startedAt})) * 1000)::int, 0)`,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.workflowId, params.id),
            eq(workflowRuns.triggerId, params.triggerId),
            gte(workflowRuns.createdAt, since),
          ),
        );

      // Série por hora pra sparkline (24 buckets).
      const series = await db
        .select({
          bucket: sql<string>`date_trunc('hour', ${workflowRuns.createdAt})::text`,
          total: sql<number>`count(*)::int`,
          failed: sql<number>`sum(case when ${workflowRuns.status} = 'failed' then 1 else 0 end)::int`,
        })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.workflowId, params.id),
            eq(workflowRuns.triggerId, params.triggerId),
            gte(workflowRuns.createdAt, since),
          ),
        )
        .groupBy(sql`date_trunc('hour', ${workflowRuns.createdAt})`)
        .orderBy(sql`date_trunc('hour', ${workflowRuns.createdAt})`);

      return {
        windowHours: 24,
        total: agg?.total ?? 0,
        success: agg?.success ?? 0,
        failed: agg?.failed ?? 0,
        successRate: agg && agg.total > 0 ? agg.success / agg.total : null,
        avgMs: agg?.avgMs ?? 0,
        p95Ms: agg?.p95Ms ?? 0,
        series,
      };
    },
    { params: triggerParams },
  );
