/**
 * Worker BullMQ — processa jobs das filas `workflows` e `cron-scheduler`.
 *
 * Roda como processo separado: `bun run worker` (ver package.json).
 * Em produção, escale com várias instâncias — BullMQ distribui via Redis.
 */
import type { Job } from "bullmq";
import { environmentVariablesController } from "../src/features/environment-variables/controller";
import { triggersRepository } from "../src/features/triggers/repository";
import { resyncEnabledCronTriggers } from "../src/features/triggers/scheduler";
import { workflowRunsRepository } from "../src/features/workflow-runs/repository";
import { workflowVersionsRepository } from "../src/features/workflow-versions/repository";
import { workflowsController } from "../src/features/workflows/controller";
import { workflowsRepository } from "../src/features/workflows/repository";
import { CancelledError, executeRun } from "../src/lib/engine";
import { logger } from "../src/lib/logger";
import { publishRunEvent } from "../src/lib/run-events";
import {
  createCronSchedulerWorker,
  createWorkflowWorker,
  type CronTriggerJob,
  type WorkflowJob,
  workflowQueue,
  workflowQueueEvents,
} from "../src/lib/queue";

const workflowLog = logger.child({ component: "workflow-worker" });
const cronLog = logger.child({ component: "cron-worker" });

// ── Workflows ─────────────────────────────────────────────────────────
async function processWorkflow(job: Job<WorkflowJob>) {
  const { runId, workflowId, workflowVersionId, organizationId, environmentId, input } = job.data;
  const log = workflowLog.child({
    runId,
    workflowId,
    versionId: workflowVersionId,
    orgId: organizationId,
    jobId: job.id,
  });

  log.info("start");
  await workflowRunsRepository.markRunning(runId, job.id ?? "");
  await publishRunEvent({ type: "run-start", runId, at: new Date().toISOString() });

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
      subWorkflowRunner: (args) =>
        runSubWorkflow({
          parentOrganizationId: organizationId,
          parentRunId: runId,
          ...args,
        }),
      // Polling cooperativo do flag `cancelRequested` entre nós.
      checkCancelled: async () => {
        const r = await workflowRunsRepository.findByIdRaw(runId);
        return Boolean(r?.cancelRequested);
      },
      onStepEvent: (event) =>
        publishRunEvent({
          type: event.type,
          runId,
          at: new Date().toISOString(),
          step: {
            index: event.index,
            nodeId: event.nodeId,
            nodeType: event.nodeType,
            status: event.status,
            output: event.output ?? null,
            error: event.error ?? null,
            durationMs: event.durationMs ?? null,
          },
        }),
    });

    await workflowRunsRepository.markSuccess(runId, result.output);
    await publishRunEvent({
      type: "run-success",
      runId,
      at: new Date().toISOString(),
      data: { output: result.output, stepsExecuted: result.stepsExecuted },
    });
    log.info({ steps: result.stepsExecuted }, "success");
    return result.output;
  } catch (err) {
    if (err instanceof CancelledError) {
      await workflowRunsRepository.markCancelled(runId);
      await publishRunEvent({
        type: "run-cancelled",
        runId,
        at: new Date().toISOString(),
      });
      log.info("cancelled");
      return { cancelled: true };
    }
    const e = err as Error;
    const payload = { message: e.message, stack: e.stack };
    await workflowRunsRepository.markFailed(runId, payload);
    await publishRunEvent({
      type: "run-failed",
      runId,
      at: new Date().toISOString(),
      data: payload,
    });
    log.error({ err: payload }, "failed");
    throw err;
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
    const job = await workflowQueue.getJob(jobId);
    if (!job) throw new Error(`execute_workflow: job ${jobId} sumiu antes de waitUntilFinished`);
    await job.waitUntilFinished(workflowQueueEvents, args.timeoutMs);
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

const workflowWorker = createWorkflowWorker(processWorkflow);
workflowWorker.on("ready", () => workflowLog.info("ready"));
workflowWorker.on("error", (err) => workflowLog.error({ err }, "error"));

// ── Cron scheduler ─────────────────────────────────────────────────────
// Cada disparo cron resolve o trigger e enfileira uma execução normal.
async function processCron(job: Job<CronTriggerJob>) {
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
    { environmentId: trigger.environmentId, input: {} },
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

// Re-registra todos os triggers cron habilitados antes do worker subir.
// Protege contra perda de estado do Redis (deploy, flush, migração).
try {
  const result = await resyncEnabledCronTriggers();
  cronLog.info(result, "resynced cron triggers");
} catch (err) {
  cronLog.error({ err }, "resync failed");
}

const cronWorker = createCronSchedulerWorker(processCron);
cronWorker.on("ready", () => cronLog.info("ready"));
cronWorker.on("error", (err) => cronLog.error({ err }, "error"));

// ── Shutdown ─────────────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info({ signal }, "received signal, closing");
  await Promise.all([workflowWorker.close(), cronWorker.close()]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
