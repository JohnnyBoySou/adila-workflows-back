import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { environmentVariablesController } from "./controller";
import {
  createVariableBody,
  updateVariableBody,
  variableListParams,
  variableListQuery,
  variableParams,
  wfVariableListParams,
  wfVariableParams,
} from "./schema";

// Mounted como sub-rota de environments → /environments/:id/variables.
// O `:id` aqui é o id do ambiente (mantém o nome do environmentsRouter).
export const environmentVariablesRouter = new Elysia({
  prefix: "/environments/:id/variables",
})
  .use(requireOrganization)

  .get(
    "/",
    async ({ organizationId, params, query, status, role }) => {
      const env = await environmentVariablesController.ensureEnvironment(organizationId, params.id);
      if (!env) return status(404, { error: "environment_not_found" });
      // reveal=true só pra admin+; member sempre vê mascarado.
      const reveal = query.reveal === true && (role === "owner" || role === "admin");
      return environmentVariablesController.list(organizationId, params.id, null, reveal);
    },
    { params: variableListParams, query: variableListQuery },
  )

  .get(
    "/:variableId",
    async ({ organizationId, params, query, status, role }) => {
      const reveal = query.reveal === true && (role === "owner" || role === "admin");
      const variable = await environmentVariablesController.findById(
        organizationId,
        params.id,
        null,
        params.variableId,
        reveal,
      );
      if (!variable) return status(404, { error: "not_found" });
      return variable;
    },
    { params: variableParams, query: variableListQuery },
  )

  .post(
    "/",
    async ({ organizationId, user, params, body, status, request }) => {
      const env = await environmentVariablesController.ensureEnvironment(organizationId, params.id);
      if (!env) return status(404, { error: "environment_not_found" });

      const result = await environmentVariablesController.create(
        organizationId,
        params.id,
        null,
        body,
      );
      if ("error" in result) return status(409, { error: result.error });
      // Nunca logamos o `value` — só a key + flag isSecret.
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "env_variable.created",
        resourceType: "env_variable",
        resourceId: result.variable.id,
        metadata: {
          environmentId: params.id,
          key: result.variable.key,
          isSecret: result.variable.isSecret,
        },
        request,
      });
      return status(201, result.variable);
    },
    {
      params: variableListParams,
      body: createVariableBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  )

  .patch(
    "/:variableId",
    async ({ organizationId, user, params, body, status, request }) => {
      const updated = await environmentVariablesController.update(
        organizationId,
        params.id,
        null,
        params.variableId,
        body,
      );
      if (!updated) return status(404, { error: "not_found" });
      // Marcamos se o value mudou, sem registrar o valor em si.
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "env_variable.updated",
        resourceType: "env_variable",
        resourceId: updated.id,
        metadata: {
          environmentId: params.id,
          key: updated.key,
          valueChanged: body.value !== undefined,
          isSecretChanged: body.isSecret !== undefined,
        },
        request,
      });
      return updated;
    },
    {
      params: variableParams,
      body: updateVariableBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  )

  .delete(
    "/:variableId",
    async ({ organizationId, user, params, status, request }) => {
      const removed = await environmentVariablesController.remove(
        organizationId,
        params.id,
        null,
        params.variableId,
      );
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "env_variable.deleted",
        resourceType: "env_variable",
        resourceId: params.variableId,
        metadata: { environmentId: params.id },
        request,
      });
      return status(204, null);
    },
    { params: variableParams, beforeHandle: requireRole("owner", "admin") },
  );

