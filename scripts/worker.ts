/**
 * Worker BullMQ — processa jobs das filas `workflows` e `cron-scheduler`.
 *
 * Roda como processo separado: `bun run worker` (ver package.json).
 * Em produção, escale com várias instâncias — BullMQ distribui via Redis.
 */
import { UnrecoverableError, type Job } from "bullmq";
import { databaseConnectionsRepository } from "../src/features/database-connections/repository";
import { environmentVariablesController } from "../src/features/environment-variables/controller";
import { triggersRepository } from "../src/features/triggers/repository";
import {
  resyncEnabledCronTriggers,
  resyncEnabledIntervalTriggers,
} from "../src/features/triggers/scheduler";
import { workflowRunsRepository } from "../src/features/workflow-runs/repository";
import { workflowVersionsRepository } from "../src/features/workflow-versions/repository";
import { workflowsController } from "../src/features/workflows/controller";
import { workflowsRepository } from "../src/features/workflows/repository";
import { CancelledError, RetryableError, executeRun } from "../src/lib/engine";
import { logger } from "../src/lib/logger";
import { BatchedRunEventPublisher, subscribeCancel } from "../src/lib/run-events";
import {
  createCronSchedulerWorker,
  createWorkflowWorkers,
  findWorkflowJobAcrossLanes,
  type CronTriggerJob,
  type WorkflowJob,
  workflowQueueEvents,
} from "../src/lib/queue";

const workflowLog = logger.child({ component: "workflow-worker" });
const cronLog = logger.child({ component: "scheduler-worker" });

// ── Workflows ─────────────────────────────────────────────────────────
async function processWorkflow(job: Job<WorkflowJob>) {
  const {
    runId,
    workflowId,
    workflowVersionId,
    organizationId,
    environmentId,
    input,
    pinnedData,
    stopAtNodeId,
  } = job.data;
  const log = workflowLog.child({
    runId,
    workflowId,
    versionId: workflowVersionId,
    orgId: organizationId,
    jobId: job.id,
  });

  log.info("start");
  await workflowRunsRepository.markRunning(runId, job.id ?? "");
  // Batcher per-run: agrupa eventos em janelas de 50ms ou força flush
  // imediato em eventos terminais (workflow.*). Reduz IO em workflows
  // com muitos nós. Drain garantido no finally — não vazamos eventos.
  const eventPublisher = new BatchedRunEventPublisher();
  // Cancel signal — assinatura em Redis para evitar polling no DB entre nós.
  // Checagem inicial cobre janela onde o cancel foi publicado *antes* de
  // assinarmos (a flag no DB é a fonte de verdade pra esse caso).
  const cancelSub = await subscribeCancel(runId);
  const initialRun = await workflowRunsRepository.findByIdRaw(runId);
  const initiallyCancelled = Boolean(initialRun?.cancelRequested);
  const publishEvent = (
    type: import("../src/lib/run-events").RunEventType,
    payload: Record<string, unknown> = {},
    nodeId?: string,
  ) =>
    eventPublisher.enqueue({
      runId,
      workflowId,
      organizationId,
      type,
      nodeId,
      payload,
      occurredAt: new Date(),
    });
  await publishEvent("workflow.started");

  try {
    // Executa contra o snapshot imutável quando disponível; fallback para o
    // draft atual cobre runs legados de antes do versionamento.
    let definition: Record<string, unknown>;
    if (workflowVersionId) {
      const version = await workflowVersionsRepository.findByIdRaw(workflowVersionId);
      if (!version) throw new Error(`workflow_version_not_found: ${workflowVersionId}`);
      definition = version.definition;
    } else {
      const workflow = await workflowsRepository.findById(organizationId, workflowId);
      if (!workflow) throw new Error(`workflow_not_found: ${workflowId}`);
      definition = workflow.definition;
    }

    // Resolve variáveis do ambiente (vazio se não foi escolhido um).
    const variables = environmentId
      ? await environmentVariablesController.resolveForRun(organizationId, environmentId)
      : {};

    // ── Execução do workflow ──
    // Motor sequencial: percorre o `definition`, grava cada nó visitado
    // em workflow_run_steps. Falha em qualquer nó propaga pra cá.
    const result = await executeRun({
      runId,
      definition,
      input: input ?? {},
      env: variables,
      pinnedData: pinnedData ?? {},
      ...(stopAtNodeId && { stopAtNodeId }),
      subWorkflowRunner: (args) =>
        runSubWorkflow({
          parentOrganizationId: organizationId,
          parentRunId: runId,
          ...args,
        }),
      // Bound ao workflowId + environmentId atuais. O `ref` pode ser um UUID
      // (legado, pinned na linha) ou um nome lógico ("db_main") — o
      // repository.resolve() distingue por formato e aplica fallback
      // env-específico → default (env=NULL) automaticamente. Isso é o que
      // permite promover a mesma versão entre envs sem editar a definition.
      resolveConnection: async (ref) => {
        const row = await databaseConnectionsRepository.resolve(workflowId, ref, environmentId);
        if (!row) return null;
        return { connectionString: row.connectionString, kind: row.kind };
      },
      // Cancelamento cooperativo entre nós: in-memory, sem hit no DB.
      // Sinal vem por Redis pubsub (`run:{id}:cancel`); a flag inicial
      // cobre cancels publicados antes do worker assinar.
      checkCancelled: async () => initiallyCancelled || cancelSub.isCancelled(),
      onStepEvent: (event) =>
        publishEvent(
          event.type === "step-start"
            ? "node.started"
            : event.type === "step-success"
              ? "node.finished"
              : "node.failed",
          {
            index: event.index,
            nodeId: event.nodeId,
            nodeType: event.nodeType,
            status: event.status,
            output: event.output ?? null,
            error: event.error ?? null,
            durationMs: event.durationMs ?? null,
          },
          event.nodeId,
        ),
    });

    await workflowRunsRepository.markSuccess(runId, result.output);
    await publishEvent("workflow.finished", {
      output: result.output,
      stepsExecuted: result.stepsExecuted,
    });
    log.info({ steps: result.stepsExecuted }, "success");
    return result.output;
  } catch (err) {
    if (err instanceof CancelledError) {
      await workflowRunsRepository.markCancelled(runId);
      await publishEvent("workflow.cancelled");
      log.info("cancelled");
      return { cancelled: true };
    }

    const e = err as Error;
    const payload = { message: e.message, stack: e.stack };
    const attemptsMade = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    const isRetryable = err instanceof RetryableError;
    const willRetry = isRetryable && attemptsMade < maxAttempts;

    if (willRetry) {
      // Não marca o run como falhado ainda — BullMQ vai re-disparar o
      // processWorkflow com o mesmo runId. O worker faz markRunning de novo
      // no início. Só logamos o aviso pra observability.
      log.warn(
        { err: payload, attemptsMade, maxAttempts },
        "retryable failure — BullMQ will retry",
      );
      throw err;
    }

    // Falha definitiva — vira DLQ (BullMQ mantém em `failed` por 7 dias).
    await workflowRunsRepository.markFailed(runId, payload);
    await publishEvent("workflow.failed", payload);
    log.error({ err: payload, attemptsMade }, "failed");
    // Fan-out para `error_trigger`s subscritos. Best-effort — uma falha aqui
    // não deve mascarar o erro original; só logamos warning.
    void fanOutErrorTriggers({ workflowId, runId, organizationId, error: payload }).catch(
      (fanoutErr) => log.warn({ err: fanoutErr }, "error_trigger fanout failed"),
    );
    // Erros não-retentáveis viram UnrecoverableError → BullMQ marca failed
    // imediatamente sem consumir attempts restantes. Retryables esgotados
    // chegam aqui também (willRetry=false na última tentativa) e seguem
    // o caminho normal — `throw err` mantém o stack original.
    if (!isRetryable) {
      throw new UnrecoverableError(e.message);
    }
    throw err;
  } finally {
    // Garante flush do buffer antes do worker liberar o job — eventos
    // terminais já forçam flush, mas chamamos por segurança contra erros
    // inesperados que possam pular o caminho de markFailed/markSuccess.
    await eventPublisher.drain();
    await cancelSub.close().catch(() => {});
  }
}

