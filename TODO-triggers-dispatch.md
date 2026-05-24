# Triggers — Dispatch Infrastructure TODO

> Contexto: Fases 1 e 2 entregues em 2026-05-23. A library do canvas tem 12
> trigger nodes e o engine os reconhece todos (`TRIGGER_NODE_TYPES` em
> `src/lib/engine/types.ts`). O CRUD de `triggers` aceita todos os tipos com
> `config` JSONB e os tipos **scheduler-driven** (`cron`, `interval_trigger`)
> + `error_trigger` + `workflow_called_trigger` já disparam. Este TODO cobre
> as três fases que faltam pra fechar o conjunto.

---

## 🔴 Fase 3 — Rotas HTTP públicas (sem deps externas)

Triggers cobertos: `form_trigger`, `chat_trigger`. Padrão: rota Elysia análoga
ao `webhook-router.ts` (`src/features/triggers/webhook-router.ts`), com lookup
por token único na tabela `triggers` + enqueue em `workflowQueue`.

### 3.1 `form_trigger` — Form público

**Migration** (`drizzle/00XX_form_trigger_token.sql`): nenhuma — reaproveitar
o campo `webhookToken` (renomear column para `public_token` numa migration
futura, ou aceitar a sobrecarga semântica por enquanto).

**Config esperada** (`triggers.config` JSONB):
```ts
{
  title?: string;
  description?: string;
  fields: Array<{
    name: string;
    label: string;
    type: "text" | "email" | "number" | "textarea" | "select" | "checkbox";
    required?: boolean;
    options?: string[];   // só para type=select
  }>;
  submitButtonText?: string;
  successMessage?: string;
}
```

**Novo arquivo**: `src/features/triggers/form-router.ts`
- `GET /forms/:token` → renderiza HTML simples (string template, sem framework)
  a partir de `config.fields`. Inputs nomeados pelos `field.name`, action POST
  na mesma URL.
- `POST /forms/:token` → enfileira run com input `{ fields: {...}, submittedAt }`,
  redireciona pra `/forms/:token/success` ou devolve JSON conforme `Accept`.
- `GET /forms/:token/success` → página de confirmação (`config.successMessage`).

**Validação**: bater `field.name` recebido contra `config.fields`, rejeitar
campos extras; aplicar `required` server-side.

**Controller**: adicionar geração de token na criação (`generateFormToken()`,
mesmo padrão de `generateWebhookToken`). Reusar `triggers.webhookToken` ou
criar coluna `publicToken` numa migration nova — decisão de modelagem.

**Rate limit**: `rateLimit({ key: "form:${token}", limit: 30, windowSeconds: 60 })`
— mais agressivo que webhook porque é human-facing.

**Mount**: importar em `src/index.ts` junto com o `webhookRouter`.

---

### 3.2 `chat_trigger` — Chat embedded com SSE

**Migration nova** (`drizzle/00XX_chat_messages.sql`):
```sql
CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  session_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_session_idx ON chat_messages(trigger_id, session_id, created_at);
```

Adicionar `chatMessages` table em `src/db/schema.ts` correspondente.

**Config esperada**:
```ts
{
  greeting?: string;
  allowFileUpload?: boolean;
  persistHistory?: boolean;     // default true
  responseNodeId?: string;       // qual nó do workflow contém a resposta
}
```

**Novo arquivo**: `src/features/triggers/chat-router.ts`
- `GET /chats/:token` → HTML do chat (lista de mensagens + input + JS de
  fetch+SSE inline). Reusar `config.greeting` como primeira mensagem.
- `POST /chats/:token/messages` → recebe `{ sessionId, message }`,
  persiste em `chat_messages` (role=user), enfileira run com input
  `{ message, sessionId, history: chat_messages.where(sessionId).limit(20) }`,
  devolve `{ runId, sessionId }`.
- `GET /chats/:token/stream/:sessionId` → SSE; assina `run-events` filtrando
  por `runId` do último run da sessão. Quando `workflow.finished` chega,
  extrai output do nó `config.responseNodeId` (ou último step), persiste como
  `role=assistant` em `chat_messages`, envia evento `message` no SSE.

**Reusar**: `src/lib/run-events.ts` já tem o pubsub Redis pra eventos de run.
A diferença é multiplexar por `runId → sessionId` no router do chat.

