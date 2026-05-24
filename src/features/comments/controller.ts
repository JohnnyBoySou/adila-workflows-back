import type { CommentBroadcast } from "../../lib/collab";
import { publishToRoom } from "../../lib/collab-publisher";
import type { WorkflowComment } from "../../db/schema";
import { commentsRepository } from "./repository";

function toBroadcast(c: WorkflowComment): CommentBroadcast {
  return {
    id: c.id,
    organizationId: c.organizationId,
    workflowId: c.workflowId,
    parentId: c.parentId,
    authorId: c.authorId,
    body: c.body,
    mentions: c.mentions,
    x: c.x,
    y: c.y,
    resolved: c.resolved,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export const commentsController = {
  list(organizationId: string, workflowId: string) {
    return commentsRepository.listByWorkflow(organizationId, workflowId);
  },

  findById(organizationId: string, workflowId: string, id: string) {
    return commentsRepository.findById(organizationId, workflowId, id);
  },

  async create(
    organizationId: string,
    workflowId: string,
    authorId: string,
    input: {
      body: string;
      mentions?: string[];
      x?: number;
      y?: number;
      parentId?: string;
    },
  ): Promise<{ error: string } | WorkflowComment> {
    // Validação: raiz precisa de x/y; reply precisa de parentId e ignora x/y.
    const isReply = Boolean(input.parentId);
    if (!isReply && (typeof input.x !== "number" || typeof input.y !== "number")) {
      return { error: "root_requires_coords" };
    }
    if (isReply) {
      const parent = await commentsRepository.findById(
        organizationId,
        workflowId,
        input.parentId!,
      );
      if (!parent) return { error: "parent_not_found" };
      if (parent.parentId !== null) return { error: "no_nested_replies" };
    }

    const created = await commentsRepository.create({
      organizationId,
      workflowId,
      parentId: input.parentId ?? null,
      authorId,
      body: input.body,
      mentions: input.mentions ?? [],
      x: isReply ? null : input.x!,
      y: isReply ? null : input.y!,
    });

    await publishToRoom({
      type: "comment.created",
      workflowId,
      comment: toBroadcast(created),
    });

    return created;
  },

  async update(
    organizationId: string,
    workflowId: string,
    id: string,
    authorId: string,
    patch: { body?: string; mentions?: string[]; resolved?: boolean },
  ): Promise<{ error: string } | WorkflowComment> {
    const existing = await commentsRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" };
    // Autor pode editar texto/menções; qualquer um pode resolver/reabrir.
    const wantsTextChange = patch.body !== undefined || patch.mentions !== undefined;
    if (wantsTextChange && existing.authorId !== authorId) {
      return { error: "forbidden" };
    }
    const updated = await commentsRepository.updateBody(id, patch);
    if (!updated) return { error: "not_found" };
    await publishToRoom({
      type: "comment.updated",
      workflowId,
      comment: toBroadcast(updated),
    });
    return updated;
  },

  async delete(
    organizationId: string,
    workflowId: string,
    id: string,
    authorId: string,
    isAdmin: boolean,
  ): Promise<{ error: string } | { ok: true }> {
    const existing = await commentsRepository.findById(organizationId, workflowId, id);
    if (!existing) return { error: "not_found" };
    if (existing.authorId !== authorId && !isAdmin) return { error: "forbidden" };
    await commentsRepository.delete(id);
    await publishToRoom({ type: "comment.deleted", workflowId, commentId: id });
    return { ok: true };
  },
};
