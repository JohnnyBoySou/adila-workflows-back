import { t } from "elysia";

export const listAuditLogsQuery = t.Object({
  action: t.Optional(t.String({ maxLength: 100 })),
  resourceType: t.Optional(t.String({ maxLength: 50 })),
  resourceId: t.Optional(t.String({ maxLength: 100 })),
  actorUserId: t.Optional(t.String({ maxLength: 100 })),
  limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200, default: 50 })),
  offset: t.Optional(t.Numeric({ minimum: 0, default: 0 })),
});

export type ListAuditLogsQuery = typeof listAuditLogsQuery.static;
