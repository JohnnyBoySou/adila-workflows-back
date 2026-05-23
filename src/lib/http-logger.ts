/**
 * Plugin Elysia que loga toda requisição (método, path, status, duração).
 *
 * Anexa um `requestId` (curtinho) e disponibiliza `log` no contexto pra
 * handlers que queiram emitir logs com o mesmo correlation id.
 *
 * Logs em /health são silenciados (ruído de health-check).
 */
import { Elysia } from "elysia";
import { randomBytes } from "node:crypto";
import { logger } from "./logger";

const SILENCED_PATHS = new Set(["/health"]);

function shortId() {
  return randomBytes(6).toString("base64url");
}

export const httpLogger = new Elysia({ name: "http-logger" })
  .derive({ as: "scoped" }, ({ request }) => {
    const url = new URL(request.url);
    const requestId = request.headers.get("x-request-id") ?? shortId();
    const log = logger.child({
      requestId,
      method: request.method,
      path: url.pathname,
    });
    return { log, requestId, _startedAt: performance.now() };
  })
  .onAfterHandle({ as: "scoped" }, ({ log, _startedAt, request, set }) => {
    const url = new URL(request.url);
    if (SILENCED_PATHS.has(url.pathname)) return;
    const durationMs = Math.round(performance.now() - _startedAt);
    log.info({ status: set.status ?? 200, durationMs }, "request");
  })
  .onError({ as: "scoped" }, ({ log, _startedAt, request, error, set }) => {
    const url = new URL(request.url);
    const startedAt = _startedAt ?? performance.now();
    const durationMs = Math.round(performance.now() - startedAt);
    const status = set.status ?? 500;
    const childLog = log ?? logger.child({ method: request.method, path: url.pathname });
    childLog.error({ status, durationMs, err: error, path: url.pathname }, "request failed");
  });