// ── error_trigger fanout ──────────────────────────────────────────────
// Lista todos os `error_trigger` habilitados e enfileira um run para cada um
// que esteja interessado neste workflow. Config esperada por trigger:
//   - watch: "all" | "specific"
//   - workflowIds?: string[]   (quando watch = "specific")
async function fanOutErrorTriggers(args: {
  workflowId: string;
  runId: string;
  organizationId: string;
  error: { message: string; stack?: string };
}) {
  const subscribers = await triggersRepository.listEnabledByType("error_trigger");
  for (const trigger of subscribers) {
    if (trigger.organizationId !== args.organizationId) continue;
    const cfg = trigger.config as { watch?: unknown; workflowIds?: unknown };
    const watch = cfg.watch === "specific" ? "specific" : "all";
    if (watch === "specific") {
      const ids = Array.isArray(cfg.workflowIds) ? cfg.workflowIds.map(String) : [];
      if (!ids.includes(args.workflowId)) continue;
    }
    const result = await workflowsController.run(
      trigger.organizationId,
      trigger.workflowId,
      null,
      {
        environmentId: trigger.environmentId,
        workflowVersionId: trigger.workflowVersionId,
        input: {
          workflowId: args.workflowId,
          runId: args.runId,
          error: args.error,
        },
      },
    );
    if ("error" in result) {
      workflowLog.warn(
        { triggerId: trigger.id, err: result.error },
        "error_trigger dispatch failed",
      );
      continue;
    }
    await triggersRepository.updateRaw(trigger.id, {
      lastTriggeredAt: new Date(),
      lastRunId: result.runId,
    });
  }
}

