import { Redis } from "ioredis";
import { env } from "../config/env";
import { workflowRunEventsRepository } from "../features/workflow-runs/events-repository";
import { connection } from "./redis";

/**
 * Pub/sub de eventos por run, em cima do Redis. A API se inscreve via SSE,
 * o worker publica em cada transição. Canal: `run:{runId}`.
 *
 * Pub usa a connection compartilhada; sub precisa de um cliente dedicado
 * porque o protocolo bloqueia a conexão em modo subscribe.
 *
 * A serialização envelopa um *array* de eventos por mensagem — o batcher
 * agrupa múltiplos em uma única publish/INSERT. Subscribers que recebem
 * o pacote re-emitem item a item, preservando a API antiga (`onEvent`).
 */

export type RunEventType =
  | "workflow.started"
  | "workflow.finished"
  | "workflow.failed"
  | "workflow.cancelled"
  | "node.started"
  | "node.finished"
  | "node.failed";

const TERMINAL_TYPES = new Set<RunEventType>([
  "workflow.started",
  "workflow.finished",
  "workflow.failed",
  "workflow.cancelled",
]);

export type RunEvent = {
  type: RunEventType;
  runId: string;
  at: string;
  /** Sequência monotônica do bigserial em `workflow_run_events.seq`. Atribuído após INSERT. */
  seq?: number;
  data?: Record<string, unknown>;
  step?: {
    index: number;
    nodeId: string;
    nodeType: string;
    status: "running" | "success" | "failed";
    output?: Record<string, unknown> | null;
    error?: Record<string, unknown> | null;
    durationMs?: number | null;
  };
};

/** Input do batcher — ainda sem `seq` (atribuído pelo INSERT). */
export type RunEventInput = {
  runId: string;
  workflowId: string;
  organizationId: string;
  type: RunEventType;
  nodeId?: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
};

function channel(runId: string) {
  return `run:${runId}`;
}

function cancelChannel(runId: string) {
  return `run:${runId}:cancel`;
}

/**
 * Publica sinal de cancelamento para o worker que estiver executando o run.
 * Backup: a flag `cancelRequested` no DB continua sendo gravada pelo
 * repository — o subscriber pode estar caído ou ainda não inscrito quando
 * a publish acontece, então o worker faz uma checagem síncrona no início.
 */
export async function publishCancel(runId: string): Promise<void> {
  await connection.publish(cancelChannel(runId), "1");
}

/**
 * Subscribe ao canal de cancelamento de um run. Devolve `{ isCancelled, close }`.
 * `isCancelled()` retorna instantâneo (booleano em memória) — substitui o
 * polling no DB usado pelo `checkCancelled` do executor.
 */
export async function subscribeCancel(
  runId: string,
): Promise<{ isCancelled: () => boolean; close: () => Promise<void> }> {
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  let cancelled = false;
  await subscriber.subscribe(cancelChannel(runId));
  subscriber.on("message", () => {
    cancelled = true;
  });
  return {
    isCancelled: () => cancelled,
    close: async () => {
      await subscriber.unsubscribe(cancelChannel(runId)).catch(() => {});
      subscriber.disconnect();
    },
  };
}

/** Publica um evento isolado (sem batching) — fallback para callers fora do worker. */
export async function publishRunEvent(event: RunEvent): Promise<void> {
  await connection.publish(channel(event.runId), JSON.stringify([event]));
}

/**
 * Batcher por-run. Bufferiza eventos por até `flushIntervalMs` (default 50ms)
 * e força flush imediato em eventos terminais (workflow.started/finished/
 * failed/cancelled). Single INSERT VALUES + single Redis publish com array
 * de eventos. Reduz IO drasticamente em workflows com muitos nós.
 */
export class BatchedRunEventPublisher {
  private buffer: RunEventInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(private readonly flushIntervalMs = 50) {}

  enqueue(event: RunEventInput): Promise<void> {
    this.buffer.push(event);
    if (TERMINAL_TYPES.has(event.type)) {
      return this.flush();
    }
    if (!this.timer) {
      this.timer = setTimeout(() => {
        void this.flush();
      }, this.flushIntervalMs);
    }
    return Promise.resolve();
  }

  /** Aguarda qualquer flush em curso terminar — para uso no shutdown. */
  async drain(): Promise<void> {
    await this.flush();
    if (this.flushing) await this.flushing;
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];

    const run = (async () => {
      try {
        const rows = await workflowRunEventsRepository.createMany(
          batch.map((e) => ({
            runId: e.runId,
            workflowId: e.workflowId,
            organizationId: e.organizationId,
            nodeId: e.nodeId,
            eventType: e.type,
            source: "worker" as const,
            payload: e.payload ?? {},
            occurredAt: e.occurredAt ?? new Date(),
          })),
        );

        // Agrupa por runId pra publicar um pacote por canal.
        const byRun = new Map<string, RunEvent[]>();
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const input = batch[i]!;
          const evt: RunEvent = {
            type: input.type,
            runId: input.runId,
            at: (row.occurredAt as Date).toISOString(),
            seq: Number(row.seq),
            data: input.payload ?? {},
          };
          const arr = byRun.get(input.runId);
          if (arr) arr.push(evt);
          else byRun.set(input.runId, [evt]);
        }
        for (const [runId, events] of byRun) {
          await connection.publish(channel(runId), JSON.stringify(events));
        }
      } catch (err) {
        // Best-effort: falha de persistência/publicação não derruba o worker;
        // o run continua e o cliente reconcilia via `Last-Event-Id` ao reabrir.
        // (loga via console pra não acoplar com logger aqui.)
        console.error("[run-events] flush failed", err);
      }
    })();
    this.flushing = run;
    try {
      await run;
    } finally {
      if (this.flushing === run) this.flushing = null;
    }
  }
}

/**
 * Sob assinatura por runId. O publisher entrega *array* de eventos por
 * mensagem (batching) — o subscriber re-emite item a item para manter a
 * API antiga de `onEvent(event)`. Devolve unsubscribe.
 */
export async function subscribeToRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
): Promise<() => Promise<void>> {
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await subscriber.subscribe(channel(runId));
  subscriber.on("message", (_chan, payload) => {
    try {
      const parsed = JSON.parse(payload);
      // Aceita tanto array (novo formato batchado) quanto objeto único (legacy).
      const events: RunEvent[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const evt of events) onEvent(evt);
    } catch {
      // Mensagem malformada — pula. Não derruba o stream.
    }
  });
  return async () => {
    await subscriber.unsubscribe(channel(runId)).catch(() => {});
    subscriber.disconnect();
  };
}
