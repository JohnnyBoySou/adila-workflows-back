import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { env } from "../config/env";

const PRESENCE_TTL_SECONDS = 45;
const HEARTBEAT_SECONDS = 15;

export type Presence = {
  userId: string;
  workflowId: string;
  cursor: { x: number; y: number };
  selectedNodeId?: string;
  viewport?: { x: number; y: number; zoom: number };
  updatedAt: number;
};

export type AwarenessEvent =
  | { type: "user.joined"; workflowId: string; presence: Presence }
  | { type: "user.left"; workflowId: string; userId: string }
  | { type: "cursor.move"; workflowId: string; presence: Presence }
  | { type: "node.selected"; workflowId: string; presence: Presence }
  | { type: "viewport.changed"; workflowId: string; presence: Presence }
  | { type: "yjs.update"; workflowId: string; updateBase64: string; at: number };

export class CollaborationGateway {
  private readonly pub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  private readonly sub = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

  private roomChannel(workflowId: string) {
    return `workflow:${workflowId}`;
  }

  private presenceKey(workflowId: string, userId: string) {
    return `presence:workflow:${workflowId}:user:${userId}`;
  }

  private roomPresencePattern(workflowId: string) {
    return `presence:workflow:${workflowId}:user:*`;
  }

  private roomUsersKey(workflowId: string) {
    return `presence:workflow:${workflowId}:users`;
  }

  async subscribe(workflowId: string, onMessage: (event: AwarenessEvent) => void) {
    const channel = this.roomChannel(workflowId);
    await this.sub.subscribe(channel);
    const handler = (_channel: string, payload: string) => {
      try {
        onMessage(JSON.parse(payload) as AwarenessEvent);
      } catch {
        // best effort
      }
    };
    this.sub.on("message", handler);
    return async () => {
      this.sub.off("message", handler);
      await this.sub.unsubscribe(channel);
    };
  }

  async publish(event: AwarenessEvent) {
    await this.pub.publish(this.roomChannel(event.workflowId), JSON.stringify(event));
  }

  async upsertPresence(presence: Presence) {
    const userKey = this.presenceKey(presence.workflowId, presence.userId);
    const usersKey = this.roomUsersKey(presence.workflowId);
    await this.pub.set(
      userKey,
      JSON.stringify(presence),
      "EX",
      PRESENCE_TTL_SECONDS,
    );
    await this.pub.sadd(usersKey, presence.userId);
    await this.pub.expire(usersKey, PRESENCE_TTL_SECONDS * 2);
  }

  async removePresence(workflowId: string, userId: string) {
    await this.pub.del(this.presenceKey(workflowId, userId));
    await this.pub.srem(this.roomUsersKey(workflowId), userId);
  }

  async listPresence(workflowId: string) {
    let keys: string[] = [];
    const userIds = await this.pub.smembers(this.roomUsersKey(workflowId));
    if (userIds.length > 0) {
      keys = userIds.map((userId) => this.presenceKey(workflowId, userId));
    } else {
      // Fallback para rooms antigas sem índice SET, evitando KEYS com SCAN.
      let cursor = "0";
      do {
        const [next, batch] = await this.pub.scan(
          cursor,
          "MATCH",
          this.roomPresencePattern(workflowId),
          "COUNT",
          "100",
        );
        cursor = next;
        keys.push(...batch);
      } while (cursor !== "0");
    }
    if (keys.length === 0) return [] as Presence[];
    const values = await this.pub.mget(keys);
    return values
      .filter((v): v is string => Boolean(v))
      .map((v) => JSON.parse(v) as Presence)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  connectionToken() {
    return randomUUID();
  }

  static ttlSeconds() {
    return PRESENCE_TTL_SECONDS;
  }

  static heartbeatSeconds() {
    return HEARTBEAT_SECONDS;
  }
}
