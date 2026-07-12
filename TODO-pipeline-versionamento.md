# Pipeline de Versionamento e Promoção — TODO Backend

> Contexto: Passos A (resolver por nome com fallback de env) e B (pin de versão
> por trigger + endpoint promote) já foram entregues nesta sessão (2026-05-23).
> Este arquivo lista o que **ainda falta no backend** pra fechar o ciclo
> profissional `publicar → promover → rollback → diff` com robustez.
>
> O TODO complementar do frontend está em `front/TODO-pipeline-versionamento.md`.

---

## 🔴 P0 — Críticos pra robustez do pipeline

### 1. Idempotência do `publish`

**Problema atual** (`features/workflow-versions/controller.ts:20`):

```ts
async publish(organizationId, workflowId, userId, body) {
  const workflow = await workflowsRepository.findById(...);
  const version = await workflowVersionsRepository.create({
    workflowId,
    definition: workflow.definition,  // ← cria SEMPRE
    ...
  });
  return { version };
}
```

Cada clique em "Publicar versão" cria uma linha nova, mesmo se a `definition`
for byte-idêntica à versão anterior. Isso polui a timeline com `v17, v18, v19`
todas iguais.

**Solução**:

1. Antes de criar, buscar `latest` via `workflowVersionsRepository.findLatest(workflowId)`.
2. Comparar `latest.definition` com `workflow.definition` via hash estável
   (ordenar chaves recursivamente + `crypto.createHash("sha256")`).
3. Se igual:
   - Sem `body.name`: retornar a `latest` com flag `{ version, alreadyExisted: true }`.
   - Com `body.name`: ainda criar (o usuário quer nomear o snapshot mesmo idêntico).
4. Router devolve 200 + `alreadyExisted: true` em vez de 201 quando reusou.

**Bônus**: armazenar o hash como coluna `definition_hash text` na tabela
`workflow_versions` (com index único composto `(workflow_id, definition_hash)`
quando `name IS NULL`) — permite a comparação ser O(1) e dá audit grátis.

Migration: `ALTER TABLE workflow_versions ADD COLUMN definition_hash text;`
backfill via script.

---

### 2. Endpoint de diff entre versões

Pra UI conseguir mostrar "v17 → v18: 3 nós alterados, 1 adicionado" antes de
promover, precisa de:

```
GET /workflows/:id/versions/:fromId/diff/:toId
```

**Resposta sugerida**:

```ts
{
  from: { id, version, createdAt },
  to:   { id, version, createdAt },
  nodes: {
    added:    [{ id, type, label }],
    removed:  [{ id, type, label }],
    changed:  [{ id, type, label, fields: ["config.query", "config.timeout"] }],
  },
  edges: {
    added:   number,
    removed: number,
  },
}
```

**Implementação** (`features/workflow-versions/controller.ts`):

- Carrega `from.definition` e `to.definition`.
- Normaliza: `Map<nodeId, node>` pra cada lado.
- Set difference em ids → added/removed.
- Pra nodes em ambos: deep-equal `config` (excluindo `position` que é só layout)
  → se diferente, listar chaves mudadas (1 nível: `config.<k>` etc.).
- Edges: comparar tuplas `(source, target, sourceHandle?, targetHandle?)`.

Sem libs novas — implementar puro em ~80 linhas. Cobrir com teste unitário
fixture-based.

**Route**:

```ts
.get("/:fromId/diff/:toId", async ({ organizationId, params, status }) => {
  const result = await workflowVersionsController.diff(
    organizationId, params.id, params.fromId, params.toId,
  );
  if ("error" in result) return status(404, { error: result.error });
  return result.diff;
});
```

---

### 3. Endpoint "Restore as draft"

Permite restaurar uma versão antiga como o `workflow.definition` corrente
(sem promover triggers — só mexe no draft):

```
POST /workflows/:id/versions/:versionId/restore
```

**Comportamento**:

1. Busca a versão. 404 se não existir / não pertencer ao workflow.
2. Copia `version.definition` pra `workflow.definition` via repository.
3. Audit log `workflow.restored_from_version` com `{ versionId, version: number }`.
4. Retorna o workflow atualizado.

**Importante**: NÃO publica uma nova versão automaticamente. O usuário pode
editar mais antes de publicar. Se a v18 é restaurada e publicada sem mudanças,
o item (1) de idempotência reusa a v18 — não cria v19 fantasma.

