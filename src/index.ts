import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { env } from "./config/env";
import { aiRouter } from "./features/ai/router";
import { auditLogsRouter } from "./features/audit-logs/router";
import { commentsRouter } from "./features/comments/router";
import { copilotRouter } from "./features/copilot/router";
import { databaseConnectionsRouter } from "./features/database-connections/router";
import { databaseStudioRouter } from "./features/database-connections/studio-router";
import {
  environmentVariablesRouter,
  workflowEnvironmentVariablesRouter,
} from "./features/environment-variables/router";
import { environmentsRouter } from "./features/environments/router";
import { foldersRouter } from "./features/folders/router";
import { healthRouter } from "./features/health/router";
import { stripeWebhookRouter, templatesRouter } from "./features/templates/router";
import { triggersRouter } from "./features/triggers/router";
import { webhookRouter } from "./features/triggers/webhook-router";
import { workflowRunsRouter } from "./features/workflow-runs/router";
import { workflowVersionsRouter } from "./features/workflow-versions/router";
import { workflowNodesRouter } from "./features/workflows/nodes-router";
import { workflowsRouter } from "./features/workflows/router";
import { httpLogger } from "./lib/http-logger";
import { logger } from "./lib/logger";

const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = new Elysia()
  // CORS antes de tudo — precisa de credentials:true pra cookie de sessão viajar.
  .use(
    cors({
      origin: corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
    }),
  )
  .use(httpLogger)
  // OpenAPI auto-gerado a partir dos schemas TypeBox de cada rota.
  // /docs (Scalar UI) e /docs/json (raw OpenAPI). Em produção, restrinja se preciso.
  .use(
    swagger({
      path: "/docs",
      documentation: {
        info: {
          title: "Adila Workflows API",
          version: "0.1.0",
          description: "Backend de orquestração de workflows (Bun + Elysia + Drizzle + BullMQ).",
        },
        tags: [
          { name: "workflows", description: "CRUD e execução de workflows" },
          { name: "runs", description: "Histórico, cancelamento e rerun de execuções" },
          { name: "triggers", description: "Cron e webhook" },
          { name: "environments", description: "Ambientes e variáveis" },
          { name: "health", description: "Liveness e readiness" },
        ],
      },
    }),
  )
  // Auth é federada no Identity (identity.adila.co): o back valida o JWT via
  // JWKS (ver src/lib/identity-auth.ts + auth-middleware.ts). Não há provedor
  // de identidade local — nenhuma rota /api/auth/* aqui.
  .get("/", () => "Hello Elysia")
  .use(healthRouter)
  .use(foldersRouter)
  .use(environmentsRouter)
  .use(environmentVariablesRouter)
  .use(workflowEnvironmentVariablesRouter)
  .use(workflowsRouter)
  .use(workflowVersionsRouter)
  .use(workflowRunsRouter)
  .use(workflowNodesRouter)
  .use(triggersRouter)
  .use(commentsRouter)
  .use(databaseConnectionsRouter)
  .use(databaseStudioRouter)
  .use(auditLogsRouter)
  .use(aiRouter)
  .use(copilotRouter)
  .use(templatesRouter)
  // Webhook é público (sem requireOrganization) — fica mountado na raiz.
  .use(webhookRouter)
  // Webhook do Stripe — público, raw body para verificar assinatura.
  .use(stripeWebhookRouter)
  .listen(env.PORT);

logger.info({ host: app.server?.hostname, port: app.server?.port }, "Elysia running");
