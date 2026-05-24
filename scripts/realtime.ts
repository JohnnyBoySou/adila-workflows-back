import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { env } from "../src/config/env";
import { auth } from "../src/lib/auth";
import { CollaborationGateway, type AwarenessEvent, type Presence } from "../src/lib/collab";
import { db } from "../src/db";
import { member } from "../src/db/auth-schema";
import { workflows } from "../src/db/schema";
import { collaborationRepository } from "../src/features/workflow-runs/collaboration-repository";

const gateway = new CollaborationGateway();
const sockets = new Map<
  unknown,
  {
    userId?: string;
    role?: string;
    organizationId?: string;
    unsubscribe?: () => Promise<void>;
  }
>();

async function authorize(headers: Headers, workflowId: string) {
  const result = await auth.api.getSession({ headers });
  if (!result) return null;
  const orgId = result.session.activeOrganizationId;
  if (!orgId) return null;
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, result.user.id)))
    .limit(1);
  if (!membership) return null;
  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
    .limit(1);
  if (!workflow) return null;
  return { userId: result.user.id, organizationId: orgId, role: membership.role };
}

const app = new Elysia({ name: "realtime-gateway" })
  .get("/health", async () => ({ ok: true, service: "realtime-gateway" }))
  .get(
    "/rooms/:workflowId/document",
    async ({ params, request, status }) => {
      const authz = await authorize(request.headers, params.workflowId);
      if (!authz) return status(401, { error: "unauthorized" });
      const snapshot = await collaborationRepository.latestSnapshot(
        authz.organizationId,
        params.workflowId,
      );
      const since = snapshot?.createdAt ?? new Date(0);
      const patches = await collaborationRepository.patchesSince(
        authz.organizationId,
        params.workflowId,
        since,
      );
      return {
        workflowId: params.workflowId,
        snapshot: snapshot ? { id: snapshot.id, updateBase64: snapshot.updateBase64 } : null,
        patches: patches.map((p) => ({ id: p.id, updateBase64: p.updateBase64, at: p.createdAt })),
      };
    },
    { params: t.Object({ workflowId: t.String({ format: "uuid" }) }) },
  )
  .post(
    "/rooms/:workflowId/snapshot",
    async ({ params, request, body, status }) => {
      const authz = await authorize(request.headers, params.workflowId);
      if (!authz) return status(401, { error: "unauthorized" });
      if (!(authz.role === "owner" || authz.role === "admin")) {
        return status(403, { error: "forbidden" });
      }
      await collaborationRepository.append({
        organizationId: authz.organizationId,
        workflowId: params.workflowId,
        kind: "snapshot",
        updateBase64: body.updateBase64,
        sourceUserId: authz.userId,
      });
      return { ok: true };
    },
    {
      params: t.Object({ workflowId: t.String({ format: "uuid" }) }),
      body: t.Object({ updateBase64: t.String({ minLength: 1 }) }),
    },
  )
  .get(
    "/rooms/:workflowId/presence",
    async ({ params }) => ({
      workflowId: params.workflowId,
      ttlSeconds: CollaborationGateway.ttlSeconds(),
      heartbeatSeconds: CollaborationGateway.heartbeatSeconds(),
      users: await gateway.listPresence(params.workflowId),
    }),
    { params: t.Object({ workflowId: t.String() }) },
  )
  .ws("/ws/:workflowId", {
    params: t.Object({ workflowId: t.String() }),
    body: t.Object({
      type: t.String(),
      userId: t.String(),
      cursor: t.Optional(t.Object({ x: t.Number(), y: t.Number() })),
      selectedNodeId: t.Optional(t.String()),
      viewport: t.Optional(t.Object({ x: t.Number(), y: t.Number(), zoom: t.Number() })),
      updateBase64: t.Optional(t.String()),
    }),
    async open(ws) {
      const workflowId = ws.data.params.workflowId;
      const authHeaders = new Headers();
      for (const [k, v] of Object.entries(ws.data.headers)) {
        if (typeof v === "string") authHeaders.set(k, v);
      }
      const authz = await authorize(authHeaders, workflowId);
      if (!authz) {
        ws.send({ type: "error", error: "unauthorized" });
        ws.close();
        return;
      }
      const token = gateway.connectionToken();
      const unsubscribe = await gateway.subscribe(workflowId, (event) => {
        ws.send(event);
      });
      sockets.set(ws, { ...authz, unsubscribe });
      ws.send({ type: "room.ready", workflowId, connectionId: token });
    },
    async message(ws, message) {
      const workflowId = ws.data.params.workflowId;
      const now = Date.now();
      const state = sockets.get(ws);
      if (!state?.userId) {
        ws.send({ type: "error", error: "unauthorized" });
        ws.close();
        return;
      }
      // viewer só presence; editor/admin podem colaborar (yjs/node selection)
      const canEdit = state.role === "owner" || state.role === "admin" || state.role === "member";
      if ((message.type === "yjs.update" || message.type === "node.selected") && !canEdit) {
        ws.send({ type: "error", error: "forbidden" });
        return;
      }
      const presence: Presence = {
        userId: state.userId,
        workflowId,
        cursor: message.cursor ?? { x: 0, y: 0 },
        selectedNodeId: message.selectedNodeId,
        viewport: message.viewport,
        updatedAt: now,
      };

      let event: AwarenessEvent | null = null;
      if (message.type === "user.joined") event = { type: "user.joined", workflowId, presence };
      else if (message.type === "cursor.move") event = { type: "cursor.move", workflowId, presence };
      else if (message.type === "node.selected") event = { type: "node.selected", workflowId, presence };
      else if (message.type === "viewport.changed") {
        event = { type: "viewport.changed", workflowId, presence };
      } else if (message.type === "yjs.update" && message.updateBase64) {
        event = { type: "yjs.update", workflowId, updateBase64: message.updateBase64, at: now };
        await collaborationRepository.append({
          organizationId: state.organizationId!,
          workflowId,
          kind: "patch",
          updateBase64: message.updateBase64,
          sourceUserId: state.userId,
        });
      }

      await gateway.upsertPresence(presence);
      if (event) await gateway.publish(event);
    },
    async close(ws) {
      const workflowId = ws.data.params.workflowId;
      const state = sockets.get(ws);
      const userId = state?.userId;
      if (typeof userId === "string" && userId.length > 0) {
        await gateway.removePresence(workflowId, userId);
        await gateway.publish({ type: "user.left", workflowId, userId });
      }
      await state?.unsubscribe?.();
      sockets.delete(ws);
    },
  });

// Em prod (Railway), cada service tem sua própria `PORT` injetada — não
// existe "API + 1". Em dev rodamos os dois no mesmo Bun e separamos por
// offset. `REALTIME_PORT` cobre o caso prod (override explícito); fallback
// é `PORT + 1` pro dev.
const realtimePort = Number(process.env.REALTIME_PORT ?? env.PORT + 1);
app.listen(realtimePort);
console.log(`realtime gateway running on :${realtimePort}`);