**Risco**: usuário restaura, esquece de publicar, e quem promover "latest"
pega a versão antiga sem saber. Mitigação: avisar no front (banner "draft
restaurado de v15 — publique pra ativar"). Backend não precisa proteger.

---

### 4. Bulk promote (release atômico)

Caso de uso: workflow tem 3 triggers (`prod-cron`, `prod-webhook`, `prod-fallback`)
todos rodando em produção. Promover um a um deixa janela de inconsistência
(50% rodando v17, 50% rodando v18).

**Endpoint**:

```
POST /workflows/:id/promote
{
  "workflowVersionId": "<vid>",
  "triggerIds": ["t1", "t2", "t3"]   // opcional: ausente = todos os triggers do workflow
}
```

**Comportamento**:

- Valida que a versão pertence ao workflow (1 vez, não N vezes).
- Valida que TODOS os triggerIds existem e pertencem ao workflow.
- Aplica `UPDATE triggers SET workflow_version_id = $1 WHERE id = ANY($2)` numa
  transação só.
- Audit log único `workflow.promoted` com `{ workflowVersionId, triggerIds, fromBy: { tid: oldVid } }`.
- Resposta: `{ promoted: [...triggers], previousVersions: { tid: oldVid } }`.

Mantém o `POST /:triggerId/promote` individual — ambos coexistem. Front usa o
individual no card de cada trigger e o bulk numa ação "Release this version".

---

## 🟡 P1 — Cobertura e migração

### 5. Script CLI de migração `connectionId` → `connectionRef`

Workflows e versões publicadas antes desta sessão guardam UUIDs em vez de nomes
lógicos. O backend é retrocompatível, mas pra a UI nova mostrar nome no picker
em modo `name`, precisa migrar os dados.

**Local**: `back/scripts/migrate-connection-refs.ts`

**Algoritmo**:

```ts
1. Listar todos os workflows (paginado).
2. Pra cada workflow:
   a. Listar database_connections do workflow → Map<uuid, name>.
   b. Percorrer workflow.definition.nodes:
      - Se node.config.connectionId é UUID + sem connectionRef:
        substituir: connectionRef = map[uuid]; deletar connectionId.
   c. UPDATE workflows SET definition = $1 WHERE id = $2.
   d. Pra cada workflow_versions desse workflow: mesma transformação na
      definition (immutables? sim, mas estamos migrando schema antigo —
      documentar como exceção pontual).
3. Log resumo: `{ workflowsScanned, workflowsUpdated, versionsUpdated, refsConverted }`.
4. Modo `--dry-run` que loga as substituições sem gravar.
```

**Edge cases**:

- UUID não achado no map (connection foi deletada): logar warning, deixar
  o UUID intacto. Engine ainda erra em runtime, mas isso já era verdade antes.
- Múltiplas connections com o mesmo nome em envs diferentes: usar o
  `environmentId=null` (default) como referência canônica — o resolver
  já cuida do fallback em runtime.

**Rodar**: `bun run scripts/migrate-connection-refs.ts --dry-run` → revisar →
`bun run scripts/migrate-connection-refs.ts`.

---

### 6. Política de delete de versão ✅ FEITO (Opção A)

> Implementado em 2026-07-11. Endpoint `DELETE /workflows/:id/versions/:versionId`
> exposto com a Opção A: bloqueia se a versão estiver fixada por qualquer
> trigger (HTTP 409 `version_in_use` + `refs`), senão remove e grava audit
> `workflow_version.deleted`. Cobertura: `tests/version-delete.test.ts`.
> Refs: `triggersRepository.countByVersion`, `workflowVersionsController.remove`.

Hoje a tabela `triggers.workflow_version_id` tem `ON DELETE SET NULL`. Isso
significa: deletar uma versão pinada por triggers **silenciosamente despinpina
todos os triggers** que apontavam pra ela.

Não temos endpoint de delete ainda, mas se for adicionado, decidir uma de duas:

**Opção A — Bloquear delete se referenciado**:

```ts
async remove(organizationId, workflowId, versionId) {
  const refs = await triggersRepository.countByVersion(versionId);
  if (refs > 0) return { error: "version_in_use" as const };
  // ... delete
}
```

Mais seguro pra operação. Força promote pra outra versão antes de deletar.

**Opção B — Permitir e documentar o SET NULL**:

Aceita o comportamento atual mas avisa no audit log (`workflow_version.deleted`
com `affectedTriggerIds: [...]` no metadata) e exige `?force=true` na query.

**Recomendação**: A. Versões deveriam ser imutáveis e baratas — não há ganho
em deletar; preserva auditoria.

Em qualquer caso, **decidir e implementar antes de expor o endpoint**.

---

### 7. Renomear / annotar versão publicada

Hoje versões aceitam `name` só no publish. Pra dar nome humano depois ("v17 — release Black Friday"),
precisa de:

```
PATCH /workflows/:id/versions/:versionId
{ "name": "release Black Friday" }
```

Só o `name` editável — `definition` continua imutável. Audit log
`workflow_version.renamed` com `{ from, to }`.

---

## 🟢 P2 — Polimento, performance e operação

### 8. Index em `triggers.workflow_version_id`

O FK não cria index automaticamente em Postgres. Quando o cron worker
re-sincroniza ou o front lista triggers por versão (item 6 do front), faz
seq scan. Adicionar:

```sql
CREATE INDEX IF NOT EXISTS triggers_workflow_version_id_idx
  ON triggers (workflow_version_id);
```

Migration pequena via `bun run db:generate`.

---

### 9. Documentar a semântica do `ensureLatest`

`workflowVersionsController.ensureLatest()` (`controller.ts:46`) tem um comportamento
sutil: **devolve a latest published, NÃO o draft atual**. Se o usuário editou
o workflow depois de publicar a v3 e dispara sem trigger pinado, roda a v3 —
não as edições.

Hoje isso é intencional (drafts não rodam em prod), mas não está documentado
no caller (`workflows/controller.ts:run`). Adicionar comentário grande:

```ts
// IMPORTANTE: sem opts.workflowVersionId E sem promote prévio, ensureLatest
// devolve a ÚLTIMA publicada — não o draft. Edições não publicadas só
// disparam via "test run" no editor (caminho separado). Isso é o contrato:
// dispatch automático = sempre versão imutável.
```

Tarefa de docs apenas. 5 minutos.

---

### 10. Auditoria de mudança de pino do trigger

Hoje, `update()` permite mudar `workflowVersionId` (vide `controller.ts:90`).
Isso cria um caminho paralelo ao `promote()` que **não gera audit log de
release** (gera só `trigger.updated`).

Decidir:

**Opção A** — Bloquear `workflowVersionId` em `update()`, forçar uso de `promote()`:

```ts
if (body.workflowVersionId !== undefined) {
  return { error: "use_promote_endpoint" as const };
}
```

Mais limpo. Auditoria fica sempre rastreável.

**Opção B** — Manter ambos e duplicar a lógica de audit (`trigger.updated` +
`trigger.promoted`) quando o campo muda via PATCH.

Recomendação: A. Promote é uma operação semanticamente distinta de "editar
trigger" e merece endpoint próprio (já tem).

---

### 11. Webhook node e nodeId no `webhook_trigger`

Há um arquivo `src/lib/engine/nodes/webhook-trigger.ts` novo (ver gitStatus)
que provavelmente é o handler do nó webhook-trigger no canvas, mas o índice
`src/lib/engine/nodes/index.ts` pode ainda não registrá-lo no handler map.

Verificar:

```bash
grep "webhook_trigger" src/lib/engine/nodes/index.ts
```

Se ausente, adicionar. Sem isso, runs com esse nó falham com `unknown_node_type`.

---

### 12. Testes integration do pipeline

Idealmente, antes de liberar pra prod, ter um teste e2e tipo:

```ts
test("promote pipeline: dev e prod rodam versões diferentes", async () => {
  // 1. Cria workflow, publica v1
  // 2. Cria trigger dev (env=dev) + trigger prod (env=prod)
  // 3. Promove só dev pra v1, prod fica sem pin
  // 4. Edita workflow, publica v2
  // 5. Despinpina ambos → both rodam v2 (latest)
  // 6. Pinna prod em v1, dev em v2
  // 7. Dispara cada trigger → verifica run.workflow_version_id
});
```

Roda via `bun test`. Cobre o caminho completo. Opcional pra v1 do pipeline,
mas previne regressões futuras.

---

## 📋 Ordem de execução sugerida

Cada item é uma sessão isolada. Marcar conforme completar:

- [ ] **(1)** Idempotência do `publish` + coluna `definition_hash` + backfill
- [ ] **(2)** Endpoint `GET /versions/:from/diff/:to`
- [ ] **(3)** Endpoint `POST /versions/:vid/restore`
- [ ] **(4)** Endpoint `POST /workflows/:id/promote` (bulk)
- [ ] **(5)** Script `scripts/migrate-connection-refs.ts` (com `--dry-run`)
- [x] **(6)** Política de delete de versão (bloquear se referenciada) — Opção A
- [ ] **(7)** `PATCH /versions/:vid` pra renomear
- [ ] **(8)** Index `triggers_workflow_version_id_idx`
- [ ] **(9)** Comentário documentando `ensureLatest` em `workflows/controller.ts`
- [ ] **(10)** Bloquear `workflowVersionId` em `update()` de trigger
- [ ] **(11)** Confirmar `webhook_trigger` registrado em `nodes/index.ts`
- [ ] **(12)** Test integration e2e do pipeline

**Mínimo viável pra produção**: itens (1), (8), (11). Sem idempotência o
histórico vira lixo; sem o index a UI lista versões fica lenta; sem o
`webhook_trigger` registrado o nó quebra runs.

**Próximo nível** (UX completa): adicionar (2), (3), (4) — o front
(`TODO-pipeline-versionamento.md`) depende desses pra implementar diff,
restore e release atômico.

---

## 🧪 Plano de teste manual ao final

1. Publicar v1 → editar → publicar v1 de novo sem mudar nada → confirmar que
   retorna v1 (alreadyExisted: true), NÃO cria v2.
2. Editar (1 nó) → publicar → cria v2. Chamar `/v1/diff/v2` → resposta lista
   1 changed.
3. Restaurar v1 como draft (POST /v1/restore) → workflow.definition volta pra v1.
   Publicar → como definition igual à v1, devolve v1 (idempotência).
4. Bulk promote: cria 3 triggers, chama `POST /workflows/:id/promote` com
   `triggerIds: [t1,t2,t3]` e `workflowVersionId: v2` → confirma que todos
   foram atualizados E que o audit log tem 1 entrada `workflow.promoted`
   (não 3 `trigger.promoted`).
5. Tentar deletar v2 enquanto pinada por triggers → 400 `version_in_use`.
   Despinpina todos → delete passa.
6. Rodar `bun run scripts/migrate-connection-refs.ts --dry-run` num workflow
   antigo → ver as substituições previstas. Rodar sem `--dry-run` → confirmar
   no DB que `definition.nodes[].config.connectionId` virou `connectionRef`.

---

## 🗄️ Backlog estratégico — arquivado

> Removido do escopo do MVP em 2026-07-05. A lista extensa de ideias
> (observabilidade, performance, confiabilidade, segurança, integrações de
> gatilho, engine, refactors) e o mapa de impacto×esforço foram cortados
> daqui pra manter o plano focado no que falta pro lançamento. O histórico
> completo está preservado no git; retomar item a item conforme a demanda
> do negócio.

---

## 🔗 Referências cruzadas (já implementado nesta sessão)

| Arquivo                                               | O que tem                                               |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `src/features/database-connections/repository.ts:151` | `resolve(workflowId, ref, environmentId)` com UUID/nome |
| `src/features/triggers/controller.ts:155`             | método `promote()`                                      |
| `src/features/triggers/router.ts:122`                 | endpoint `POST /:triggerId/promote`                     |
| `src/features/triggers/schema.ts`                     | `promoteTriggerBody` + `workflowVersionId`              |
| `src/features/workflows/controller.ts:121`            | `run()` aceita `opts.workflowVersionId`                 |
| `src/features/workflow-versions/router.ts`            | publish/list/findById já wired                          |
| `src/features/workflow-versions/controller.ts`        | publish/list/findById/ensureLatest                      |
| `scripts/worker.ts:86`                                | closure `resolveConnection` com env-fallback            |
| `scripts/worker.ts:231`                               | cron worker propaga `trigger.workflowVersionId`         |
| `src/features/triggers/webhook-router.ts:75`          | webhook propaga `trigger.workflowVersionId`             |
| `drizzle/0010_daffy_morbius.sql`                      | migration `triggers.workflow_version_id`                |
