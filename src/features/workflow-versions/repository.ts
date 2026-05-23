import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { type NewWorkflowVersion, workflowVersions, workflows } from "../../db/schema";

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
  async create(data: Omit<NewWorkflowVersion, "version">) {
    const [row] = await db
      .insert(workflowVersions)
      .values({
        ...data,
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
