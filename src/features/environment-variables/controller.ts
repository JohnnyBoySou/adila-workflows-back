import type { EnvironmentVariable } from "../../db/schema";
import { environmentsRepository } from "../environments/repository";
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

  async list(organizationId: string, environmentId: string, reveal = false) {
    const rows = await environmentVariablesRepository.list(organizationId, environmentId);
    return reveal ? rows : rows.map(maskSecret);
  },

  async findById(organizationId: string, environmentId: string, id: string, reveal = false) {
    const row = await environmentVariablesRepository.findById(organizationId, environmentId, id);
    if (!row) return null;
    return reveal ? row : maskSecret(row);
  },

  async create(organizationId: string, environmentId: string, body: CreateVariableBody) {
    const existing = await environmentVariablesRepository.findByKey(
      organizationId,
      environmentId,
      body.key,
    );
    if (existing) return { error: "key_taken" as const };

    const created = await environmentVariablesRepository.create({
      organizationId,
      environmentId,
      key: body.key,
      value: body.value,
      isSecret: body.isSecret ?? false,
    });
    return { variable: maskSecret(created) };
  },

  async update(
    organizationId: string,
    environmentId: string,
    id: string,
    body: UpdateVariableBody,
  ) {
    const updated = await environmentVariablesRepository.update(organizationId, environmentId, id, {
      ...(body.value !== undefined && { value: body.value }),
      ...(body.isSecret !== undefined && { isSecret: body.isSecret }),
    });
    if (!updated) return null;
    return maskSecret(updated);
  },

  remove(organizationId: string, environmentId: string, id: string) {
    return environmentVariablesRepository.remove(organizationId, environmentId, id);
  },

  /** Usado pelo worker — devolve um objeto { KEY: value } pronto pra injetar. */
  async resolveForRun(organizationId: string, environmentId: string) {
    const rows = await environmentVariablesRepository.list(organizationId, environmentId);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
};
