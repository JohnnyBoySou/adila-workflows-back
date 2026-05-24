import { Redis } from "ioredis";
import { env } from "../config/env";
import { connection } from "./redis";

/**
 * Pub/sub de eventos por run, em cima do Redis. A API se inscreve via SSE,
 * o worker publica em cada transição. Canal: `run:{runId}`.
 *
 * Pub usa a connection compartilhada; sub precisa de um cliente dedicado
 * porque o protocolo bloqueia a conexão em modo subscribe.
 */

export type RunEvent = {
  type: string;
  runId: string;
  at: string;
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

function channel(runId: string) {
  return `run:${runId}`;
}

export async function publishRunEvent(event: RunEvent): Promise<void> {
  await connection.publish(channel(event.runId), JSON.stringify(event));
}

/**
 * Sob assinatura por runId. Devolve unsubscribe. O cliente Redis é dedicado
 * a esta inscrição — fechá-lo é obrigatório no cleanup pra não vazar
 * conexão por SSE aberta.
 */
export async function subscribeToRun(
  runId: string,
  onEvent: (event: RunEvent) => void,
): Promise<() => Promise<void>> {
  const subscriber = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await subscriber.subscribe(channel(runId));
  subscriber.on("message", (_chan, payload) => {
    try {
      onEvent(JSON.parse(payload) as RunEvent);
    } catch {
      // Mensagem malformada — pula. Não derruba o stream.
    }
  });
  return async () => {
    await subscriber.unsubscribe(channel(runId)).catch(() => {});
    subscriber.disconnect();
  };
}
