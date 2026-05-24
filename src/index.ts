import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { env } from "./config/env";
import { aiRouter } from "./features/ai/router";
import { auditLogsRouter } from "./features/audit-logs/router";
import { databaseConnectionsRouter } from "./features/database-connections/router";
import { environmentVariablesRouter } from "./features/environment-variables/router";
import { environmentsRouter } from "./features/environments/router";
import { foldersRouter } from "./features/folders/router";
import { healthRouter } from "./features/health/router";
import { triggersRouter } from "./features/triggers/router";
import { webhookRouter } from "./features/triggers/webhook-router";
import { workflowRunsRouter } from "./features/workflow-runs/router";
import { workflowVersionsRouter } from "./features/workflow-versions/router";
import { workflowNodesRouter } from "./features/workflows/nodes-router";
import { workflowsRouter } from "./features/workflows/router";
import { auth } from "./lib/auth";
import { httpLogger } from "./lib/http-logger";
import { logger } from "./lib/logger";
import { rateLimit } from "./lib/rate-limit";

const corsOrigins = env.CORS_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Endpoints de auth com brute-force óbvio — limitamos por IP.
const AUTH_RATE_LIMITED_PATHS = new Set(["/api/auth/sign-up/email", "/api/auth/sign-in/email"]);

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
  // Better Auth expõe todas as rotas em /api/auth/* — repassamos o Request nativo.
  .all("/api/auth/*", async ({ request, server, status, set }) => {
    const url = new URL(request.url);
    if (AUTH_RATE_LIMITED_PATHS.has(url.pathname)) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        server?.requestIP(request)?.address ||
        "unknown";
      const limit = await rateLimit({
        key: `auth:${url.pathname}:${ip}`,
        limit: 10,
        windowSeconds: 60,
      });
      if (!limit.allowed) {
        set.headers["Retry-After"] = String(limit.resetIn);
        return status(429, { error: "rate_limited" });
      }
    }
    return auth.handler(request);
  })
  .get("/", () => "Hello Elysia")
  .use(healthRouter)
  .use(foldersRouter)
  .use(environmentsRouter)
  .use(environmentVariablesRouter)
  .use(workflowsRouter)
  .use(workflowVersionsRouter)
  .use(workflowRunsRouter)
  .use(workflowNodesRouter)
  .use(triggersRouter)
  .use(databaseConnectionsRouter)
  .use(auditLogsRouter)
  .use(aiRouter)
  // Webhook é público (sem requireOrganization) — fica mountado na raiz.
  .use(webhookRouter)
  .listen(env.PORT);

logger.info({ host: app.server?.hostname, port: app.server?.port }, "Elysia running");
