import { and, desc, eq } from "drizzle-orm";
import { Elysia, t } from "elysia";
import { db } from "../../db";
import { workflowRuns, workflowRunSteps } from "../../db/schema";
import { requireOrganization } from "../../lib/auth-middleware";
import { httpRequestHandler } from "../../lib/engine/nodes/http-request";
import { s3Handler } from "../../lib/engine/nodes/s3";
import { vectorStoreHandler } from "../../lib/engine/nodes/vector-store";
import { environmentVariablesRepository } from "../environment-variables/repository";
import { workflowsController } from "./controller";

/**
 * Carrega as env vars decriptadas de um environment. Devolve `{}` quando
 * `environmentId` é null/undefined ou não pertence à org. Usado por dry-runs
 * pra que `{{env.X}}` resolva igual em runs reais.
 */
async function loadEnv(
  organizationId: string,
  environmentId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!environmentId) return {};
  const rows = await environmentVariablesRepository.list(organizationId, environmentId);
  const env: Record<string, string> = {};
  for (const v of rows) env[v.key] = v.value;
  return env;
}

/**
 * Endpoints utilitários por-node de um workflow.
 *
 *   GET  /workflows/:id/nodes/:nodeId/invocations?limit=25
 *     → últimos workflow_run_steps deste node, ordenados por created_at desc.
 *       Usado pela aba "Histórico" do painel http_request (e pode servir a
 *       outros painéis dedicados no futuro).
 *
 *   POST /workflows/:id/nodes/:nodeId/dry-run
 *     → executa o handler de `http_request` com a config recebida no body,
 *       sem persistir step nem incrementar contadores. Permite testar a
 *       requisição direto do painel, contornando CORS do browser.
 *
 *       NOTE: env vars do environment NÃO são injetadas — o template engine
 *       roda com env vazio. Para resolver `{{env.X}}` o usuário precisa
 *       disparar um run real. Mantemos simples por enquanto.
 */
export const workflowNodesRouter = new Elysia({ prefix: "/workflows/:id/nodes/:nodeId" })
  .use(requireOrganization)

  .get(
    "/invocations",
    async ({ organizationId, params, query }) => {
      const limit = query.limit ?? 25;
      const rows = await db
        .select({
          id: workflowRunSteps.id,
          runId: workflowRunSteps.runId,
          status: workflowRunSteps.status,
          input: workflowRunSteps.input,
          output: workflowRunSteps.output,
          error: workflowRunSteps.error,
          startedAt: workflowRunSteps.startedAt,
          finishedAt: workflowRunSteps.finishedAt,
          durationMs: workflowRunSteps.durationMs,
          createdAt: workflowRunSteps.createdAt,
        })
        .from(workflowRunSteps)
        .innerJoin(workflowRuns, eq(workflowRunSteps.runId, workflowRuns.id))
        .where(
          and(
            eq(workflowRuns.organizationId, organizationId),
            eq(workflowRuns.workflowId, params.id),
            eq(workflowRunSteps.nodeId, params.nodeId),
          ),
        )
        .orderBy(desc(workflowRunSteps.createdAt))
        .limit(limit);
      return rows;
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
        nodeId: t.String({ minLength: 1, maxLength: 128 }),
      }),
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 25 })),
      }),
    },
  )

  .post(
    "/dry-run-http",
    async ({ organizationId, params, body, status }) => {
      // Garante que o workflow pertence à org (defense-in-depth — auth middleware
      // já filtra, mas evita um proxy aberto de http_request).
      const workflow = await workflowsController.findById(organizationId, params.id);
      if (!workflow) return status(404, { error: "workflow_not_found" });

      const startedAt = Date.now();
      try {
        const result = await httpRequestHandler({
          node: {
            id: params.nodeId,
            type: "http_request",
            config: body.config,
          },
          context: {
            input: body.input ?? {},
            vars: {},
            env: {},
            steps: {},
          },
        });
        return {
          ok: true as const,
          output: result.output,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: (err as Error).message,
          durationMs: Date.now() - startedAt,
        };
      }
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
        nodeId: t.String({ minLength: 1, maxLength: 128 }),
      }),
      body: t.Object({
        config: t.Record(t.String(), t.Unknown()),
        input: t.Optional(t.Record(t.String(), t.Unknown())),
      }),
    },
  )

  // Dry-run do `s3` — resolve env vars do environment (precisa pra credenciais).
  .post(
    "/dry-run-s3",
    async ({ organizationId, params, body, status }) => {
      const workflow = await workflowsController.findById(organizationId, params.id);
      if (!workflow) return status(404, { error: "workflow_not_found" });

      const env = await loadEnv(organizationId, body.environmentId);
      const startedAt = Date.now();
      try {
        const result = await s3Handler({
          node: { id: params.nodeId, type: "s3", config: body.config },
          context: {
            input: body.input ?? {},
            vars: {},
            env,
            steps: {},
          },
        });
        return {
          ok: true as const,
          output: result.output,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: (err as Error).message,
          durationMs: Date.now() - startedAt,
        };
      }
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
        nodeId: t.String({ minLength: 1, maxLength: 128 }),
      }),
      body: t.Object({
        config: t.Record(t.String(), t.Unknown()),
        input: t.Optional(t.Record(t.String(), t.Unknown())),
        environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
      }),
    },
  )

  // Dry-run do `vector_store` — também precisa do env pra resolver
  // `{{env.DATABASE_VECTOR_STORE_URL}}` na connectionString.
  .post(
    "/dry-run-vector",
    async ({ organizationId, params, body, status }) => {
      const workflow = await workflowsController.findById(organizationId, params.id);
      if (!workflow) return status(404, { error: "workflow_not_found" });

      const env = await loadEnv(organizationId, body.environmentId);
      const startedAt = Date.now();
      try {
        const result = await vectorStoreHandler({
          node: { id: params.nodeId, type: "vector_store", config: body.config },
          context: {
            input: body.input ?? {},
            vars: {},
            env,
            steps: {},
          },
        });
        return {
          ok: true as const,
          output: result.output,
          durationMs: Date.now() - startedAt,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: (err as Error).message,
          durationMs: Date.now() - startedAt,
        };
      }
    },
    {
      params: t.Object({
        id: t.String({ format: "uuid" }),
        nodeId: t.String({ minLength: 1, maxLength: 128 }),
      }),
      body: t.Object({
        config: t.Record(t.String(), t.Unknown()),
        input: t.Optional(t.Record(t.String(), t.Unknown())),
        environmentId: t.Optional(t.Union([t.String({ format: "uuid" }), t.Null()])),
      }),
    },
  );
