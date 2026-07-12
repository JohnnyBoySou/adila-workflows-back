import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { type NewWorkflowVersion, workflowVersions, workflows } from "../../db/schema";

/**
 * Serializa recursivamente com chaves ordenadas em todos os níveis.
 * Determinístico: mesma estrutura → mesma string, independente de ordem de inserção.
 */
function stableStringify(val: unknown): string {
  if (val === null || typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  const keys = Object.keys(val as object).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((val as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  );
}

/** SHA-256 do definition com chaves ordenadas recursivamente. */
export function hashDefinition(definition: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(definition)).digest("hex");
}

export const workflowVersionsRepository = {
  async list(organizationId: string, workflowId: string) {
    return db
      .select({
        id: workflowVersions.id,
        workflowId: workflowVersions.workflowId,
        version: workflowVersions.version,
        name: workflowVersions.name,
        definition: workflowVersions.definition,
        createdBy: workflowVersions.createdBy,
        createdAt: workflowVersions.createdAt,
      })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(
        and(
          eq(workflowVersions.workflowId, workflowId),
          eq(workflows.organizationId, organizationId),
        ),
      )
      .orderBy(desc(workflowVersions.version));
  },

  async findById(organizationId: string, workflowId: string, id: string) {
    const [row] = await db
      .select({
        id: workflowVersions.id,
        workflowId: workflowVersions.workflowId,
        version: workflowVersions.version,
        name: workflowVersions.name,
        definition: workflowVersions.definition,
        createdBy: workflowVersions.createdBy,
        createdAt: workflowVersions.createdAt,
      })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(
        and(
          eq(workflowVersions.id, id),
          eq(workflowVersions.workflowId, workflowId),
          eq(workflows.organizationId, organizationId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  /** Sem checagem de org — usado pelo worker, que confia no payload do job. */
  async findByIdRaw(id: string) {
    const [row] = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, id))
      .limit(1);
    return row ?? null;
  },

  async findLatest(workflowId: string) {
    const [row] = await db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowId))
      .orderBy(desc(workflowVersions.version))
      .limit(1);
    return row ?? null;
  },

  /**
   * Cria a próxima versão monotônica. SQL subquery calcula `MAX(version) + 1`
   * em uma única ida ao banco — single statement, ainda corre risco de
   * colisão sob concorrência, mas o índice único (workflow_id, version)
   * faz o segundo insert falhar e o caller retenta se quiser.
   */
  /**
   * Renomeia uma versão. `name = null` remove o rótulo. Único campo
   * mutável — `definition` permanece imutável.
   */
  async rename(workflowId: string, id: string, name: string | null) {
    const [row] = await db
      .update(workflowVersions)
      .set({ name })
      .where(and(eq(workflowVersions.id, id), eq(workflowVersions.workflowId, workflowId)))
      .returning();
    return row ?? null;
  },

  /**
   * Remove uma versão. Escopo por `workflowId` — a checagem de org já foi
   * feita pelo caller via `findById` (join com workflows). Devolve a linha
   * removida (id/version/name) ou null se nada casou.
   */
  async remove(workflowId: string, id: string) {
    const [row] = await db
      .delete(workflowVersions)
      .where(and(eq(workflowVersions.id, id), eq(workflowVersions.workflowId, workflowId)))
      .returning({
        id: workflowVersions.id,
        version: workflowVersions.version,
        name: workflowVersions.name,
      });
    return row ?? null;
  },

  async create(data: Omit<NewWorkflowVersion, "version" | "definitionHash">) {
    const [row] = await db
      .insert(workflowVersions)
      .values({
        ...data,
        definitionHash: hashDefinition(data.definition),
        version: sql<number>`COALESCE((
          SELECT MAX(${workflowVersions.version}) + 1
          FROM ${workflowVersions}
          WHERE ${workflowVersions.workflowId} = ${data.workflowId}
        ), 1)`,
      })
      .returning();
    return row!;
  },
};
