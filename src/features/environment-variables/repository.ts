import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { db } from "../../db";
import {
  environmentVariables,
  type EnvironmentVariable,
  type NewEnvironmentVariable,
} from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";

// ── encrypt/decrypt na fronteira do repositório ────────────────────────
// O resto da aplicação sempre vê `value` em texto puro; a cifragem fica
// confinada aqui pra não precisar lembrar dela em cada caller.

function decryptRow(row: EnvironmentVariable): EnvironmentVariable {
  if (!row.isSecret) return row;
  return { ...row, value: decrypt(row.value) };
}

// Filtro de escopo: NULL = variáveis da org; uuid = variáveis do workflow.
// Postgres compara NULL como distinto em `=`, então precisamos do `isNull`.
function scopeWorkflow(workflowId: string | null): SQL {
  return workflowId === null
    ? isNull(environmentVariables.workflowId)
    : eq(environmentVariables.workflowId, workflowId);
}

export const environmentVariablesRepository = {
  async list(organizationId: string, environmentId: string, workflowId: string | null) {
    const rows = await db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.organizationId, organizationId),
          eq(environmentVariables.environmentId, environmentId),
          scopeWorkflow(workflowId),
        ),
      )
      .orderBy(asc(environmentVariables.key));
    return rows.map(decryptRow);
  },

  async findById(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    id: string,
  ) {
    const [row] = await db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.id, id),
          eq(environmentVariables.environmentId, environmentId),
          eq(environmentVariables.organizationId, organizationId),
          scopeWorkflow(workflowId),
        ),
      )
      .limit(1);
    return row ? decryptRow(row) : null;
  },

  async findByKey(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    key: string,
  ) {
    const [row] = await db
      .select()
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.organizationId, organizationId),
          eq(environmentVariables.environmentId, environmentId),
          eq(environmentVariables.key, key),
          scopeWorkflow(workflowId),
        ),
      )
      .limit(1);
    return row ? decryptRow(row) : null;
  },

  async create(data: NewEnvironmentVariable) {
    const payload =
      data.isSecret && data.value !== undefined ? { ...data, value: encrypt(data.value) } : data;
    const [row] = await db.insert(environmentVariables).values(payload).returning();
    return decryptRow(row!);
  },

  async update(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    id: string,
    patch: Partial<NewEnvironmentVariable>,
  ) {
    // Pra decidir se cifrar, precisamos do estado final de isSecret.
    // Lê o existente quando `patch.isSecret` veio undefined.
    let finalIsSecret = patch.isSecret;
    if (finalIsSecret === undefined && patch.value !== undefined) {
      const [existing] = await db
        .select({ isSecret: environmentVariables.isSecret })
        .from(environmentVariables)
        .where(
          and(
            eq(environmentVariables.id, id),
            eq(environmentVariables.environmentId, environmentId),
            eq(environmentVariables.organizationId, organizationId),
            scopeWorkflow(workflowId),
          ),
        )
        .limit(1);
      finalIsSecret = existing?.isSecret;
    }

    const writePatch: Partial<NewEnvironmentVariable> = { ...patch };
    if (patch.value !== undefined && finalIsSecret) {
      writePatch.value = encrypt(patch.value);
    }

    const [row] = await db
      .update(environmentVariables)
      .set({ ...writePatch, updatedAt: new Date() })
      .where(
        and(
          eq(environmentVariables.id, id),
          eq(environmentVariables.environmentId, environmentId),
          eq(environmentVariables.organizationId, organizationId),
          scopeWorkflow(workflowId),
        ),
      )
      .returning();
    return row ? decryptRow(row) : null;
  },

  async remove(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    id: string,
  ) {
    const [row] = await db
      .delete(environmentVariables)
      .where(
        and(
          eq(environmentVariables.id, id),
          eq(environmentVariables.environmentId, environmentId),
          eq(environmentVariables.organizationId, organizationId),
          scopeWorkflow(workflowId),
        ),
      )
      .returning({ id: environmentVariables.id });
    return row ?? null;
  },
};
