import { Elysia, t } from "elysia";
import { and, eq } from "drizzle-orm";
import { env } from "../src/config/env";
import {
  authenticateToken,
  bearerToken,
  IdentityAuthError,
  localMemberRole,
} from "../src/lib/identity-auth";
import { CollaborationGateway, type AwarenessEvent, type Presence } from "../src/lib/collab";
import { db } from "../src/db";
import { workflows } from "../src/db/schema";
import { collaborationRepository } from "../src/features/workflow-runs/collaboration-repository";

const gateway = new CollaborationGateway();
// IMPORTANTE: a key é `ws.id` (string atribuída pelo Elysia no upgrade),
// NÃO o próprio `ws`. Elysia entrega proxies diferentes do `ws` em cada
// callback (open/message/close) — usar `ws` como key faz `Map.get` retornar
// undefined em message/close mesmo depois do open ter setado, derrubando
// toda conexão como "unauthorized" 2s depois.
const sockets = new Map<
  string,
  {
    userId?: string;
    role?: string;
    organizationId?: string;
    unsubscribe?: () => Promise<void>;
  }
>();

/** Monta um `Headers` a partir do record de headers do upgrade WS. */
function headersFromRecord(record: Record<string, string | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") headers.set(key, value);
  }
  return headers;
}

/**
 * Autoriza o acesso ao room verificando o JWT do Identity (federado). O token
 * chega no header `Authorization: Bearer` (endpoints HTTP) ou na query `?token=`
 * (handshake WS — browser não seta header em WebSocket). Confere ainda que o
 * workflow pertence à org ativa do token.
 */
async function authorize(token: string | null, workflowId: string) {
  if (!token) return null;
  let claims;
  try {
    claims = await authenticateToken(token);
  } catch (error) {
    if (error instanceof IdentityAuthError) return null;
    throw error;
  }
  const orgId = claims.organizationId;
  if (!orgId) return null;
  const role = claims.organizationRole ?? (await localMemberRole(orgId, claims.userId));
  if (!role) return null;
  const [workflow] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, orgId)))
    .limit(1);
  if (!workflow) return null;
  return { userId: claims.userId, organizationId: orgId, role };
}

const app = new Elysia({ name: "realtime-gateway" })
  .get("/health", async () => ({ ok: true, service: "realtime-gateway" }))
  .get(
    "/rooms/:workflowId/document",
    async ({ params, request, status }) => {
      const authz = await authorize(bearerToken(request.headers), params.workflowId);
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
      const authz = await authorize(bearerToken(request.headers), params.workflowId);
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
    // Token do Identity no handshake (browser não seta header em WebSocket).
    query: t.Object({ token: t.Optional(t.String()) }),
    body: t.Object({
      type: t.String(),
      userId: t.String(),
      cursor: t.Optional(t.Object({ x: t.Number(), y: t.Number() })),
      selectedNodeId: t.Optional(t.String()),
      // String vazia = release explícito (limpa o lock). Undefined = sem mudança.
      grabbedNodeId: t.Optional(t.String()),
      viewport: t.Optional(t.Object({ x: t.Number(), y: t.Number(), zoom: t.Number() })),
      updateBase64: t.Optional(t.String()),
    }),
    async open(ws) {
      const workflowId = ws.data.params.workflowId;
      // O JWT do Identity chega na query (`?token=`) — browsers não setam header
      // no upgrade de WebSocket. O Bearer no header segue aceito (clientes não-browser).
      const queryToken = ws.data.query?.token ?? null;
      const identityToken = queryToken ?? bearerToken(headersFromRecord(ws.data.headers));
      console.log("[ws] open attempt", {
        workflowId,
        hasToken: Boolean(identityToken),
        origin: ws.data.headers.origin,
      });
      const authz = await authorize(identityToken, workflowId);
      if (!authz) {
        console.log("[ws] unauthorized — closing", { workflowId });
        ws.send({ type: "error", error: "unauthorized" });
        ws.close();
        return;
      }
      const token = gateway.connectionToken();
      const unsubscribe = await gateway.subscribe(workflowId, (event) => {
        ws.send(event);
      });
      sockets.set(ws.id, { ...authz, unsubscribe });
      ws.send({ type: "room.ready", workflowId, connectionId: token });
      console.log("[ws] room.ready", { workflowId, userId: authz.userId, wsId: ws.id });
    },
    async message(ws, message) {
      const workflowId = ws.data.params.workflowId;
      const now = Date.now();
      // Espera até 2s o `open` async terminar de popular `sockets`. Sem isso,
      // mensagens que chegam entre o upgrade e o fim do authorize/subscribe
      // são tratadas como anônimas e o socket é derrubado (race observado em
      // prod: cliente envia user.joined logo após o upgrade, antes do server
      // completar `sockets.set(ws, …)`).
      let state = sockets.get(ws.id);
      if (!state?.userId) {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline && !sockets.get(ws.id)?.userId) {
          await new Promise((r) => setTimeout(r, 25));
        }
        state = sockets.get(ws.id);
      }
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
        // "" no wire = release (apaga o lock). Undefined preserva (nada
        // muda nessa mensagem).
        ...(message.grabbedNodeId !== undefined && {
          grabbedNodeId: message.grabbedNodeId === "" ? undefined : message.grabbedNodeId,
        }),
        viewport: message.viewport,
        updatedAt: now,
      };

      let event: AwarenessEvent | null = null;
      if (message.type === "user.joined") event = { type: "user.joined", workflowId, presence };
      else if (message.type === "cursor.move")
        event = { type: "cursor.move", workflowId, presence };
      else if (message.type === "node.selected")
        event = { type: "node.selected", workflowId, presence };
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
      const state = sockets.get(ws.id);
      const userId = state?.userId;
      console.log("[ws] close", { workflowId, userId, wsId: ws.id });
      if (typeof userId === "string" && userId.length > 0) {
        await gateway.removePresence(workflowId, userId);
        await gateway.publish({ type: "user.left", workflowId, userId });
      }
      await state?.unsubscribe?.();
      sockets.delete(ws.id);
    },
  });

// Resolução da porta:
//   1. REALTIME_PORT explícito (preferido em dev — API roda em PORT,
//      realtime em REALTIME_PORT, ambos no mesmo host)
//   2. PORT injetada pelo orquestrador (Railway/k8s) — em prod o service
//      realtime tem sua própria PORT exposta, não compartilha com a API
//
// Atenção: NÃO usar `PORT + 1` aqui. Em dev funciona por coincidência;
// em prod Railway só roteia tráfego pra `PORT`, então `PORT + 1` causa
// healthcheck timeout silencioso.
const realtimePort = Number(process.env.REALTIME_PORT ?? env.PORT);
// Bind explícito em 0.0.0.0 — orquestradores (Railway/k8s) executam
// healthcheck a partir de fora do loopback do container; default localhost
// faz o health passar em dev mas falhar silenciosamente em prod.
app.listen({ port: realtimePort, hostname: "0.0.0.0" });
console.log(`realtime gateway running on 0.0.0.0:${realtimePort}`);
