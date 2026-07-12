/**
 * Resume, pra fins de auditoria, o que mudou num PATCH de workflow.
 *
 * Serve o audit log `workflow.updated`: em vez de gravar só as chaves do body
 * (`changedKeys`), grava exatamente O QUE mudou — campos escalares com valor
 * antigo→novo e um diff estruturado da `definition` (nós/edges).
 *
 * Política de dados sensíveis: NÃO gravamos valores de config de nó, só os
 * caminhos que mudaram (ex.: `config.headers.authorization`). Config pode
 * conter segredos/tokens; o path já responde "o que o usuário mexeu" sem
 * vazar o valor. Ver [[workflow-audit-trail]].
 */
import { diffDefinitions, type DefinitionDiff } from "../workflow-versions/diff";
import type { UpdateWorkflowBody } from "./schema";

type WorkflowRow = {
  name: string;
  description: string | null;
  status: string;
  folderId: string | null;
  definition: Record<string, unknown>;
};

/** Mudança de um campo escalar — valores são seguros (não são segredos). */
type FieldChange = { from: unknown; to: unknown };

export type WorkflowChangeSummary = {
  /** Campos escalares alterados (name/status/folderId) com from→to. */
  fields: Record<string, FieldChange>;
  /** Description mudou? Não gravamos o texto (pode ser longo). */
  descriptionChanged: boolean;
  /** Diff da definição — presente só quando houve mudança estrutural real. */
  definitionDiff?: DefinitionDiff;
};

function isEmptyDefinitionDiff(d: DefinitionDiff): boolean {
  return (
    d.nodes.added.length === 0 &&
    d.nodes.removed.length === 0 &&
    d.nodes.changed.length === 0 &&
    d.edges.added === 0 &&
    d.edges.removed === 0
  );
}

/**
 * Compara o workflow antes/depois considerando só os campos que o `body`
 * tocou — um PATCH que não envia `status` não deve registrar mudança de
 * status mesmo que o valor tenha sido reescrito igual.
 */
export function summarizeWorkflowChanges(
  before: WorkflowRow,
  after: WorkflowRow,
  body: UpdateWorkflowBody,
): WorkflowChangeSummary {
  const fields: Record<string, FieldChange> = {};

  if (body.name !== undefined && before.name !== after.name) {
    fields.name = { from: before.name, to: after.name };
  }
  if (body.status !== undefined && before.status !== after.status) {
    fields.status = { from: before.status, to: after.status };
  }
  if (body.folderId !== undefined && before.folderId !== after.folderId) {
    fields.folderId = { from: before.folderId, to: after.folderId };
  }

  const descriptionChanged =
    body.description !== undefined && before.description !== after.description;

  let definitionDiff: DefinitionDiff | undefined;
  if (body.definition !== undefined) {
    const diff = diffDefinitions(before.definition ?? {}, after.definition ?? {});
    // Reposicionar nós no canvas não conta como mudança (diff ignora position).
    if (!isEmptyDefinitionDiff(diff)) definitionDiff = diff;
  }

  return { fields, descriptionChanged, definitionDiff };
}

/**
 * `true` quando o PATCH não produziu nenhuma mudança auditável (ex.: só moveu
 * nós no canvas, ou reenviou os mesmos valores). Deixa o router decidir se
 * registra ou não a linha de audit.
 */
export function hasAuditableChange(summary: WorkflowChangeSummary): boolean {
  return (
    Object.keys(summary.fields).length > 0 ||
    summary.descriptionChanged ||
    summary.definitionDiff !== undefined
  );
}
