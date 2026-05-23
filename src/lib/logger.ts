/**
 * Logger estruturado (pino).
 *
 * Em dev: pretty-print legível.
 * Em prod/test: JSON puro — ideal pra ingestion (Logtail, Datadog, etc).
 *
 * Padrão de uso:
 *   import { logger } from "../lib/logger";
 *   const log = logger.child({ runId, workflowId });
 *   log.info("started");
 *   log.error({ err }, "failed");
 */
import { pino } from "pino";
import { env } from "../config/env";

const isDev = env.NODE_ENV === "development";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "workflows-back" },
  // Em dev, transport pino-pretty pra saída legível.
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname,service",
        },
      }
    : undefined,
});

export type Logger = typeof logger;
