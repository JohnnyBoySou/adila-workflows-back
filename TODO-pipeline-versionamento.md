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

### 6. Política de delete de versão

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
- [ ] **(6)** Política de delete de versão (bloquear se referenciada)
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

## 💡 Backlog estratégico — além do pipeline

Ideias categorizadas pra evoluir a plataforma. Cada bloco é independente —
pode ser puxado pra sprint sem depender dos itens P0/P1/P2 acima.

Convenção de tamanho: **S** = 1 sessão, **M** = 2-3 sessões, **L** = 1+ semana.

---

### 🔭 Observabilidade e operação

- **[M] Métricas Prometheus** — endpoint `/metrics` expondo: runs por status,
  duração p50/p95/p99 por workflow, queue depth, worker concurrency,
  rate-limit hits, audit-log volume. Lib: `prom-client`. Cada métrica
  rotulada por `organizationId` + `workflowId` (cuidado com cardinalidade —
  cap em N labels distintos).
- **[S] Health check estendido** — `/health` hoje devolve 200 fixo (commit
  `a1e2440`). Estender com checks reais: DB ping (`SELECT 1`), Redis ping,
  worker liveness (BullMQ `getWorkers`), filas drenando. Resposta JSON
  com `ok | degraded | down` + componentes.
- **[M] Distributed tracing OpenTelemetry** — instrumentar Elysia + Drizzle +
  BullMQ. Cada run vira um trace, cada nó um span. Exporta pra Tempo/Jaeger
  via OTLP. Indispensável quando workflows ficam compostos (`execute_workflow`
  aninhado, sub-runs).
- **[S] Correlation IDs em logs** — gerar `traceId` no router (middleware
  Elysia), propagar via context pro engine, anexar em cada `logger.child`.
  Hoje só temos `runId`/`workflowId` — falta um id global pra correlacionar
  request HTTP com background job.
- **[M] Alerting de falhas** — `POST /alerts` configurável: "se workflow X
  falhar N vezes em M minutos, dispara webhook Y / email Z". Nova tabela
  `workflow_alerts`. Worker cron varre a janela e dispara.
- **[L] Dashboard de operação interno** — rota `/admin/dashboard` com:
  runs por hora últimas 24h, top workflows por volume, top workflows por
  failure rate, queue depth atual. Read-only, role-gated `owner`.

---

### ⚡ Performance e escalabilidade

- **[M] Concurrency limit por workflow** — coluna `workflows.max_concurrent_runs`.
  Antes de enfileirar, checa runs em status `running` + `queued` desse workflow.
  Se ≥ limit, ou rejeita (`429 workflow_at_capacity`) ou serializa via fila
  separada. Crucial pra workflows que escrevem em sistemas com lock.
- **[S] Rate limit granular por trigger** — hoje rate-limit é só no webhook
  global (`60/min`). Adicionar coluna `triggers.rate_limit_per_minute` (nullable),
  aplicar no `webhook-router.ts`. Default = global.
- **[M] Queue priority** — coluna `triggers.priority: "high" | "normal" | "low"`,
  mapear pra BullMQ `priority` numérico. Workers processam high primeiro.
  Útil pra "este cron diário pode esperar, este webhook de checkout não".
- **[M] Sharded workers por tag** — coluna `workflows.tags: text[]`. Workers
  podem ser iniciados com `WORKER_TAGS=heavy,gpu` e só consomem jobs dessa
  tag (queue separada por tag, ou job data filter). Permite isolar workflows
  pesados em hardware dedicado.
- **[S] LRU cache de definitions** — `workflowVersionsRepository.findByIdRaw`
  é hot path no worker (chamado a cada run). Cache LRU 100 entradas, TTL 5min,
  key = `versionId`. Versões são imutáveis — TTL longo é seguro.
- **[M] Connection pooling explícito** — hoje `database-connections` cria
  client novo por chamada. Pool por `(workflowId, ref, environmentId)` com
  TTL idle 30s. Reduz overhead em workflows que rodam Postgres N vezes.

---

### 🛡️ Confiabilidade

- **[M] Retry policy por nó** — coluna `definition.nodes[].config.retry`:
  `{ maxAttempts: number, backoffMs: number, exponential: bool, retryOnErrors: string[] }`.
  Engine aplica antes de propagar erro. Default = sem retry.
- **[S] Idempotency keys em webhooks** — header `Idempotency-Key`: se já tem
  um run com `triggers.last_idempotency_key === key` nos últimos 24h, devolve
  o run anterior em vez de criar novo. Coluna nova `last_idempotency_key text`.
- **[L] Run resume de checkpoint** — gravar output de cada nó em
  `workflow_run_steps` (já fazemos). Adicionar `resume_token` no run. Worker
  que pega run em `running` órfão (sem heartbeat) pula nós com output salvo
  e continua do próximo. Crítico pra workflows longos quando worker crash.
