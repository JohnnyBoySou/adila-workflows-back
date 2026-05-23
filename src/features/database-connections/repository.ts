import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  databaseConnections,
  type DatabaseConnection,
  type DatabaseConnectionKind,
  type NewDatabaseConnection,
  workflows,
} from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";

// ── encrypt/decrypt na fronteira do repositório ────────────────────────
// O resto da aplicação trabalha com `connectionString` em texto puro; o
// repositório cifra na escrita e decifra na leitura. A API HTTP nunca
// expõe o campo decifrado (o controller filtra), então o "raw" só roda
// dentro do worker via `resolveForRun`.

export interface DecryptedConnection extends Omit<DatabaseConnection, "encryptedConnectionString"> {
  connectionString: string;
}

function decryptRow(row: DatabaseConnection): DecryptedConnection {
  const { encryptedConnectionString, ...rest } = row;
  return { ...rest, connectionString: decrypt(encryptedConnectionString) };
}

export interface ListConnectionsFilters {
  workflowId: string;
  kind?: DatabaseConnectionKind;
  /** undefined = qualquer env. null = só defaults. string = env específico. */
  environmentId?: string | null;
}

export const databaseConnectionsRepository = {
  /**
   * Confere se o workflow existe e pertence à org antes de listar/escrever.
   * Centraliza a validação de ownership pra não duplicar em cada handler.
   */
  async ensureWorkflow(organizationId: string, workflowId: string) {
    const [row] = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
      .limit(1);
    return row ?? null;
  },

  async list({ workflowId, kind, environmentId }: ListConnectionsFilters) {
    const conditions = [eq(databaseConnections.workflowId, workflowId)];
    if (kind) conditions.push(eq(databaseConnections.kind, kind));
    if (environmentId === null) {
      conditions.push(isNull(databaseConnections.environmentId));
    } else if (typeof environmentId === "string") {
      conditions.push(eq(databaseConnections.environmentId, environmentId));
    }
    const rows = await db
      .select()
      .from(databaseConnections)
      .where(and(...conditions))
      .orderBy(asc(databaseConnections.name));
    return rows.map(decryptRow);
  },

  async findById(workflowId: string, id: string) {
    const [row] = await db
      .select()
      .from(databaseConnections)
      .where(and(eq(databaseConnections.id, id), eq(databaseConnections.workflowId, workflowId)))
      .limit(1);
    return row ? decryptRow(row) : null;
  },

  /** Lookup pelo nome — usado pelos handlers e pra rejeitar duplicatas. */
  async findByName(workflowId: string, name: string, environmentId: string | null) {
    const [row] = await db
      .select()
      .from(databaseConnections)
      .where(
        and(
          eq(databaseConnections.workflowId, workflowId),
          eq(databaseConnections.name, name),
          environmentId === null
            ? isNull(databaseConnections.environmentId)
            : eq(databaseConnections.environmentId, environmentId),
        ),
      )
      .limit(1);
    return row ? decryptRow(row) : null;
  },

  async create(data: {
    workflowId: string;
    environmentId: string | null;
    name: string;
    kind: DatabaseConnectionKind;
    connectionString: string;
    createdBy: string;
  }): Promise<DecryptedConnection> {
    const insert: NewDatabaseConnection = {
      workflowId: data.workflowId,
      environmentId: data.environmentId,
      name: data.name,
      kind: data.kind,
      encryptedConnectionString: encrypt(data.connectionString),
      createdBy: data.createdBy,
    };
    const [row] = await db.insert(databaseConnections).values(insert).returning();
    return decryptRow(row!);
  },

  async update(
    workflowId: string,
    id: string,
    patch: {
      name?: string;
      environmentId?: string | null;
      connectionString?: string;
    },
  ) {
    const writePatch: Partial<NewDatabaseConnection> = {};
    if (patch.name !== undefined) writePatch.name = patch.name;
    if (patch.environmentId !== undefined) writePatch.environmentId = patch.environmentId;
    if (patch.connectionString !== undefined) {
      writePatch.encryptedConnectionString = encrypt(patch.connectionString);
    }
    if (Object.keys(writePatch).length === 0) {
      // Nada pra atualizar — devolve a linha atual.
      return this.findById(workflowId, id);
    }
    const [row] = await db
      .update(databaseConnections)
      .set({ ...writePatch, updatedAt: new Date() })
      .where(and(eq(databaseConnections.id, id), eq(databaseConnections.workflowId, workflowId)))
      .returning();
    return row ? decryptRow(row) : null;
  },

  async remove(workflowId: string, id: string) {
    const [row] = await db
      .delete(databaseConnections)
      .where(and(eq(databaseConnections.id, id), eq(databaseConnections.workflowId, workflowId)))
      .returning({ id: databaseConnections.id });
    return row ?? null;
  },

  /**
   * Resolve a connection que um node deve usar em runtime — lookup direto
   * pelo id (workflow-scoped). Mantemos um helper aqui pra deixar
   * explícito que o caller é o worker, não a API HTTP.
   */
  resolve(workflowId: string, connectionId: string): Promise<DecryptedConnection | null> {
    return this.findById(workflowId, connectionId);
  },
};
