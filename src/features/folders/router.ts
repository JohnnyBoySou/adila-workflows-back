import { Elysia } from "elysia";
import { requireOrganization, requireRole } from "../../lib/auth-middleware";
import { auditLog } from "../audit-logs/service";
import { foldersController } from "./controller";
import { createFolderBody, folderIdParam, listFoldersQuery, updateFolderBody } from "./schema";

// Mutações de folders exigem admin+; leitura é aberta a qualquer member.
const adminOnly = requireRole("owner", "admin");

export const foldersRouter = new Elysia({ prefix: "/folders" })
  .use(requireOrganization)

  .get("/", ({ organizationId, query }) => foldersController.list(organizationId, query), {
    query: listFoldersQuery,
  })

  .get(
    "/:id",
    async ({ organizationId, params, status }) => {
      const folder = await foldersController.findById(organizationId, params.id);
      if (!folder) return status(404, { error: "not_found" });
      return folder;
    },
    { params: folderIdParam },
  )

  .post(
    "/",
    async ({ organizationId, user, body, status, request }) => {
      const folder = await foldersController.create(organizationId, user.id, body);
      if (!folder) return status(400, { error: "invalid_parent" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "folder.created",
        resourceType: "folder",
        resourceId: folder.id,
        metadata: { name: folder.name, parentId: folder.parentId },
        request,
      });
      return status(201, folder);
    },
    { body: createFolderBody, beforeHandle: adminOnly },
  )

  .patch(
    "/:id",
    async ({ organizationId, user, params, body, status, request }) => {
      const updated = await foldersController.update(organizationId, params.id, body);
      if (!updated) return status(404, { error: "not_found_or_invalid_parent" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "folder.updated",
        resourceType: "folder",
        resourceId: updated.id,
        metadata: { patch: body },
        request,
      });
      return updated;
    },
    { params: folderIdParam, body: updateFolderBody, beforeHandle: adminOnly },
  )

  .delete(
    "/:id",
    async ({ organizationId, user, params, status, request }) => {
      const removed = await foldersController.remove(organizationId, params.id);
      if (!removed) return status(404, { error: "not_found" });
      await auditLog({
        organizationId,
        actorUserId: user.id,
        action: "folder.deleted",
        resourceType: "folder",
        resourceId: params.id,
        request,
      });
      return status(204, null);
    },
    { params: folderIdParam, beforeHandle: adminOnly },
  );