- **[M] Circuit breaker em nós HTTP** — `http-request.ts` mantém contador em
  Redis: 5 falhas seguidas pra mesma URL = circuito aberto por 60s, falha
  imediato. Evita esgotar timeout do upstream que tá fora do ar.
- **[M] Dead letter queue** — runs que falham todos os retries vão pra
  `failed_runs` (BullMQ já tem). Endpoint `POST /runs/:id/replay` re-enfileira
  com mesmo input. UI lista DLQ por workflow.
- **[S] Run cancellation com cleanup** — hoje cancel é cooperativo (flag).
  Adicionar callback `onCancel` por nó: HTTP cancela request, Postgres faz
  rollback. Engine chama no nó atual quando flag vira true.
- **[M] Graceful shutdown com drain** — SIGTERM hoje fecha workers
  imediatamente (`worker.close()`). Mudar pra: para de aceitar novos jobs,
  termina jobs em voo (timeout configurável), só então sai. Crítico pra
  zero-downtime deploy.

---

### 🔒 Segurança

- **[S] HMAC signature em webhooks** — header `X-Signature: sha256=<hex>`
  computado com `triggers.webhook_secret`. Webhook-router valida antes de
  disparar. Default opcional (mantém compat); habilitar via
  `triggers.require_signature: bool`.
- **[S] IP allowlist por trigger** — coluna `triggers.allowed_ips: text[]`
  (suporte CIDR). Webhook-router rejeita 403 se IP fora. Útil pra integrar
  com providers fixos (Stripe, GitHub).
- **[M] Rotação automática de webhook tokens** — coluna
  `triggers.token_expires_at`. Cron worker varre tokens expirando em < 24h
  e dispara notificação. Endpoint `/rotate-token` já existe — adicionar TTL.
- **[M] Secret scanning nos logs** — interceptor antes de gravar audit_log
  ou workflow_run_steps.output: regex pra `password`, `api_key`, `Bearer
  [A-Za-z0-9]+`, etc → substitui por `***REDACTED***`. Worth gold quando
  alguém vaza credencial num node config.
- **[L] RBAC granular** — hoje é `owner | admin | member`. Adicionar:
  `viewer` (só lê), `runner` (lê + dispara, não edita), `editor` (edita,
  não promove), `releaser` (promote). Per-workflow override possível.
- **[M] API keys além de session** — tabela `api_keys` com scope (read,
  write, run), expiração, last_used. Auth middleware aceita `Authorization:
  Bearer <key>`. Hoje só sessão.
- **[S] Audit log export** — `GET /audit-logs/export?format=csv|json&from=&to=`.
  Stream resposta pra não estourar memória. Útil pra compliance / SOC 2.
- **[L] SSO / SAML** — Better Auth tem plugin. Habilitar pra organizations
  enterprise. Roles vêm do IdP.

---

### 🧩 Features de workflow

- **[M] Wait for webhook node** — pausa o run, gera URL única, devolve
  no output. Quando alguém faz POST nessa URL, run retoma com o body como
  output do nó. Padrão "human-in-the-loop". Estado salvo em
  `workflow_runs.paused_at_step`.
- **[M] Manual approval node** — variante do wait-for-webhook mas com UI
  específica: lista de aprovações pendentes por user/role, botões
  approve/reject. Métrica `time_to_approval`.
- **[S] Schedule one-off (delay)** — node `wait` que pausa N segundos/minutos.
  Internamente enfileira `delayed job` no BullMQ. Range: 1s a 7 dias.
- **[S] Cron com janela** — coluna `triggers.cron_window: { start, end, days[] }`.
  Scheduler skipa disparos fora da janela. Útil pra "rodar só em horário
  comercial em dia útil".
- **[M] Loop com break condition** — node `loop` com sub-graph interno.
  Itera até condição (expressão JS) virar true ou hit `maxIterations`.
- **[M] Try-catch node** — sub-graph "try" e sub-graph "catch". Erro no try
  desvia pro catch com erro no input.
- **[M] Switch / case node** — N saídas, cada uma com expressão. Primeira
  que casa wins. Generaliza o atual `if` (que só tem 2 saídas).
- **[L] Parallel execution (split-merge)** — node `split` dispara N branches
  concorrentes, node `merge` espera todas terminarem e agrega outputs.
  Engine precisa virar DAG-aware (hoje é sequencial).

---

### 💾 Data e storage

- **[M] Retention policy por workflow** — coluna `workflows.run_retention_days`.
  Cron diário deleta `workflow_runs` (+ steps + outputs) mais antigos. Default
  90 dias. Logs ficam separados (audit_log) e têm retention própria.
