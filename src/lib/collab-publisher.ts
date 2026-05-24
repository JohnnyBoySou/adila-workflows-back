/**
 * Publisher leve para postar `AwarenessEvent` no canal Redis da sala.
 * O serviço `realtime` está subscrito nesse canal e repassa aos WebSockets.
 *
 * Por que separar do `CollaborationGateway`? O gateway abre 2 conexões
 * Redis (pub + sub) e mantém estado de presença. No api só precisamos
 * publicar — uma única conexão `pub`, sem subscribe.
 */
import { Redis } from "ioredis";
import { env } from "../config/env";
import type { AwarenessEvent } from "./collab";

const pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

function roomChannel(workflowId: string) {
  return `workflow:${workflowId}`;
}

export async function publishToRoom(event: AwarenessEvent): Promise<void> {
  if (!("workflowId" in event)) return;
  try {
    await pub.publish(roomChannel(event.workflowId), JSON.stringify(event));
  } catch {
    // Best-effort: realtime é não-crítico — falhas só atrasam a UI dos peers.
  }
}
