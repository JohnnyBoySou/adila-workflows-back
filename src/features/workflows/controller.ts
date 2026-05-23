import { environmentsRepository } from "../environments/repository";
import { foldersRepository } from "../folders/repository";
import { workflowRunsRepository } from "../workflow-runs/repository";
import { workflowVersionsController } from "../workflow-versions/controller";
import { workflowQueue } from "../../lib/queue";
import { importN8nWorkflow } from "./n8n-import";
import { workflowsRepository } from "./repository";
import type {
  CreateWorkflowBody,
  ImportN8nBody,
  ListWorkflowsQuery,
  UpdateWorkflowBody,
} from "./schema";

// "root" no querystring vira filtro por folderId IS NULL.
function parseFolderFilter(raw: ListWorkflowsQuery["folderId"]) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "root") return null;
  return raw;
}

export const workflowsController = {
  list(organizationId: string, query: ListWorkflowsQuery) {
    return workflowsRepository.list({
      organizationId,
      status: query.status,
      folderId: parseFolderFilter(query.folderId),
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    });
  },

  findById(organizationId: string, id: string) {
    return workflowsRepository.findById(organizationId, id);
  },

  async create(organizationId: string, userId: string, body: CreateWorkflowBody) {
    if (body.folderId) {
      const folder = await foldersRepository.findById(organizationId, body.folderId);
      if (!folder) return { error: "folder_not_found" as const };
    }
    const workflow = await workflowsRepository.create({
      organizationId,
      createdBy: userId,
      name: body.name,
      description: body.description,
      folderId: body.folderId ?? null,
      definition: body.definition ?? {},
    });
    return { workflow };
  },

  async update(organizationId: string, id: string, body: UpdateWorkflowBody) {
    if (body.folderId) {
      const folder = await foldersRepository.findById(organizationId, body.folderId);
      if (!folder) return { error: "folder_not_found" as const };
    }
    const workflow = await workflowsRepository.update(organizationId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.folderId !== undefined && { folderId: body.folderId }),
      ...(body.definition !== undefined && { definition: body.definition }),
    });
    if (!workflow) return { error: "not_found" as const };
    return { workflow };
  },

  remove(organizationId: string, id: string) {
    return workflowsRepository.remove(organizationId, id);
  },

  async importFromN8n(organizationId: string, userId: string, body: ImportN8nBody) {
    if (body.folderId) {
      const folder = await foldersRepository.findById(organizationId, body.folderId);
      if (!folder) return { error: "folder_not_found" as const };
    }
    const result = importN8nWorkflow(body.workflow);
    if ("error" in result) return { error: result.error };

    const workflow = await workflowsRepository.create({
      organizationId,
      createdBy: userId,
      name: body.name ?? result.name,
      folderId: body.folderId ?? null,
      definition: result.definition as unknown as Record<string, unknown>,
    });
    return { workflow, summary: result.summary };
  },

  async run(
    organizationId: string,
    id: string,
    triggeredBy: string | null,
    opts: { environmentId?: string | null; input?: Record<string, unknown> } = {},
  ) {
    const workflow = await workflowsRepository.findById(organizationId, id);
    if (!workflow) return { error: "not_found" as const };

    if (opts.environmentId) {
      const env = await environmentsRepository.findById(organizationId, opts.environmentId);
      if (!env) return { error: "environment_not_found" as const };
    }

    // Resolve a versão imutável que vai rodar: latest published, ou auto-publica
    // a versão 1 com o draft atual se ainda não houver nenhuma.
    const version = await workflowVersionsController.ensureLatest(
      workflow.id,
      triggeredBy,
      workflow.definition,
      workflow.createdBy,
    );

    // Cria o run primeiro (status=queued) — fica registrado mesmo se o enqueue falhar.
    const run = await workflowRunsRepository.create({
      organizationId,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      environmentId: opts.environmentId ?? null,
      status: "queued",
      input: opts.input ?? {},
      triggeredBy,
    });

    const job = await workflowQueue.add(
      "execute",
      {
        runId: run.id,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        organizationId,
        environmentId: opts.environmentId ?? null,
        input: opts.input ?? {},
      },
      { removeOnComplete: 1000, removeOnFail: 5000 },
    );

    // Guarda o jobId pra correlacionar com o BullMQ.
    if (job.id) await workflowRunsRepository.update(run.id, { jobId: job.id });

    return {
      runId: run.id,
      jobId: job.id,
      workflowId: workflow.id,
      environmentId: opts.environmentId ?? null,
    };
  },
};