- **[M] Output archiving** — outputs grandes (>10KB) já comprimidos com gzip
  antes de gravar (coluna `output_compressed: bool`). Após N dias, mover
  pra S3 cold storage, manter só ponteiro no DB. Read on-demand.
- **[S] File handling** — nó `upload_file` aceita binary, salva em S3,
  devolve URL pré-assinada como output. Outros nós podem referenciar.
- **[M] Workflow templates marketplace** — tabela `workflow_templates` global
  (não por org). UI lista. Importar = clona definition + cria variáveis
  necessárias.
- **[S] Export/import de workflow** — endpoint `GET /workflows/:id/export`
  devolve JSON com `definition + version_history + triggers (sem secrets)`.
  `POST /workflows/import` aceita o mesmo. Útil pra mover entre orgs/envs.

---

### 🛠️ Developer Experience

- **[M] OpenAPI spec autogen** — Elysia tem `@elysiajs/swagger`. Habilitar
  em `/docs`. Schemas já estão em `t.Object` — sai grátis. Vital pra
  SDK e integração externa.
- **[L] CLI tool `adila`** — `adila workflow list`, `adila workflow publish`,
  `adila run --wait`, `adila import file.json`. Usa API key.
- **[M] TypeScript SDK** — pacote `@adila/sdk` em `packages/sdk` ou repo
  separado. Types auto-gerados do OpenAPI. Publicar no npm interno.
- **[S] Webhook echo / debug endpoint** — `/hooks/_test` que aceita qualquer
  body, devolve com headers + IP + timestamp. Útil pra developer testar
  integração antes de criar trigger real.
- **[L] Step-by-step debugger** — modo `debug: true` no run pausa entre
  cada nó. UI mostra estado, permite editar input antes de continuar.
  Útil pra desenvolvimento, NÃO pra prod.
- **[L] Time-travel debugging** — UI consome `workflow_run_steps`, mostra
  estado em cada instante, permite "rebobinar e re-rodar do passo X com
  input modificado". Vira novo run com `parent_run_id`.

---

### 🤖 AI features

Diretório `src/features/ai/` já existe (ver gitStatus). Possíveis evoluções:

- **[M] Embeddings de workflows** — gerar embedding da `definition`
  (descrição + nós) via OpenAI ou local. Busca semântica: "workflows
  que mexem com Slack". `pgvector` extension.
- **[M] Auto-suggest próximo nó** — input dos últimos N nós + tipos
  conectados → LLM sugere top 3 próximos nós relevantes. Mostra no
  drawer "sugestões pra você".
- **[L] Natural language → workflow** — "crie um workflow que recebe
  webhook do Stripe, chama API X, salva no Postgres" → LLM gera
  `definition` JSON. UI mostra preview antes de criar.
- **[M] LLM cost tracking** — nó `ai_chat` registra
  `{ inputTokens, outputTokens, costUsd, provider, model }` em
  `workflow_run_steps.metadata`. Agregar por org → dashboard de custo.

---

### 📐 Compliance e multi-tenancy

- **[M] Org quotas** — coluna `organizations.quota_max_workflows`,
  `quota_max_runs_per_day`, `quota_max_concurrent_runs`. Middleware
  rejeita ao estourar com 402 `quota_exceeded`. Tier free/pro/enterprise.
- **[L] Billing/usage tracking** — tabela `usage_records` (org_id, day,
  runs_count, runs_duration_ms, ai_cost_cents). Cron agrega diário.
  Hook pra Stripe metered billing.
- **[L] GDPR data export** — `POST /organizations/:id/export-data`
  gera ZIP com todos workflows, runs, audit-logs da org. Background job,
  email com link quando pronto.
- **[M] Soft delete** — adicionar `deleted_at` em workflows + runs.
  Endpoints `/restore` por N dias antes de hard delete via cron.
  Hoje DELETE é permanente.
- **[L] Data residency multi-region** — coluna `organizations.region:
  "us" | "eu" | "br"`. Worker filtrado por region. DB read replicas
  por region. Complexo, mas necessário pra enterprise EU.

---

### 🔌 Integrações de gatilho

Triggers hoje: cron + webhook. Adicionar:

- **[M] GitHub webhook trigger** — variante do webhook genérico com
  validação HMAC do `X-Hub-Signature-256` automática + parser do payload
  pra `payload.event_type`, `payload.repo`, etc.
- **[M] Stripe webhook trigger** — idem com Stripe-Signature.
- **[L] Postgres CDC trigger** — usa `pg_logical_replication` ou
  `wal2json`. Trigger dispara quando linha de uma tabela muda. Complexo
  mas mata uso "ETL real-time".
- **[L] Kafka consumer trigger** — worker subscribe num topic, cada
  mensagem dispara um run. Configurar broker + topic via UI.
