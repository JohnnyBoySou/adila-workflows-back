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
  /**
   * Modo debug: engine para após executar o nó com este id. Útil pra
   * "play até aqui" no editor — geralmente vem com pinnedData nos upstream.
   * Opcional; ausente = roda até o end natural.
   */
  stopAtNodeId?: string;
}

/**
 * Registry de "lanes" (filas) de workflow.
 *
 * O modelo é uma fila default + N lanes opcionais. Cada lane vira uma fila
 * BullMQ separada, podendo ser consumida por:
 *   - este mesmo worker Bun (escalado por concorrência)
 *   - um worker externo (ex.: Go) inscrito na mesma fila Redis
 *
 * Roteamento é feito em `pickQueueForDefinition()` — varre os node-types do
 * grafo e escolhe a lane mais pesada que casar. Default vence se nada casar.
 *
 * Para adicionar uma lane nova (ex.: Go consumindo scraping):
 *   1. Adicione o nome em LANE_NAMES e a regra em LANE_ROUTES
 *   2. Suba o worker externo apontando pra `workflows:scraping` no Redis
 *   3. Opcional: desabilite o consumer Bun dessa lane com WORKFLOW_BUN_LANES
 */
export const LANE_NAMES = ["default", "heavy", "scraping"] as const;
export type LaneName = (typeof LANE_NAMES)[number];

/**
 * Regras de roteamento por node-type. Primeira lane (em ordem de declaração)
 * cujo predicado bater vence. `default` é fallback implícito — não precisa
 * de regra.
 */
const LANE_ROUTES: Array<{ lane: Exclude<LaneName, "default">; nodeTypes: ReadonlySet<string> }> = [
  // Scraping costuma ser IO-bound mas com payloads grandes — bom candidato
  // pra um worker Go com http client tunado e pool de proxies.
  { lane: "scraping", nodeTypes: new Set(["http_request", "rss_trigger"]) },
  // Heavy: CPU/transform massivo. Ex.: parsing de JSON gigante, code node.
  { lane: "heavy", nodeTypes: new Set(["code", "execute_workflow"]) },
];

function queueName(lane: LaneName): string {
  // BullMQ proíbe `:` em nomes de fila (colide com seu key layout interno
  // `bull:{queue}:...`). Usamos `-` no separador da lane.
  return lane === "default" ? "workflows" : `workflows-${lane}`;
}

function buildQueue(lane: LaneName): Queue<WorkflowJob> {
  return new Queue<WorkflowJob>(queueName(lane), {
    connection,
    defaultJobOptions: {
      // Compactação automática — evita o Redis crescer sem limite.
      // Mantemos os últimos N pra debug; falhados ficam mais tempo (DLQ).
      removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
      removeOnFail: { count: 5000, age: 7 * 24 * 60 * 60 },
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
    },
  });
}

export const workflowQueues: Record<LaneName, Queue<WorkflowJob>> = Object.fromEntries(
  LANE_NAMES.map((l) => [l, buildQueue(l)]),
) as Record<LaneName, Queue<WorkflowJob>>;

/** Fila default — preservada como export pra callers legados. */
export const workflowQueue = workflowQueues.default;

/**
 * QueueEvents por lane — `job.waitUntilFinished()` precisa do listener da
 * fila exata onde o job vive. Compartilhados (instanciar é caro).
 */
export const workflowQueueEvents: Record<LaneName, QueueEvents> = Object.fromEntries(
  LANE_NAMES.map((l) => [l, new QueueEvents(queueName(l), { connection })]),
) as Record<LaneName, QueueEvents>;

/**
 * Acessa uma fila por nome com type safety. `null` pra nomes desconhecidos
 * (lane removida do registry mas job antigo ainda no Redis).
 */
export function getWorkflowQueue(lane: string): Queue<WorkflowJob> | null {
  return (workflowQueues as Record<string, Queue<WorkflowJob>>)[lane] ?? null;
}

/**
 * Decide em qual lane enfileirar um job baseado nos node-types presentes.
 * Conservador: se em dúvida cai no default. Roteamento é por *workflow* —
 * uma vez no worker, o run executa inteiro lá (não migra entre lanes).
 */
export function pickLaneForDefinition(definition: unknown): LaneName {
  if (!definition || typeof definition !== "object") return "default";
  const nodes = (definition as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return "default";
  const types = new Set<string>();
  for (const n of nodes) {
    const t = (n as { type?: unknown })?.type;
    if (typeof t === "string") types.add(t);
  }
  for (const route of LANE_ROUTES) {
    for (const nodeType of route.nodeTypes) {
      if (types.has(nodeType)) return route.lane;
    }
  }
  return "default";
}

/**
 * Procura um job por id em todas as lanes. Necessário pra cancel/lookup
 * que recebem só o `jobId` (sem saber em qual fila ele foi enfileirado).
 * Custo: O(N lanes) HGETs no Redis — barato para N pequeno (~3).
 */
export async function findWorkflowJobAcrossLanes(jobId: string) {
  for (const lane of LANE_NAMES) {
    const job = await workflowQueues[lane].getJob(jobId);
    if (job) return { lane, job };
  }
  return null;
}

/**
 * Lista de lanes que este worker Bun deve consumir. Default: todas.
 * Configurável via `WORKFLOW_BUN_LANES=default,heavy` para desligar lanes
 * que ficaram a cargo de workers externos (ex.: Go consumindo `scraping`).
 */
function lanesForBunWorker(): LaneName[] {
  const raw = process.env.WORKFLOW_BUN_LANES?.trim();
  if (!raw) return [...LANE_NAMES];
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const filtered = names.filter((n): n is LaneName =>
    (LANE_NAMES as readonly string[]).includes(n),
  );
  return filtered.length > 0 ? filtered : ["default"];
}

/**
 * Cria um Worker por lane configurada. Devolve um array — o caller mantém
 * referência pra graceful shutdown. Usar `createWorkflowWorker(processor)`
 * (sem lane explícita) cria todos os workers de uma vez.
 */
export function createWorkflowWorkers(processor: Processor<WorkflowJob>): Worker<WorkflowJob>[] {
  return lanesForBunWorker().map(
    (lane) =>
      new Worker<WorkflowJob>(queueName(lane), processor, {
        connection,
        concurrency: env.WORKFLOW_WORKER_CONCURRENCY,
      }),
  );
}

/** @deprecated — use `createWorkflowWorkers` (multi-lane). */
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
