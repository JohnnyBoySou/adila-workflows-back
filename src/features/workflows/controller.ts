import { environmentsRepository } from "../environments/repository";
import { foldersRepository } from "../folders/repository";
import { workflowRunsRepository } from "../workflow-runs/repository";
import { workflowVersionsController } from "../workflow-versions/controller";
import { workflowVersionsRepository } from "../workflow-versions/repository";
import { pickLaneForDefinition, workflowQueues } from "../../lib/queue";
import { summarizeWorkflowChanges } from "./audit-changes";
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
      q: query.q,
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
    // Snapshot antes do update pra o audit log saber exatamente o que mudou.
    const before = await workflowsRepository.findById(organizationId, id);
    if (!before) return { error: "not_found" as const };

    const workflow = await workflowsRepository.update(organizationId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.status !== undefined && { status: body.status }),
      ...(body.folderId !== undefined && { folderId: body.folderId }),
      ...(body.definition !== undefined && { definition: body.definition }),
    });
    if (!workflow) return { error: "not_found" as const };

    const changes = summarizeWorkflowChanges(before, workflow, body);
    return { workflow, changes };
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
    opts: {
      environmentId?: string | null;
      input?: Record<string, unknown>;
      /** Outputs pinados pelo editor — pulam o handler do nó correspondente. */
      pinnedData?: Record<string, Record<string, unknown>>;
      /**
       * Modo debug "play até aqui" — engine para após executar este nó e
       * devolve o output dele. Combinado com `pinnedData`, permite iterar
       * só no nó alvo sem disparar os upstream (APIs, IA, DB).
       */
      stopAtNodeId?: string;
      /**
       * Versão pinada (ex.: vinda de `triggers.workflowVersionId`). Quando
       * setado, ignora ensureLatest e dispara exatamente este snapshot. Erra
       * se a versão não existir ou pertencer a outro workflow.
       */
      workflowVersionId?: string | null;
      queuePriority?: number;
      /** Trigger que está disparando este run (webhook/cron/etc). */
      triggerId?: string | null;
    } = {},
  ) {
    const workflow = await workflowsRepository.findById(organizationId, id);
    if (!workflow) return { error: "not_found" as const };

    if (opts.environmentId) {
      const env = await environmentsRepository.findById(organizationId, opts.environmentId);
      if (!env) return { error: "environment_not_found" as const };
    }

    // Resolve a versão imutável que vai rodar:
    //  - opts.workflowVersionId setado → busca direto (modo "pinned by trigger")
    //  - senão → latest published, ou auto-publica a v1 com o draft atual
    //
    // IMPORTANTE: sem `opts.workflowVersionId` e sem promote prévio do trigger,
    // `ensureLatest` devolve a ÚLTIMA versão publicada — NÃO o draft atual.
    // Se o usuário editou o workflow depois de publicar v3 e dispara via
    // cron/webhook sem trigger pinado, roda v3 — não as edições. Esse é o
    // contrato: dispatch automático = sempre versão imutável. Edições não
    // publicadas só disparam via "test run" no editor (caminho separado).
    let version: { id: string };
    if (opts.workflowVersionId) {
      const pinned = await workflowVersionsRepository.findByIdRaw(opts.workflowVersionId);
      if (!pinned || pinned.workflowId !== workflow.id) {
        return { error: "workflow_version_not_found" as const };
      }
      version = pinned;
    } else {
      version = await workflowVersionsController.ensureLatest(
        workflow.id,
        triggeredBy,
        workflow.definition,
        workflow.createdBy,
      );
    }

    // Cria o run primeiro (status=queued) — fica registrado mesmo se o enqueue falhar.
    const run = await workflowRunsRepository.create({
      organizationId,
      workflowId: workflow.id,
      workflowVersionId: version.id,
      environmentId: opts.environmentId ?? null,
      status: "queued",
      input: opts.input ?? {},
      triggeredBy,
      triggerId: opts.triggerId ?? null,
      queuePriority: opts.queuePriority ?? 5,
    });

    // Roteia o run para a lane apropriada (default/heavy/scraping) baseado
    // nos node-types do grafo. Permite que workers externos (ex.: Go) consumam
    // lanes específicas sem que o caller precise saber disso.
    const lane = pickLaneForDefinition(workflow.definition);
    const targetQueue = workflowQueues[lane];
    const job = await targetQueue.add(
      "execute",
      {
        runId: run.id,
        workflowId: workflow.id,
        workflowVersionId: version.id,
        organizationId,
        environmentId: opts.environmentId ?? null,
        input: opts.input ?? {},
        // Pinned data não persistimos no run — é por-disparo. Vai direto pro
        // job e some quando o BullMQ limpa.
        pinnedData: opts.pinnedData ?? {},
        ...(opts.stopAtNodeId && { stopAtNodeId: opts.stopAtNodeId }),
      },
      {
        priority: opts.queuePriority ?? 5,
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    );

    // Guarda o jobId pra correlacionar com o BullMQ.
    if (job.id) await workflowRunsRepository.update(run.id, { jobId: job.id });

    return {
      runId: run.id,
      jobId: job.id,
      workflowId: workflow.id,
      environmentId: opts.environmentId ?? null,
      queuePriority: opts.queuePriority ?? 5,
    };
  },
};