// ── Variáveis com escopo de workflow ───────────────────────────────────
// /workflows/:id/environments/:environmentId/variables. Sobrepõem as da org
// na resolução em runtime (ver controller.resolveForRun). Mesma key pode
// existir na org e no workflow ao mesmo tempo — escopos são independentes.
// Garante que o workflow E o ambiente pertencem à org. Devolve o status de
// erro a ser retornado, ou null se ambos existem. Inline em cada handler —
// mesmo padrão do databaseConnectionsRouter.
async function guardScope(organizationId: string, workflowId: string, environmentId: string) {
  const wf = await environmentVariablesController.ensureWorkflow(organizationId, workflowId);
  if (!wf) return "workflow_not_found" as const;
  const env = await environmentVariablesController.ensureEnvironment(organizationId, environmentId);
  if (!env) return "environment_not_found" as const;
  return null;
}

export const workflowEnvironmentVariablesRouter = new Elysia({
  prefix: "/workflows/:id/environments/:environmentId/variables",
})
  .use(requireOrganization)

  .get(
    "/",
    async ({ organizationId, params, query, status, role }) => {
      const err = await guardScope(organizationId, params.id, params.environmentId);
      if (err) return status(404, { error: err });
      const reveal = query.reveal === true && (role === "owner" || role === "admin");
      return environmentVariablesController.list(
        organizationId,
        params.environmentId,
        params.id,
        reveal,
      );
    },
    { params: wfVariableListParams, query: variableListQuery },
  )

  .get(
    "/:variableId",
    async ({ organizationId, params, query, status, role }) => {
      const err = await guardScope(organizationId, params.id, params.environmentId);
      if (err) return status(404, { error: err });
      const reveal = query.reveal === true && (role === "owner" || role === "admin");
      const variable = await environmentVariablesController.findById(
        organizationId,
        params.environmentId,
        params.id,
        params.variableId,
        reveal,
      );
      if (!variable) return status(404, { error: "not_found" });
      return variable;
    },
    { params: wfVariableParams, query: variableListQuery },
  )

  .post(
    "/",
    async ({ organizationId, user, params, body, status, request }) => {
      const err = await guardScope(organizationId, params.id, params.environmentId);
      if (err) return status(404, { error: err });
      const result = await environmentVariablesController.create(
        organizationId,
        params.environmentId,
        params.id,
        body,
      );
      if ("error" in result) return status(409, { error: result.error });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "env_variable.created",
        resourceType: "env_variable",
        resourceId: result.variable.id,
        metadata: {
          workflowId: params.id,
          environmentId: params.environmentId,
          key: result.variable.key,
          isSecret: result.variable.isSecret,
        },
        request,
      });
      return status(201, result.variable);
    },
    {
      params: wfVariableListParams,
      body: createVariableBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  )

  .patch(
    "/:variableId",
    async ({ organizationId, user, params, body, status, request }) => {
      const err = await guardScope(organizationId, params.id, params.environmentId);
      if (err) return status(404, { error: err });
      const updated = await environmentVariablesController.update(
        organizationId,
        params.environmentId,
        params.id,
        params.variableId,
        body,
      );
      if (!updated) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "env_variable.updated",
        resourceType: "env_variable",
        resourceId: updated.id,
        metadata: {
          workflowId: params.id,
          environmentId: params.environmentId,
          key: updated.key,
          valueChanged: body.value !== undefined,
          isSecretChanged: body.isSecret !== undefined,
        },
        request,
      });
      return updated;
    },
    {
      params: wfVariableParams,
      body: updateVariableBody,
      beforeHandle: requireRole("owner", "admin"),
    },
  )

  .delete(
    "/:variableId",
    async ({ organizationId, user, params, status, request }) => {
      const err = await guardScope(organizationId, params.id, params.environmentId);
      if (err) return status(404, { error: err });
      const removed = await environmentVariablesController.remove(
        organizationId,
        params.environmentId,
        params.id,
        params.variableId,
      );
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "env_variable.deleted",
        resourceType: "env_variable",
        resourceId: params.variableId,
        metadata: { workflowId: params.id, environmentId: params.environmentId },
        request,
      });
      return status(204, null);
    },
    { params: wfVariableParams, beforeHandle: requireRole("owner", "admin") },
  );
