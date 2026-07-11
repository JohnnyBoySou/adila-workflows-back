# Worker Go — Lane `scraping`

> **ARQUIVADO (2026-07-05) — fora do escopo do MVP.** Sem worker Go, a lane
> `scraping` é consumida pelo worker Node como qualquer outra; nada quebra.
> Retomar este plano só quando volume/isolamento de scraping justificar um
> processo dedicado. Mantido aqui como referência de design, não como backlog
> ativo.

> Contexto: a arquitetura multi-lane do BullMQ ficou pronta em 2026-05-23
> (ver `src/lib/queue.ts` — `LANE_NAMES`, `pickLaneForDefinition`,
> `findWorkflowJobAcrossLanes`). A lane `scraping` já é roteada a partir
> dos node-types `http_request` e `rss_trigger`, mas hoje é consumida
> pelo mesmo worker Bun. Este TODO cobre o spin-off para um worker Go
> dedicado, motivado por: HTTP fan-out massivo (centenas/milhares de
> requests concorrentes) onde Go com goroutines + `net/http` tem footprint
> e p95 melhores que Bun.

---

## 🎯 Objetivo

Um binário Go que:

1. consome jobs da fila Redis `workflows-scraping` (wire-protocol BullMQ)
2. executa apenas handlers de nó da família **scraping/HTTP** (subset do
   engine Bun — não precisa reimplementar tudo)
3. publica eventos no mesmo formato que o batcher Bun (Postgres `workflow_run_events` + Redis pub/sub `run:{id}`), preservando o protocolo do SSE incluindo `seq`
4. respeita o sinal de cancelamento (`run:{id}:cancel` em Redis pub/sub)
5. honra `RetryableError` semanticamente (re-throw → BullMQ retenta;
   `UnrecoverableError` equivalente → marca failed sem retry)

Quando NÃO houver workflows pesados de scraping em produção, o binário
pode nem subir — `WORKFLOW_BUN_LANES` segue cobrindo todas as lanes no Bun.

---

## 🔴 Fase 1 — Prova de conceito (1 nó, 1 workflow)

Meta: rodar um único `http_request` num workflow trivial pela lane
`scraping`, com o Go consumindo. Tudo o resto continua no Bun.

### 1.1 Estrutura do repositório

Criar diretório `back/workers-go/scraping/` com:

```
workers-go/scraping/
  go.mod
  main.go
  internal/
    bullmq/        # cliente BullMQ (consumer)
    runevents/     # publisher batchado (mirror do TS)
    cancel/        # subscriber de run:{id}:cancel
    handlers/
      http_request.go
    engine/        # mini-orquestrador (subset do executor Bun)
  README.md        # como buildar/rodar + variáveis
```

Dependências sugeridas (versões mais recentes na hora):

- `github.com/redis/go-redis/v9`
- `github.com/jackc/pgx/v5` (mesmo driver do Bun, conexão direta no Postgres)
- `github.com/google/uuid`