**Repository**: `src/features/triggers/chat-messages-repository.ts` com
`create(message)`, `listBySession(triggerId, sessionId, limit)`.

**Rate limit**: por `sessionId` (`chat:${token}:${sessionId}`, 60/min).

---

## 🟡 Fase 4 — Workers de polling (deps externas)

Triggers cobertos: `email_trigger`, `rss_trigger`, `schedule_trigger` (na
verdade cobre cron já — manter por compat semântica).

### 4.1 `email_trigger` — IMAP poller

**Deps novas**:
```json
"imapflow": "^1.0.0",
"mailparser": "^3.6.0",
"@types/mailparser": "^3.4.0"
```

**Credenciais**: NÃO armazenar `password` em `triggers.config` em texto puro.
Opções:
1. **Recomendado**: referenciar `environment_variables` por nome (`{ host, port,
   secure, user, passwordVar: "GMAIL_PASS" }`). Worker resolve a var por
   `environmentId` do trigger no boot.
2. Estender `database_connections` pra aceitar `kind: "imap"` (sobrecarrega
   a tabela, mas reusa o `lib/crypto.ts` existente).

**Config esperada** (opção 1):
```ts
{
  host: string;
  port: number;
  secure: boolean;
  user: string;
  passwordVar: string;   // nome da env var
  folder?: string;        // default "INBOX"
  markSeen?: boolean;     // default true
  pollIntervalSeconds?: number;  // default 60
}
```

**Novo script**: `scripts/imap-worker.ts`
- No boot: `triggersRepository.listEnabledByType("email_trigger")`.
- Para cada trigger: cria conexão `imapflow`, abre `INBOX` (ou folder),
  registra `mailEvent` handler.
- A cada mensagem nova: parse via `mailparser`, enfileira run com input
  `{ from, to, subject, text, html, attachments, headers, uid }`.
- Marca como `\Seen` se `markSeen` true.
- Reconnect-on-fail com backoff exponencial (1s → 30s → 5min).

**Sincronização**: precisa reagir a triggers criados/atualizados/removidos
sem reboot. Solução compartilhada com Fase 5 — ver "Trigger updates pubsub"
abaixo.

**Adicionar ao `package.json`**:
```json
"start:imap": "bun run scripts/imap-worker.ts",
"imap": "bun run --watch scripts/imap-worker.ts"
```

---

### 4.2 `rss_trigger` — RSS/Atom poller

**Deps novas**:
```json
"rss-parser": "^3.13.0"
```

**Config esperada**:
```ts
{
  url: string;
  pollIntervalMinutes?: number;   // default 15
  // lastSeenGuid armazenado em triggers.config pelo worker — não setado pelo usuário
  lastSeenGuid?: string;
  lastPolledAt?: string;
}
```

**Novo script**: `scripts/rss-worker.ts`
- Loop `setInterval` baseado no `pollIntervalMinutes` de cada trigger.
- Fetch feed via `rss-parser`, ordena por `pubDate` desc, processa itens
  até bater o `lastSeenGuid` armazenado.
- Para cada item novo: enfileira run com input
  `{ title, link, pubDate, content, guid, categories }`.
- Após processar, atualiza `triggers.config.lastSeenGuid` e `lastPolledAt`
  com o `triggersRepository.updateRaw()`.

**Fan-out**: um único worker pode tocar todos os triggers RSS (são leves).
Não precisa N processos.

**Adicionar ao `package.json`**: `start:rss`, `rss`.

---

## 🟡 Fase 5 — Listeners persistentes (deps já existentes)

Triggers cobertos: `postgres_trigger`, `redis_trigger`.

### 5.1 `postgres_trigger` — LISTEN/NOTIFY

**Sem deps novas** — `postgres` já está no projeto.

**Config esperada**:
```ts
{
  connectionRef: string;   // nome lógico resolvido por databaseConnectionsRepository
  channel: string;
}
```

**Novo script**: `scripts/pg-listener-worker.ts`
- Lista triggers via `listEnabledByType("postgres_trigger")`.
- Para cada um: resolve `connectionRef` via `databaseConnectionsRepository.resolve(workflowId, ref, environmentId)`.
- Abre conexão dedicada (`postgres()` com `max: 1`), executa `LISTEN <channel>`.
- No evento `notify`: enfileira run com input `{ channel, payload, processId }`.
- Heartbeat ping a cada 30s pra detectar conexão morta.
- Reconnect-on-fail com backoff.

