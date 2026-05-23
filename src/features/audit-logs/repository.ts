import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db";
import { auditLogs, type NewAuditLog } from "../../db/schema";

export interface ListAuditLogsFilters {
  organizationId: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
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
    limit,
    offset,
  }: ListAuditLogsFilters) {
    const conditions = [eq(auditLogs.organizationId, organizationId)];
    if (action) conditions.push(eq(auditLogs.action, action));
    if (resourceType) conditions.push(eq(auditLogs.resourceType, resourceType));
    if (resourceId) conditions.push(eq(auditLogs.resourceId, resourceId));
    if (actorUserId) conditions.push(eq(auditLogs.actorUserId, actorUserId));

    return db
      .select()
      .from(auditLogs)
      .where(and(...conditions))
      .orderBy(desc(auditLogs.createdAt))
      .limit(limit)
      .offset(offset);
  },

  insert(data: NewAuditLog) {
    return db.insert(auditLogs).values(data);
  },
};
