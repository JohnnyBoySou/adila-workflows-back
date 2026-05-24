import { Queue, QueueEvents, Worker, type Processor } from "bullmq";
import { env } from "../config/env";
import { connection } from "./redis";

// ─── Workflows ──────────────────────────────────────────────
// Job de execução de um workflow. `runId` referencia a row em workflow_runs
// criada antes do enqueue.
export interface WorkflowJob {
  runId: string;
  workflowId: string;
  // Snapshot imutável que vai executar. Nullable só para compat com runs antigos.
  workflowVersionId: string | null;
  organizationId: string;
  environmentId: string | null;
  input: Record<string, unknown>;
  /**
   * Outputs pinados pelo editor — por `nodeId`. O executor pula o handler
   * desses nós e usa o output fornecido. Opcional pra compat com jobs antigos.
   */
  pinnedData?: Record<string, Record<string, unknown>>;
}

export const workflowQueue = new Queue<WorkflowJob>("workflows", { connection });

/**
 * Listener compartilhado pra `job.waitUntilFinished(events, timeout)` —
 * usado pelo webhook sync. Instanciar QueueEvents é caro (mantém um
 * pub/sub subscriber no Redis); compartilhar é o padrão recomendado.
 */
export const workflowQueueEvents = new QueueEvents("workflows", { connection });

export function createWorkflowWorker(processor: Processor<WorkflowJob>) {
  return new Worker<WorkflowJob>("workflows", processor, {
    connection,
    concurrency: env.WORKFLOW_WORKER_CONCURRENCY,
  });
}

// ─── Cron scheduler ─────────────────────────────────────────
// Cada trigger cron registra um Job Scheduler no BullMQ. Quando o cron dispara,
// um job é adicionado nesta fila com o `triggerId`; o worker resolve e enfileira
// a execução real no `workflowQueue`.
export interface CronTriggerJob {
  triggerId: string;
}

export const cronSchedulerQueue = new Queue<CronTriggerJob>("cron-scheduler", {
  connection,
});

export function createCronSchedulerWorker(processor: Processor<CronTriggerJob>) {
  return new Worker<CronTriggerJob>("cron-scheduler", processor, { connection });
}