**Limitação**: uma conexão TCP por trigger ativo. Em escala (>100 triggers
LISTEN), considerar multiplexação via um único proxy interno.

---

### 5.2 `redis_trigger` — Pub/Sub

**Sem deps novas** — `ioredis` já está no projeto.

**Config esperada**:
```ts
{
  connectionRef: string;   // se NULL, usa o Redis do BullMQ (não recomendado)
  channel?: string;        // alternativo a pattern
  pattern?: string;        // psubscribe quando dado
}
```

**Novo script**: `scripts/redis-listener-worker.ts`
- Mesmo modelo do pg-listener — uma conexão Redis Subscriber por trigger.
- `SUBSCRIBE channel` ou `PSUBSCRIBE pattern`.
- No `message`: enfileira run com input `{ channel, message }` (ou `{ pattern,
  channel, message }` no psubscribe).

---

## 🛠 Infra compartilhada Fases 4+5

### Trigger updates pubsub

Pollers e listeners precisam reagir a `triggers` criados/atualizados/removidos
sem precisar de reboot. Solução:

1. Novo canal Redis: `trigger-updates`.
2. `triggersController.create/update/remove` publica `{ id, type, action }`
   nesse canal **depois** do commit no DB.
3. Cada worker subscribe e filtra por `type` que ele cuida:
   - `imap-worker` reage a `type === "email_trigger"`
   - `rss-worker` reage a `type === "rss_trigger"`
   - etc.
4. Ação `create` → conecta; `update` → reconecta com nova config;
   `remove` → desconecta.

**Arquivo sugerido**: `src/lib/trigger-updates.ts` com `publish()` e
`subscribe(typeFilter, handler)`.

### Deployment

Cada novo worker é um processo separado. Em prod:
- Adicionar ao `Dockerfile` / `docker-compose.yml` os novos serviços.
- Em k8s: novo `Deployment` por worker (escala independente).
- Logs unificados via `pino` já configurado.

---

## 🧪 Testes mínimos por fase

### Fase 3
- `tests/form-trigger.test.ts`: render do HTML por config, POST com required
  faltando devolve 400, POST OK enfileira job.
- `tests/chat-trigger.test.ts`: POST persiste mensagem, GET stream recebe
  evento quando run termina.

### Fase 4
- `tests/rss-parser.test.ts`: parse de feed canônico (XML fixture),
  dedup por `lastSeenGuid`.
- IMAP é difícil sem servidor — pular ou usar `testcontainers/greenmail`.

### Fase 5
- `tests/pg-listener.test.ts`: testcontainer já existe pra Postgres, basta
  abrir LISTEN, fazer NOTIFY, asserir enqueue.
- Mesmo padrão pra Redis.

---

## 📝 Pontos de atenção transversais

1. **Cleanup ao deletar trigger**: hoje `remove()` no controller só limpa
   scheduler (cron+interval). Estender pra notificar via `trigger-updates`
   pubsub assim que existir.

2. **Multi-org isolation**: `fanOutErrorTriggers` em `scripts/worker.ts:158`
   já filtra por `organizationId`. Replicar essa checagem em todos os novos
   workers — nunca disparar trigger de org A com payload de org B.

3. **Encryption de credenciais**: `lib/crypto.ts` (`encryptString`/
   `decryptString`) é a fonte. Não improvisar. Se config IMAP precisa de
   secrets diretos (não via env var), reusar o pattern do
   `databaseConnectionsRepository`.

4. **Rate limiting de runs**: novos triggers HTTP devem usar `rateLimit()`.
   Pollers/listeners não — eles já são autocontidos.

5. **UI de configuração**: cada novo tipo precisa de um painel no front
   (parecido com `webhook-trigger-extras.tsx`). Isso é escopo separado — o
   TODO do front deve listar.

---

## Ordem sugerida de execução

1. **Fase 3.1** (`form_trigger`) — menor risco, valida o padrão de rota
   pública sem novas deps.
2. **Fase 3.2** (`chat_trigger`) — exige nova tabela, mas reusa infra de
   `run-events`.
3. **Infra de pubsub** (`trigger-updates`) — desbloqueia Fase 4+5 sem
   workarounds.
4. **Fase 5** (pg + redis listeners) — usa deps já existentes.
5. **Fase 4** (IMAP + RSS) — última porque adiciona 3 deps externas.
