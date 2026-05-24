import { triggersRepository } from "../triggers/repository";
import { workflowsRepository } from "../workflows/repository";
import { diffDefinitions, type DefinitionDiff } from "./diff";
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
   * Diff entre duas versões publicadas. Não exige ordem cronológica —
   * `from` e `to` podem ser quaisquer versões do mesmo workflow.
   */
  async diff(
    organizationId: string,
    workflowId: string,
    fromVersionId: string,
    toVersionId: string,
  ) {
    const [from, to] = await Promise.all([
      workflowVersionsRepository.findById(organizationId, workflowId, fromVersionId),
      workflowVersionsRepository.findById(organizationId, workflowId, toVersionId),
    ]);
    if (!from || !to) return { error: "version_not_found" as const };

    const diff: DefinitionDiff = diffDefinitions(
      from.definition as Record<string, unknown>,
      to.definition as Record<string, unknown>,
    );

    return {
      from: { id: from.id, version: from.version, name: from.name, createdAt: from.createdAt },
      to: { id: to.id, version: to.version, name: to.name, createdAt: to.createdAt },
      diff,
    };
  },

  /**
   * Renomeia uma versão publicada. Só o `name` é mutável — `definition`
   * continua imutável. Útil pra dar nome humano post-hoc
   * ("v17 — release Black Friday").
   */
  async rename(
    organizationId: string,
    workflowId: string,
    versionId: string,
    name: string | null,
  ) {
    const existing = await workflowVersionsRepository.findById(
      organizationId,
      workflowId,
      versionId,
    );
    if (!existing) return { error: "version_not_found" as const };

    const updated = await workflowVersionsRepository.rename(workflowId, versionId, name);
    if (!updated) return { error: "version_not_found" as const };
    return {
      version: updated,
      previousName: existing.name,
    };
  },

  /**
   * Restaura uma versão como o `definition` corrente do workflow (draft).
   * NÃO promove triggers nem publica nova versão — o usuário pode editar
   * mais antes de publicar. Se publicar sem mudanças, a idempotência do
   * `publish` reusa a versão restaurada.
   */
  async restore(organizationId: string, workflowId: string, versionId: string) {
    const version = await workflowVersionsRepository.findById(
      organizationId,
      workflowId,
      versionId,
    );
    if (!version) return { error: "version_not_found" as const };

    const updated = await workflowsRepository.update(organizationId, workflowId, {
      definition: version.definition as Record<string, unknown>,
    });
    if (!updated) return { error: "workflow_not_found" as const };

    return { workflow: updated, version };
  },

  /**
   * Bulk promote: aponta N triggers do workflow para a mesma versão em
   * uma única atualização. Quando `triggerIds` é omitido, alvo é TODOS
   * os triggers do workflow.
   *
   * Garante:
   * - Versão pertence ao workflow (1 checagem, não N).
   * - Todos os triggerIds existem e pertencem ao workflow (rejeita o lote
   *   se algum não bater).
   */
  async promoteBulk(
    organizationId: string,
    workflowId: string,
    workflowVersionId: string,
    triggerIds: string[] | undefined,
  ) {
    const workflow = await workflowsRepository.findById(organizationId, workflowId);
    if (!workflow) return { error: "workflow_not_found" as const };

    const version = await workflowVersionsRepository.findById(
      organizationId,
      workflowId,
      workflowVersionId,
    );
    if (!version) return { error: "workflow_version_not_found" as const };

    const allTriggers = await triggersRepository.list({ organizationId, workflowId });
    const allIds = new Set(allTriggers.map((t) => t.id));

    const targetIds = triggerIds && triggerIds.length > 0 ? triggerIds : Array.from(allIds);

    if (targetIds.length === 0) {
      return { promoted: [], version };
    }

    // Rejeita o lote inteiro se algum id não pertence ao workflow — evita
    // promoções parciais silenciosas.
    for (const id of targetIds) {
      if (!allIds.has(id)) return { error: "trigger_not_found" as const };
    }

    const promoted = await triggersRepository.bulkUpdateVersion(
      organizationId,
      workflowId,
      targetIds,
      workflowVersionId,
    );

    return { promoted, version };
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
