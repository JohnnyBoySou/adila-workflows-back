/**
 * Rotas do DB Studio — gestão de dados e DDL embutida no nó DB.
 *
 * Todas as rotas são admin-gated (`requireRole("owner","admin")`) e mutações
 * (insert/update/delete/ddl/query) são auditadas. A connection string crua
 * nunca sai daqui — só o resultado da operação.
 *
 * Prefixo: /workflows/:id/database-connections/:connectionId/studio
 */
import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { databaseConnectionsController } from "./controller";
import { databaseConnectionsRepository } from "./repository";
import { connectionParams } from "./schema";
import {
  browseBody,
  ddlBody,
  deleteRowBody,
  insertRowBody,
  runQueryBody,
  updateRowBody,
} from "./studio-schema";
import {
  browseRows,
  deleteRow,
  insertRow,
  listDatabases,
  runDdl,
  runQuery,
  StudioError,
  updateRow,
} from "./studio";

const adminOnly = requireRole("owner", "admin");

const ERROR_TO_STATUS: Record<string, number> = {
  invalid_identifier: 400,
  invalid_type: 400,
  invalid_default: 400,
  invalid_using: 400,
  invalid_fk: 400,
  invalid_fk_action: 400,
  invalid_operator: 400,
  invalid_op: 400,
  invalid_database: 400,
  invalid_connection_url: 400,
  empty_values: 400,
  empty_columns: 400,
  empty_query: 400,
  query_too_long: 400,
  missing_pk: 400,
  not_supported_for_kind: 400,
  table_not_found: 404,
  column_not_found: 404,
  row_not_found: 404,
};

function studioStatus(code: string): number {
  return ERROR_TO_STATUS[code] ?? 400;
}

/** Trunca SQL pra metadata de audit — não guardamos o payload inteiro. */
function snippet(sql: string, max = 500): string {
  return sql.length > max ? `${sql.slice(0, max)}…` : sql;
}

export const databaseStudioRouter = new Elysia({
  prefix: "/workflows/:id/database-connections/:connectionId/studio",
})
  .use(requireOrganization)

  // Resolve workflow + connection decifrada uma vez, compartilha via derive.
  .derive(async ({ organizationId, params, status }) => {
    const wf = await databaseConnectionsController.ensureWorkflow(organizationId, params.id);
    if (!wf) throw status(404, { error: "workflow_not_found" });
    const conn = await databaseConnectionsRepository.findById(params.id, params.connectionId);
    if (!conn) throw status(404, { error: "not_found" });
    return { conn };
  })

  // Lista os databases do cluster (pra o seletor de database no Studio).
  .get(
    "/databases",
    async ({ conn, status }) => {
      try {
        return await listDatabases(conn);
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, beforeHandle: adminOnly },
  )

  .post(
    "/browse",
    async ({ conn, body, status }) => {
      try {
        return await browseRows(conn, body);
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, body: browseBody, beforeHandle: adminOnly },
  )

  .post(
    "/rows",
    async ({ conn, body, organizationId, user, params, request, status }) => {
      try {
        const row = await insertRow(conn, body);
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "database_studio.row_inserted",
          resourceType: "database_connection",
          resourceId: params.connectionId,
          metadata: {
            workflowId: params.id,
            table: body.table,
            schema: body.schema ?? "public",
            database: body.database ?? null,
          },
          request,
        });
        return status(201, row);
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, body: insertRowBody, beforeHandle: adminOnly },
  )

  .patch(
    "/rows",
    async ({ conn, body, organizationId, user, params, request, status }) => {
      try {
        const row = await updateRow(conn, body);
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "database_studio.row_updated",
          resourceType: "database_connection",
          resourceId: params.connectionId,
          metadata: {
            workflowId: params.id,
            table: body.table,
            schema: body.schema ?? "public",
            database: body.database ?? null,
            columns: Object.keys(body.set),
          },
          request,
        });
        return row;
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, body: updateRowBody, beforeHandle: adminOnly },
  )

  .delete(
    "/rows",
    async ({ conn, body, organizationId, user, params, request, status }) => {
      try {
        const result = await deleteRow(conn, body);
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "database_studio.row_deleted",
          resourceType: "database_connection",
          resourceId: params.connectionId,
          metadata: {
            workflowId: params.id,
            table: body.table,
            schema: body.schema ?? "public",
            database: body.database ?? null,
          },
          request,
        });
        return result;
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, body: deleteRowBody, beforeHandle: adminOnly },
  )

  .post(
    "/ddl",
    async ({ conn, body, organizationId, user, params, request, status }) => {
      try {
        const result = await runDdl(conn, body);
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "database_studio.ddl_executed",
          resourceType: "database_connection",
          resourceId: params.connectionId,
          metadata: {
            workflowId: params.id,
            op: body.op,
            database: body.database ?? null,
            statement: snippet(result.statement),
          },
          request,
        });
        return result;
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, body: ddlBody, beforeHandle: adminOnly },
  )

  .post(
    "/query",
    async ({ conn, body, organizationId, user, params, request, status }) => {
      try {
        const result = await runQuery(conn, body.sql, body.database);
        await auditLog({
          organizationId,
          actorUserId: user.id,
          action: "database_studio.query_executed",
          resourceType: "database_connection",
          resourceId: params.connectionId,
          metadata: {
            workflowId: params.id,
            sql: snippet(body.sql),
            database: body.database ?? null,
            rowCount: result.rowCount,
          },
          request,
        });
        return result;
      } catch (err) {
        if (err instanceof StudioError)
          return status(studioStatus(err.code), { error: err.code, message: err.message });
        throw err;
      }
    },
    { params: connectionParams, body: runQueryBody, beforeHandle: adminOnly },
  );
