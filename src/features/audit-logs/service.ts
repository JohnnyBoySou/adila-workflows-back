/**
 * Helper público pra registrar eventos no audit log.
 *
 * Best-effort: falha de escrita NÃO propaga — só loga. O endpoint que
 * chama segue normalmente. Logar é importante, mas não pode quebrar
 * a feature principal.
 *
 * Uso típico (depois de uma mutação bem-sucedida):
 *
 *   await auditLog({
 *     organizationId, actorUserId: user.id, action: "workflow.created",
 *     resourceType: "workflow", resourceId: created.id, request,
 *     metadata: { name: created.name },
 *   });
 */
import { logger } from "../../lib/logger";
import { auditLogsRepository } from "./repository";

const auditLog_ = logger.child({ component: "audit-log" });

export interface AuditLogInput {
  organizationId: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  /** Passe o `request` do Elysia pra extrairmos IP/UA automaticamente. */
  request?: Request;
}

function ipFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return headers.get("x-real-ip");
}

export async function auditLog(input: AuditLogInput) {
  try {
    await auditLogsRepository.insert({
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      metadata: input.metadata ?? {},
      ipAddress: input.request ? ipFromHeaders(input.request.headers) : null,
      userAgent: input.request?.headers.get("user-agent") ?? null,
    });
  } catch (err) {
    // Best-effort: não derruba o request. Loga e segue.
    auditLog_.error(
      { err, action: input.action, resourceType: input.resourceType },
      "failed to write audit log",
    );
  }
}