// ── Sub-workflow runner ───────────────────────────────────────────────
// Injetado no `executeRun` pra o nó `execute_workflow`. Mesma org do pai
// (segurança: não cruza tenants). Espera síncrono via QueueEvents +
// timeout opaco — esgotado o tempo, retorna status "timeout" e o sub-run
// continua rodando em background (não cancelamos).
interface SubRunArgs {
  parentOrganizationId: string;
  parentRunId: string;
  workflowId: string;
  input: Record<string, unknown>;
  environmentId: string | null;
  timeoutMs: number;
}

async function runSubWorkflow(args: SubRunArgs) {
  const log = workflowLog.child({
    parentRunId: args.parentRunId,
    subWorkflowId: args.workflowId,
  });

  const enqueued = await workflowsController.run(args.parentOrganizationId, args.workflowId, null, {
    environmentId: args.environmentId,
    input: args.input,
  });
  if ("error" in enqueued) {
    throw new Error(`execute_workflow: ${enqueued.error}`);
  }

  const jobId = enqueued.jobId;
  if (!jobId) throw new Error("execute_workflow: sub-job sem id");

  log.info({ subRunId: enqueued.runId, jobId }, "sub-workflow enqueued");

  try {
    const found = await findWorkflowJobAcrossLanes(jobId);
    if (!found)
      throw new Error(`execute_workflow: job ${jobId} sumiu antes de waitUntilFinished`);
    await found.job.waitUntilFinished(workflowQueueEvents[found.lane], args.timeoutMs);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes("timed out") || msg.includes("timeout")) {
      log.warn({ subRunId: enqueued.runId }, "sub-workflow timeout");
      return { runId: enqueued.runId, status: "timeout" as const };
    }
    // Falha do sub: continua pra coletar o status real (failed/cancelled) do DB.
  }

  const finalRun = await workflowRunsRepository.findByIdRaw(enqueued.runId);
  const status = (finalRun?.status ?? "failed") as "success" | "failed" | "cancelled";
  const output =
    finalRun?.output && typeof finalRun.output === "object"
      ? (finalRun.output as Record<string, unknown>)
      : {};
  return { runId: enqueued.runId, status, output };
}

// Workers por lane — quantos rodam aqui depende de WORKFLOW_BUN_LANES.
// Default: todas. Pra delegar uma lane a um worker externo (ex.: Go
// consumindo "scraping"), defina `WORKFLOW_BUN_LANES=default,heavy`.
const workflowWorkers = createWorkflowWorkers(processWorkflow);
for (const w of workflowWorkers) {
  w.on("ready", () => workflowLog.info({ queue: w.name }, "ready"));
  w.on("error", (err) => workflowLog.error({ queue: w.name, err }, "error"));
}

// ── Scheduler (cron + interval) ────────────────────────────────────────
// A fila `cron-scheduler` é compartilhada entre triggers cron e interval —
// o BullMQ chama com `triggerId` e aqui resolvemos o tipo via DB.
async function processScheduledTrigger(job: Job<CronTriggerJob>) {
  const { triggerId } = job.data;
  const log = cronLog.child({ triggerId });
  log.info("fire");

  const trigger = await triggersRepository.findByIdRaw(triggerId);
  if (!trigger) {
    log.warn("trigger not found, skipping");
    return;
  }
  if (!trigger.enabled) {
    log.info("trigger disabled, skipping");
    return;
  }

  const result = await workflowsController.run(
    trigger.organizationId,
    trigger.workflowId,
    null, // disparo do sistema
    {
      environmentId: trigger.environmentId,
      // Pin de versão: se o trigger aponta pra uma versão específica, é ela
      // que roda. Permite "prod tá em v17, stage em v18" sem mexer no draft.
      workflowVersionId: trigger.workflowVersionId,
      input: {},
    },
  );

  if ("error" in result) {
    log.error({ err: result.error }, "failed to run trigger");
    return;
  }

  await triggersRepository.updateRaw(triggerId, {
    lastTriggeredAt: new Date(),
    lastRunId: result.runId,
  });
  log.info({ runId: result.runId }, "enqueued run for trigger");
}

// Re-registra todos os triggers scheduler-driven (cron + interval) antes do
// worker subir. Protege contra perda de estado do Redis (deploy, flush, migração).
try {
  const [cronResult, intervalResult] = await Promise.all([
    resyncEnabledCronTriggers(),
    resyncEnabledIntervalTriggers(),
  ]);
  cronLog.info({ cron: cronResult, interval: intervalResult }, "resynced triggers");
} catch (err) {
  cronLog.error({ err }, "resync failed");
}

const cronWorker = createCronSchedulerWorker(processScheduledTrigger);
cronWorker.on("ready", () => cronLog.info("ready"));
cronWorker.on("error", (err) => cronLog.error({ err }, "error"));

// ── Shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info({ signal }, "received signal, closing");
  await Promise.all([...workflowWorkers.map((w) => w.close()), cronWorker.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
