import { workflowsRepository } from "../workflows/repository";
import { hashDefinition, workflowVersionsRepository } from "./repository";
import type { PublishVersionBody } from "./schema";

export const workflowVersionsController = {
  async list(organizationId: string, workflowId: string) {
    const workflow = await workflowsRepository.findById(organizationId, workflowId);
    if (!workflow) return { error: "workflow_not_found" as const };
    return { versions: await workflowVersionsRepository.list(organizationId, workflowId) };
  },

  findById(organizationId: string, workflowId: string, versionId: string) {
    return workflowVersionsRepository.findById(organizationId, workflowId, versionId);
  },

  /**
   * Publica uma nova versão imutável a partir do `definition` atual do workflow.
   * Idempotente: sem `body.name` explícito, se o draft for byte-idêntico à
   * última versão publicada (mesmo hash), reutiliza ela sem criar nova linha.
   * Com `body.name` sempre cria — o usuário quer registrar um marco nomeado.
   */
  async publish(
    organizationId: string,
    workflowId: string,
    userId: string,
    body: PublishVersionBody | null,
  ) {
    const workflow = await workflowsRepository.findById(organizationId, workflowId);
    if (!workflow) return { error: "workflow_not_found" as const };

    if (!body?.name) {
      const latest = await workflowVersionsRepository.findLatest(workflowId);
      if (latest?.definitionHash === hashDefinition(workflow.definition)) {
        return { version: latest, alreadyExisted: true as const };
      }
    }

    const version = await workflowVersionsRepository.create({
      workflowId,
      name: body?.name ?? null,
      definition: workflow.definition,
      createdBy: userId,
    });
    return { version, alreadyExisted: false as const };
  },

  /**
   * Garante uma versão para um run: se o workflow ainda não tem nenhuma,
   * publica a versão 1 com o draft atual; caso contrário, devolve a latest.
   * Quem chama é o controller de run — não expõe direto na API.
   *
   * `fallbackUserId` é usado quando o disparo é anônimo (webhook/cron):
   * cai no `createdBy` original do workflow para satisfazer o FK.
   */
  async ensureLatest(
    workflowId: string,
    userId: string | null,
    definition: Record<string, unknown>,
    fallbackUserId: string,
  ) {
    const latest = await workflowVersionsRepository.findLatest(workflowId);
    if (latest) return latest;
    return workflowVersionsRepository.create({
      workflowId,
      name: "auto-published",
      definition,
      createdBy: userId ?? fallbackUserId,
    });
  },
};