- **[M] S3 event trigger** — bucket notification → SQS → trigger dispara.
  Útil pra processar uploads.
- **[S] Manual trigger UI** — botão "Run now" no editor que aceita JSON
  input. Não é trigger persistido — é só execução ad-hoc.
- **[M] Form trigger** — gera URL pública com formulário renderizado a
  partir de schema (`{ fields: [...] }`). Submit dispara workflow.
  No-code low-friction.

---

### 🎯 Engine e nós

- **[S] Expression language** — hoje é template `{{ env.X }}`. Estender:
  `{{ $node.foo.output.array.length }}`, `{{ $input.body | json | upper }}`,
  pipes, conditionals. Sub-set funcional puro pra não virar Turing-complete.
- **[M] Schema validation por nó** — coluna `definition.nodes[].config.input_schema`
  (JSON Schema). Engine valida input antes de chamar handler. Erro descritivo:
  "node X: campo Y missing or wrong type".
- **[S] Default output mapping** — nó tem N outputs nomeados. Próximo nó pode
  referenciar `{{ $node.id.output.<name> }}` em vez de pegar tudo. Mais
  legível que o atual passthrough.
- **[M] Custom nodes via plugin** — diretório `src/plugins/` com convention:
  `export default { type, handler, configSchema }`. Engine carrega no boot.
  Permite extensões sem mexer no core.
- **[M] Subprocess sandbox pra `code` node** — hoje JS roda no mesmo process
  (risco). Mover pra worker_threads ou processo isolado com timeout + memory
  limit hard. `isolated-vm` ou `vm2` (cuidado com CVEs).

---

### 🧱 Refactors técnicos

- **[S] Logger estruturado consistente** — alguns lugares usam `logger.info("msg")`,
  outros `logger.info({ ctx }, "msg")`. Audit + lint rule pra exigir context object.
- **[S] Error types tipados** — hoje `return { error: "string" as const }`. Padronizar
  via discriminated union `ControllerError` com helper `err(code, ctx?)`. Router
  converte tipo → status automático.
- **[M] Repository layer com unit-of-work** — operações que tocam várias
  tabelas (criar trigger + audit) hoje não têm transação cross-feature.
  Helper `db.transaction(async (tx) => { ... })` exposto via DI.
- **[S] Validação de timezone no schema** — `triggers.timezone` aceita
  qualquer string hoje. Validar via `Intl.supportedValuesOf("timeZone")`.
- **[M] Drizzle migrations CI check** — GitHub Action que roda
  `drizzle-kit generate` em PR e falha se há diff (alguém esqueceu de gerar).
- **[S] Worker logs estruturados pra Loki/Datadog** — hoje vai pra stdout
  raw. Wrappar pino com transport JSON. `LOG_FORMAT=json | pretty` env.

---

## 🗺️ Mapa de impacto vs esforço

```
        IMPACTO ALTO
              ▲
              │
   [1] Idempotência publish
   [4] Bulk promote        [Concurrency limit]
   [Retry policy]          [HMAC webhooks]
   [Tracing OTLP]
              │
   [Health check]          [Templates marketplace]
   [Index FK]              [Run resume]
              │            [RBAC granular]
   [Doc ensureLatest]
              │
              └──────────────────────────────────►
                                       ESFORÇO ALTO
```

**Próximas 3 sessões recomendadas**:
1. P0 (1) idempotência do publish — destranca o resto.
2. P0 (4) bulk promote — destranca UI de release atômico.
3. Backlog [Retry policy] — eleva 10× a confiabilidade percebida.

Depois dessas, pegar conforme demanda do negócio.

---

## 🔗 Referências cruzadas (já implementado nesta sessão)

| Arquivo | O que tem |
|---------|-----------|
| `src/features/database-connections/repository.ts:151` | `resolve(workflowId, ref, environmentId)` com UUID/nome |
| `src/features/triggers/controller.ts:155` | método `promote()` |
| `src/features/triggers/router.ts:122` | endpoint `POST /:triggerId/promote` |
| `src/features/triggers/schema.ts` | `promoteTriggerBody` + `workflowVersionId` |
| `src/features/workflows/controller.ts:121` | `run()` aceita `opts.workflowVersionId` |
| `src/features/workflow-versions/router.ts` | publish/list/findById já wired |
| `src/features/workflow-versions/controller.ts` | publish/list/findById/ensureLatest |
| `scripts/worker.ts:86` | closure `resolveConnection` com env-fallback |
| `scripts/worker.ts:231` | cron worker propaga `trigger.workflowVersionId` |
| `src/features/triggers/webhook-router.ts:75` | webhook propaga `trigger.workflowVersionId` |
| `drizzle/0010_daffy_morbius.sql` | migration `triggers.workflow_version_id` |
