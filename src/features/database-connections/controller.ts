import { Redis } from "ioredis";
import postgres from "postgres";
import { env } from "../../config/env";
import type { DatabaseConnectionKind } from "../../db/schema";
import { environmentsRepository } from "../environments/repository";
import { fetchPostgresSchema, invalidateIntrospection } from "./introspection";
import { databaseConnectionsRepository, type DecryptedConnection } from "./repository";
import type { CreateConnectionBody, UpdateConnectionBody } from "./schema";

// ── Saneamento ────────────────────────────────────────────────────────
//
// Nunca devolvemos a connection string em texto puro pela API HTTP. O
// frontend exibe apenas metadata; secrets ficam exclusivamente do lado
// do worker (via `resolveForRun`).

export interface SafeConnection {
  id: string;
  workflowId: string;
  environmentId: string | null;
  name: string;
  kind: DatabaseConnectionKind;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

function toSafe(row: DecryptedConnection): SafeConnection {
  const { connectionString: _, ...safe } = row;
  return safe;
}

// ── Validação de connection string ─────────────────────────────────────

/** Normaliza pra comparar URLs ignorando query/trailing slash. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}@${u.hostname}:${u.port || "default"}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url.trim();
  }
}

function isAppOwnedUrl(url: string, kind: DatabaseConnectionKind): boolean {
  const target = normalizeUrl(url);
  if (kind === "postgres") return target === normalizeUrl(env.DATABASE_URL);
  return target === normalizeUrl(env.REDIS_URL);
}

function validateProtocol(url: string, kind: DatabaseConnectionKind): boolean {
  const trimmed = url.trim();
  if (kind === "postgres") {
    return trimmed.startsWith("postgres://") || trimmed.startsWith("postgresql://");
  }
  return trimmed.startsWith("redis://") || trimmed.startsWith("rediss://");
}

// ── Test connection ────────────────────────────────────────────────────

interface TestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

async function testPostgres(connectionString: string, timeoutMs = 5000): Promise<TestResult> {
  const start = Date.now();
  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: Math.ceil(timeoutMs / 1000),
    idle_timeout: 1,
    onnotice: () => {},
  });
  try {
    await Promise.race([
      client`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout após ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start, message: "conectou" };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, message: (err as Error).message };
  } finally {
    await client.end({ timeout: 1 }).catch(() => {});
  }
}

async function testRedis(connectionString: string, timeoutMs = 5000): Promise<TestResult> {
  const start = Date.now();
  // lazyConnect=true: só conecta no comando, evita reconexão infinita em URL ruim.
  const client = new Redis(connectionString, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: timeoutMs,
    enableOfflineQueue: false,
  });
  try {
    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`timeout após ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    return { ok: true, latencyMs: Date.now() - start, message: "conectou" };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - start, message: (err as Error).message };
  } finally {
    client.disconnect();
  }
}

// ── Controller ─────────────────────────────────────────────────────────

export const databaseConnectionsController = {
  ensureWorkflow: databaseConnectionsRepository.ensureWorkflow,

  async list(
    workflowId: string,
    filters: { kind?: DatabaseConnectionKind; environmentId?: string | null },
  ) {
    const rows = await databaseConnectionsRepository.list({ workflowId, ...filters });
    return rows.map(toSafe);
  },

  async findById(workflowId: string, id: string) {
    const row = await databaseConnectionsRepository.findById(workflowId, id);
    return row ? toSafe(row) : null;
  },

  async create(
    organizationId: string,
    workflowId: string,
    userId: string,
    body: CreateConnectionBody,
  ) {
    if (!validateProtocol(body.connectionString, body.kind)) {
      return { error: "invalid_protocol" as const };
    }
    if (isAppOwnedUrl(body.connectionString, body.kind)) {
      return { error: "app_owned_url" as const };
    }

    const envId = body.environmentId ?? null;
    if (envId) {
      const envRow = await environmentsRepository.findById(organizationId, envId);
      if (!envRow) return { error: "environment_not_found" as const };
    }

    const dup = await databaseConnectionsRepository.findByName(workflowId, body.name, envId);
    if (dup) return { error: "name_taken" as const };

    const created = await databaseConnectionsRepository.create({
      workflowId,
      environmentId: envId,
      name: body.name,
      kind: body.kind,
      connectionString: body.connectionString,
      createdBy: userId,
    });
    return { connection: toSafe(created) };
  },

  async update(
    organizationId: string,
    workflowId: string,
    id: string,
    body: UpdateConnectionBody,
  ) {
    const existing = await databaseConnectionsRepository.findById(workflowId, id);
    if (!existing) return { error: "not_found" as const };

    if (body.connectionString !== undefined) {
      if (!validateProtocol(body.connectionString, existing.kind)) {
        return { error: "invalid_protocol" as const };
      }
      if (isAppOwnedUrl(body.connectionString, existing.kind)) {
        return { error: "app_owned_url" as const };
      }
    }

    const nextEnvId =
      body.environmentId !== undefined ? (body.environmentId ?? null) : existing.environmentId;
    if (body.environmentId !== undefined && nextEnvId) {
      const envRow = await environmentsRepository.findById(organizationId, nextEnvId);
      if (!envRow) return { error: "environment_not_found" as const };
    }

    const nextName = body.name ?? existing.name;
    // Reverifica unicidade quando (name, env) mudou.
    if (body.name !== undefined || body.environmentId !== undefined) {
      const dup = await databaseConnectionsRepository.findByName(workflowId, nextName, nextEnvId);
      if (dup && dup.id !== id) return { error: "name_taken" as const };
    }

    const updated = await databaseConnectionsRepository.update(workflowId, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.environmentId !== undefined && { environmentId: nextEnvId }),
      ...(body.connectionString !== undefined && { connectionString: body.connectionString }),
    });
    if (!updated) return { error: "not_found" as const };
    // Schema cache fica obsoleto quando a URL muda — invalida pra forçar refetch.
    if (body.connectionString !== undefined) invalidateIntrospection(id);
    return { connection: toSafe(updated) };
  },

  async remove(workflowId: string, id: string) {
    const result = await databaseConnectionsRepository.remove(workflowId, id);
    if (result) invalidateIntrospection(id);
    return result;
  },

  /**
   * Faz um ping rápido contra o banco. Não persiste resultado — o frontend
   * mostra o status na hora. Usa a string em texto puro decifrada via repo.
   */
  async test(workflowId: string, id: string): Promise<{ error: string } | TestResult> {
    const row = await databaseConnectionsRepository.findById(workflowId, id);
    if (!row) return { error: "not_found" };
    if (row.kind === "postgres") return testPostgres(row.connectionString);
    return testRedis(row.connectionString);
  },

  /**
   * Lista tabelas + colunas via information_schema. Cache em memória (5 min);
   * `?refresh=true` força refetch — útil quando o usuário acabou de migrar.
   */
  async schema(workflowId: string, id: string, opts: { force?: boolean } = {}) {
    const row = await databaseConnectionsRepository.findById(workflowId, id);
    if (!row) return { error: "not_found" as const };
    if (row.kind !== "postgres") return { error: "not_supported_for_kind" as const };
    try {
      const result = await fetchPostgresSchema(row.id, row.connectionString, opts);
      return { schema: result };
    } catch (err) {
      return { error: "introspection_failed" as const, message: (err as Error).message };
    }
  },
};
