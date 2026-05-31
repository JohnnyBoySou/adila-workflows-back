import type { EnvironmentVariable } from "../../db/schema";
import { environmentsRepository } from "../environments/repository";
import { workflowsRepository } from "../workflows/repository";
import { environmentVariablesRepository } from "./repository";
import type { CreateVariableBody, UpdateVariableBody } from "./schema";

const SECRET_MASK = "********";

/** Devolve a row com o value mascarado quando isSecret=true. */
export function maskSecret(row: EnvironmentVariable): EnvironmentVariable {
  return row.isSecret ? { ...row, value: SECRET_MASK } : row;
}

export const environmentVariablesController = {
  async ensureEnvironment(organizationId: string, environmentId: string) {
    return environmentsRepository.findById(organizationId, environmentId);
  },

  async ensureWorkflow(organizationId: string, workflowId: string) {
    return workflowsRepository.findById(organizationId, workflowId);
  },

  async list(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    reveal = false,
  ) {
    const rows = await environmentVariablesRepository.list(organizationId, environmentId, workflowId);
    return reveal ? rows : rows.map(maskSecret);
  },

  async findById(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    id: string,
    reveal = false,
  ) {
    const row = await environmentVariablesRepository.findById(
      organizationId,
      environmentId,
      workflowId,
      id,
    );
    if (!row) return null;
    return reveal ? row : maskSecret(row);
  },

  async create(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    body: CreateVariableBody,
  ) {
    const existing = await environmentVariablesRepository.findByKey(
      organizationId,
      environmentId,
      workflowId,
      body.key,
    );
    if (existing) return { error: "key_taken" as const };

    const created = await environmentVariablesRepository.create({
      organizationId,
      environmentId,
      workflowId,
      key: body.key,
      value: body.value,
      isSecret: body.isSecret ?? false,
    });
    return { variable: maskSecret(created) };
  },

  async update(
    organizationId: string,
    environmentId: string,
    workflowId: string | null,
    id: string,
    body: UpdateVariableBody,
  ) {
    const updated = await environmentVariablesRepository.update(
      organizationId,
      environmentId,
      workflowId,
      id,
      {
        ...(body.value !== undefined && { value: body.value }),
        ...(body.isSecret !== undefined && { isSecret: body.isSecret }),
      },
    );
    if (!updated) return null;
    return maskSecret(updated);
  },

  remove(organizationId: string, environmentId: string, workflowId: string | null, id: string) {
    return environmentVariablesRepository.remove(organizationId, environmentId, workflowId, id);
  },

  /**
   * Usado pelo worker — devolve um objeto { KEY: value } pronto pra injetar.
   * Resolução em camadas: variáveis da org (workflowId NULL) são a base e as
   * do workflow sobrepõem por key. Sem workflowId, devolve só as da org.
   */
  async resolveForRun(organizationId: string, environmentId: string, workflowId?: string | null) {
    const orgRows = await environmentVariablesRepository.list(organizationId, environmentId, null);
    const merged = new Map(orgRows.map((r) => [r.key, r.value]));
    if (workflowId) {
      const wfRows = await environmentVariablesRepository.list(
        organizationId,
        environmentId,
        workflowId,
      );
      for (const r of wfRows) merged.set(r.key, r.value);
    }
    return Object.fromEntries(merged);
  },
};
