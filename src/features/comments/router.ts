import { Elysia } from "elysia";
import { requireOrganization } from "../../lib/auth-middleware";
import { commentsController } from "./controller";
import {
  commentParams,
  createCommentBody,
  updateCommentBody,
  workflowIdParams,
} from "./schema";

const ERROR_TO_STATUS: Record<string, number> = {
  not_found: 404,
  parent_not_found: 404,
  forbidden: 403,
  root_requires_coords: 400,
  no_nested_replies: 400,
};

function statusFor(err: string): number {
  return ERROR_TO_STATUS[err] ?? 400;
}

export const commentsRouter = new Elysia({ prefix: "/workflows/:id/comments" })
  .use(requireOrganization)

  .get("/", ({ organizationId, params }) => commentsController.list(organizationId, params.id), {
    params: workflowIdParams,
  })

  .post(
    "/",
    async ({ organizationId, user, params, body, status }) => {
      const result = await commentsController.create(organizationId, params.id, user.id, body);
      if ("error" in result) return status(statusFor(result.error), result);
      return result;
    },
    { params: workflowIdParams, body: createCommentBody },
  )

  .patch(
    "/:commentId",
    async ({ organizationId, user, params, body, status }) => {
      const result = await commentsController.update(
        organizationId,
        params.id,
        params.commentId,
        user.id,
        body,
      );
      if ("error" in result) return status(statusFor(result.error), result);
      return result;
    },
    { params: commentParams, body: updateCommentBody },
  )

  .delete(
    "/:commentId",
    async ({ organizationId, user, role, params, status }) => {
      const isAdmin = role === "owner" || role === "admin";
      const result = await commentsController.delete(
        organizationId,
        params.id,
        params.commentId,
        user.id,
        isAdmin,
      );
      if ("error" in result) return status(statusFor(result.error), result);
      return result;
    },
    { params: commentParams },
  );
