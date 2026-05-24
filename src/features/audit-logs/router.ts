import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLogsRepository } from "./repository";
import { listAuditLogsQuery } from "./schema";

// Audit é informação sensível (quem fez o quê) — só admin+.
const adminOnly = requireRole("owner", "admin");

export const auditLogsRouter = new Elysia({ prefix: "/audit-logs" })
  .use(requireOrganization)

  .get(
    "/",
    ({ organizationId, query }) =>
      auditLogsRepository.list({
        organizationId,
        action: query.action,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        workflowId: query.workflowId,
        actorUserId: query.actorUserId,
        limit: query.limit ?? 50,
        offset: query.offset ?? 0,
      }),
    { query: listAuditLogsQuery, beforeHandle: adminOnly },
  );