**Decisão**: NÃO vamos usar uma lib BullMQ-compat de terceiros como
black-box. O wire-protocol é simples (LMOVE + HGET + HSET nas keys do
BullMQ) e queremos controle total da serialização. Implementar manualmente
em `internal/bullmq/consumer.go` reaproveitando o protocolo descrito em
[BullMQ patterns](https://docs.bullmq.io/patterns).

### 1.2 Wire-protocol BullMQ — pontos críticos

Pesquisar e validar contra os jobs reais que o Bun enfileira:

- [ ] **Key layout**: `bull:{queueName}:` prefix (configurável via
      `prefix` no Queue construtor — hoje usamos default; confirmar)
- [ ] **Estados**: `wait` (lista), `active` (lista), `completed` (set),
      `failed` (set), `delayed` (zset). Fluxo: BRPOPLPUSH de `wait` → `active`,
      ack via remoção de `active` + add em `completed`/`failed`
- [ ] **Job payload**: `bull:{queue}:{jobId}` é Hash com `data` (JSON
      serializado do nosso `WorkflowJob`), `opts`, `attemptsMade`, `timestamp`
- [ ] **Lock**: lockKey `bull:{queue}:{jobId}:lock` com TTL renovado
      enquanto processa (extender a cada N segundos via SETEX)
- [ ] **Failure**: ao errar, incrementar `attemptsMade`; se `attemptsMade <
opts.attempts`, recolocar em `wait` com delay (backoff); senão `failed`
- [ ] **Retry com backoff exponencial**: replicar a fórmula que o BullMQ
      TS usa — `delay * 2^(attempts-1)`. Default no nosso queue: `delay: 2000`,
      `attempts: 3`
- [ ] **QueueEvents**: o Bun pub/sub `bull:{queue}:events` com tipos
      `completed`, `failed`, `progress`. Publicar pra manter
      `job.waitUntilFinished()` funcionando do lado Bun (sub-workflow runner
      do `scripts/worker.ts`)

**Risco**: se o protocolo desviar em algum detalhe, o `waitUntilFinished`
do sub-workflow runner trava em timeout silencioso. Adicionar teste e2e:
um workflow Bun chama um sub-workflow que cai na lane scraping; verificar
que `await job.waitUntilFinished(workflowQueueEvents.scraping, ...)`
resolve corretamente.

### 1.3 Publisher de eventos (espelha `BatchedRunEventPublisher` TS)

Arquivo: `internal/runevents/publisher.go`

Comportamento — copiar de `back/src/lib/run-events.ts`:

- [ ] Buffer per-run com flush a cada 50ms ou em eventos terminais
      (`workflow.started/finished/failed/cancelled`)
- [ ] Single `INSERT INTO workflow_run_events (...) VALUES (...), (...) RETURNING seq` via pgx
- [ ] Single `PUBLISH run:{id}` com array JSON de eventos contendo `seq`
- [ ] Drain no shutdown (signal `SIGTERM`/`SIGINT`)

Validar end-to-end:

- [ ] Front conectado via SSE recebe `id: <seq>` corretamente
- [ ] Resume via `Last-Event-Id` funciona contra eventos publicados pelo Go
      (o caminho de replay em `workflow-runs/router.ts:listByRunSinceSeq`
      lê tudo do Postgres, então é agnóstico de quem inseriu)

### 1.4 Cancel subscriber

Arquivo: `internal/cancel/subscriber.go`

- [ ] `SUBSCRIBE run:{id}:cancel` ao iniciar o run
- [ ] Flag `atomic.Bool` que o engine checa entre nós (mesmo modelo de
      `cancelSub.isCancelled()` no `scripts/worker.ts`)
- [ ] Checagem inicial síncrona contra `workflow_runs.cancel_requested`
      (cobre cancel publicado antes de assinar)
- [ ] Cleanup no defer

### 1.5 Handler `http_request`

Espelhar `back/src/lib/engine/nodes/http_request.ts`:

- [ ] Mesmas chaves de config (`method`, `url`, `headers`, `body`,
      `query`, `timeoutMs`, `followRedirects`, `auth`, ...)
- [ ] Resolver templating `{{ $node.x.output.y }}` — **decisão**: começar
      por SUPORTAR APENAS resolução estática (sem templating Liquid/handlebars).
      Workflows com templating caem na lane default (Bun) — adicionar
      `pickLaneForDefinition` exception se necessário, ou aceitar que Go falha
      com `UnrecoverableError` claro "templating not supported in go worker"
- [ ] Classificação de erro:
  - 5xx, timeout, conn refused, DNS → `RetryableError` (re-throw, BullMQ retenta)
  - 4xx, validação, URL inválida → equivalente `UnrecoverableError`
- [ ] Output no mesmo shape `{ status, headers, body, durationMs }` que o
      handler Bun (front e nós downstream não devem perceber diferença)
- [ ] `context.Context` propagado com cancelamento amarrado ao
      `cancelSub.flag` — request HTTP morre instantaneamente no cancel

### 1.6 Engine mínimo

`internal/engine/executor.go` — versão enxuta do `executeRun` TS:

- [ ] Normaliza `definition` (mesmo JSON shape)
- [ ] Acha start, percorre edges, executa handler do nó
- [ ] Pré-grava `workflow_run_steps` (status=running), atualiza no fim
      (success/failed) — mesmo schema do Bun
- [ ] Chama `publisher.Enqueue(...)` para os mesmos eventos
      (`workflow.started`, `node.started`, `node.finished`, `node.failed`,
      `workflow.finished/failed/cancelled`)
- [ ] **Restrição inicial**: se encontrar um node-type que não tem handler
      em Go, falha com `UnrecoverableError` "node type X not supported by go
      worker — route to default lane". Forçar todos os nós do workflow a
      serem suportados, ou voltar pra lane Bun.

### 1.7 Variáveis de ambiente

Replicar subset do `src/config/env.ts`:

```
REDIS_URL=...
DATABASE_URL=...
WORKER_CONCURRENCY=50           # goroutines simultâneas no consumer
LANE=scraping                   # qual fila consumir
LOG_LEVEL=info
HTTP_TIMEOUT_DEFAULT_MS=30000
HTTP_MAX_RESPONSE_BYTES=10485760  # 10MB cap
```

### 1.8 Critérios de "PoC pronto"

- [ ] Workflow `[start] → [http_request GET https://httpbin.org/json] → [end]`
      roda end-to-end pelo Go
- [ ] Eventos chegam ao front via SSE com `seq` correto, sem duplicação
- [ ] Cancel via API mata o request HTTP em menos de 100ms
- [ ] Falha 5xx tenta 3x com backoff exponencial; falha 4xx falha imediato
- [ ] Sub-workflow Bun chamando workflow que cai na lane scraping
      (executado pelo Go) recebe `waitUntilFinished` corretamente
- [ ] `WORKFLOW_BUN_LANES=default,heavy` no Bun + Go rodando → lane
      scraping consumida só pelo Go; sem dupla execução

---

## 🟡 Fase 2 — Cobertura de handlers + observabilidade

### 2.1 Mais handlers portados

Prioridade por tráfego esperado:

- [ ] `webhook_request` (alias do `http_request` no editor)
- [ ] `rss_trigger` runtime (já roteado pra `scraping` — confirmar se
      precisa de handler de execução além do dispatch via cron-scheduler)
- [ ] `html_parse` / `css_selector` (se existir; checar `nodes/index.ts`)

### 2.2 Templating

Decidir: implementar parser de `{{ ... }}` em Go (subconjunto) OU manter
a regra "workflows com templating → lane default". A primeira é o caminho
correto pra que a feature seja transparente, mas é onde Go vai gastar
mais código por nada (parser, expression eval, error reporting).

- [ ] Auditar quantos workflows reais usam templating em `http_request`
- [ ] Se >20%, portar parser. Se <20%, manter exceção e adicionar
      detecção em `pickLaneForDefinition` (varrer config dos nós em busca
      de `{{`)

### 2.3 Métricas

- [ ] Expor `/metrics` no Go com counters: `jobs_processed_total{lane,
status}`, `job_duration_seconds`, `http_requests_total{status_class}`,
      `http_request_duration_seconds`
- [ ] Endpoint `/health/queue` no Bun já agrega contadores BullMQ por
      lane — não precisa duplicar lá. Só adicionar info de "worker count"
      por lane se útil

### 2.4 Connections / shared state

- [ ] Pool pgx compartilhado, tamanho proporcional à concorrência
- [ ] `http.Transport` global com `MaxIdleConnsPerHost` alto + keep-alive
      (toda a graça do Go contra Bun aqui)
- [ ] Resolver DNS com cache (`github.com/rs/dnscache` ou similar) — em
      fan-out massivo, lookup vira gargalo

---

## 🟢 Fase 3 — Operação

### 3.1 Deploy

- [ ] Dockerfile multi-stage (build → distroless)
- [ ] Healthcheck endpoint (`/healthz` simples)
- [ ] Manifest k8s/Railway com `WORKFLOW_BUN_LANES=default,heavy` no
      serviço Bun e Go consumindo lane scraping com 2-4 réplicas

### 3.2 Rollout seguro

- [ ] **Etapa 1**: Go sobe mas com `WORKFLOW_BUN_LANES` ainda incluindo
      `scraping` no Bun. Os dois competem pela fila — dá pra comparar
      latências sem risco (perde-se 1 worker se um cair)
- [ ] **Etapa 2**: tirar `scraping` do `WORKFLOW_BUN_LANES`. Só Go
      consome. Monitorar p95 e taxa de erro por algumas horas
- [ ] **Etapa 3**: subir réplicas Go conforme load

### 3.3 Rollback plan

Trivial: re-adicionar `scraping` no `WORKFLOW_BUN_LANES`, descer Go. A
fila BullMQ é compartilhada — Bun pega o trabalho de onde o Go parou. Sem
migration nem perda de jobs in-flight (lock TTL libera em <30s).

---

## ❓ Decisões em aberto

- **Repo único vs separado?** O Go vive em `back/workers-go/` (este TODO)
  ou em repo dedicado? Argumento pro mono: tipos do `WorkflowJob` ficam
  perto, fácil garantir paridade. Argumento contra: cycle CI pode crescer.
  **Default**: mono, com diretório isolado e CI step opcional.
- **Codegen do `WorkflowJob`?** Vale gerar struct Go a partir do tipo
  TS pra evitar drift. `quicktype` resolve isso — adicionar um step
  no `bun run build` que regenera `internal/types/gen.go`.
- **Engine Go vira Source of Truth pra scraping?** Se a paridade for
  100%, podemos _remover_ `http_request.ts` do Bun para que workflows
  scraping SEMPRE caiam no Go (mesmo na lane default, via redirect). Por
  enquanto: NÃO — manter duplicado, lane-routed.

---

## 📎 Referências locais

- Arquitetura multi-lane: `back/src/lib/queue.ts`
- Batcher de eventos TS (espelhar): `back/src/lib/run-events.ts`
- Worker TS canonical: `back/scripts/worker.ts`
- Schema: `back/src/db/schema.ts` (`workflowRunEvents`, `workflowRunSteps`,
  `workflowRuns` — observar `seq` bigserial em `run_events`)
- Migration relevante: `back/drizzle/0020_run_event_seq.sql`
- SSE com resume: `back/src/features/workflow-runs/router.ts`
  (`Last-Event-Id` → `listByRunSinceSeq`)
- Cancel pubsub: `back/src/lib/run-events.ts` (`publishCancel`,
  `subscribeCancel`, canal `run:{id}:cancel`)
