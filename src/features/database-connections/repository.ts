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

  // Heurística simples — UUID v4 do Postgres tem 36 chars com hífens nas
  // posições canônicas. Suficiente pra distinguir do nome lógico ("db_main")
  // que o usuário pode digitar/escolher no editor.
  isUuid(ref: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
  },

  /**
   * Resolve a connection que um node deve usar em runtime.
   *
   * Aceita dois tipos de referência (`ref`):
   *  - UUID — modo legado, pinned numa linha específica (env já cravado pela
   *    linha; ignora `environmentId` do run).
   *  - Nome lógico (`"db_main"`) — modo novo, indireção por nome. Tenta achar
   *    override pro env do run; cai em fallback default (`environmentId IS
   *    NULL`) se não houver. Isso é o que permite promover a mesma versão
   *    entre envs sem reescrever a definition.
   *
   * Retorna null em ambos os casos quando nada bate — handler do node
   * decide se isso é fatal (postgres/redis lançam, dry-run pode tolerar).
   */
  async resolve(
    workflowId: string,
    ref: string,
    environmentId: string | null,
  ): Promise<DecryptedConnection | null> {
    if (this.isUuid(ref)) {
      return this.findById(workflowId, ref);
    }
    // Modo nome: override por env vence; fallback NULL é a "default" do
    // workflow. Dois lookups separados (em vez de uma query com ORDER BY)
    // mantém o caminho legível e usa o índice unique (workflow, env, name).
    if (environmentId) {
      const override = await this.findByName(workflowId, ref, environmentId);
      if (override) return override;
    }
    return this.findByName(workflowId, ref, null);
  },
};
