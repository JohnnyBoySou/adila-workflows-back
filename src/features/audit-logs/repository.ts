import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { user } from "../../db/auth-schema";
import { auditLogs, type NewAuditLog } from "../../db/schema";

export interface ListAuditLogsFilters {
  organizationId: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  /** Filtra por `metadata->>'workflowId'`. Ver schema.ts pro porquê. */
  workflowId?: string;
  actorUserId?: string;
  limit: number;
  offset: number;
}

export const auditLogsRepository = {
  async list({
    organizationId,
    action,
    resourceType,
    resourceId,
    actorUserId,
    workflowId,
    limit,
    offset,
  }: ListAuditLogsFilters) {
    const conditions = [eq(auditLogs.organizationId, organizationId)];
    if (action) conditions.push(eq(auditLogs.action, action));
    if (resourceType) conditions.push(eq(auditLogs.resourceType, resourceType));
    if (resourceId) conditions.push(eq(auditLogs.resourceId, resourceId));
    if (actorUserId) conditions.push(eq(auditLogs.actorUserId, actorUserId));
    if (workflowId) {
      // "Tudo que mexeu no fluxo" = eventos do próprio workflow (resourceId) +
      // eventos de recursos ligados que carregam `metadata.workflowId`
      // (trigger.*, workflow_version.*, env_variable.*, database_connection.*).
      // Sem o primeiro OR, workflow.created/updated/deleted/ran ficariam de fora,
      // pois gravam resourceId=workflowId mas não metadata.workflowId.
      conditions.push(
        sql`((${auditLogs.resourceType} = 'workflow' AND ${auditLogs.resourceId} = ${workflowId}) OR ${auditLogs.metadata}->>'workflowId' = ${workflowId})`,
      );
    }

    // LEFT JOIN no `user` pra resolver quem fez a ação — a UI mostra nome/email
    // em vez do id cru. LEFT (não INNER) porque actorUserId pode ser NULL
    // (ações do sistema: cron, webhook) ou o user ter sido removido.
    return db
      .select({
        id: auditLogs.id,
        organizationId: auditLogs.organizationId,
        actorUserId: auditLogs.actorUserId,
        actorName: user.name,
        actorEmail: user.email,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        metadata: auditLogs.metadata,
        ipAddress: auditLogs.ipAddress,
        userAgent: auditLogs.userAgent,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(user, eq(auditLogs.actorUserId, user.id))
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);
  },

  insert(data: NewAuditLog) {
    return db.insert(auditLogs).values(data);
  },
};
