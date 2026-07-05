# Triggers — Dispatch (plano MVP)

> Revisado em 2026-07-05 para foco em MVP. As Fases 3/4/5 originais (rotas HTTP
> de form/chat, pollers IMAP/RSS, listeners postgres/redis) foram **adiadas
> para pós-lançamento** — resumidas no fim deste doc como backlog. O objetivo
> agora é lançar só com o que dispara de verdade.

---

## Estado atual — o que dispara hoje

Estes tipos têm mecanismo de dispatch completo e entram no MVP:

| Tipo | Como dispara | Entrada |
| --- | --- | --- |
| `manual` / start | Botão "Executar" no editor | endpoint de run manual |
| `webhook` | HTTP público por token | `src/features/triggers/webhook-router.ts` |
| `cron` / `schedule_trigger` | Agendador (BullMQ repeat) | `src/features/triggers/scheduler.ts` |
| `interval_trigger` | Agendador (intervalo) | `scheduler.ts` |
| `error_trigger` | Outro workflow falha | engine (on-error) |
| `workflow_called_trigger` | `workflow_call` de outro workflow | engine |

## Desativado no MVP — sem dispatch ainda

Estes 6 tipos existem no schema e no editor, mas **não têm entrada de dispatch**.
Criá-los geraria um trigger órfão que nunca dispara. Por isso ficam **ocultos e
bloqueados** até a infra correspondente ser entregue:

`form_trigger` · `chat_trigger` · `email_trigger` · `rss_trigger` ·
`postgres_trigger` · `redis_trigger`

### Como estão desativados (já implementado)

- **Front — some da paleta:** flag `FEATURES.advancedTriggers`
  (`front/app/lib/features.ts`, default OFF via `VITE_FEATURE_ADVANCED_TRIGGERS`).
  Enquanto OFF, `node-library-drawer.tsx` filtra esses nós de `VISIBLE_LIBRARY`.
- **Back — rejeita na API:** `UNAVAILABLE_TRIGGER_TYPES` em
  `src/features/triggers/controller.ts`. `create()` retorna
  `trigger_type_unavailable` → **HTTP 422**, mesmo que o front seja contornado.
  Workflows já salvos que referenciem esses nós continuam renderizando; só não
  se cria trigger novo.

### Como reativar um tipo (quando o dispatch existir)

1. Implementar a entrada de dispatch do tipo (ver backlog abaixo).
2. Remover o tipo de `UNAVAILABLE_TRIGGER_TYPES` no controller **e** do set em
   `node-library-drawer.tsx`.
3. Ligar `VITE_FEATURE_ADVANCED_TRIGGERS=true` (ou migrar o tipo para o
   `NODE_LIBRARY` sem gate, se todos já estiverem prontos e a flag puder morrer).

---

## Backlog pós-MVP (resumido)

Cada item é uma trilha independente. Ordem sugerida por esforço/valor.

### 1. `form_trigger` — formulário público (HTTP, sem deps)
Rota Elysia análoga a `webhook-router.ts`: lookup por token único em `triggers`,
render de um form a partir de `triggers.config` (campos tipados) e enqueue em
`workflowQueue` no submit. Reaproveita `webhookToken`. Menor esforço, alto valor
no-code. **Melhor candidato ao primeiro trigger pós-MVP.**

### 2. `chat_trigger` — endpoint de chat (HTTP, sem deps)
Mesmo padrão de rota por token; recebe mensagens e enfileira run com o payload
como input. Difere do form só no shape de config/resposta.

### 3. `rss_trigger` — polling de feed
Worker de polling periódico (reusa a lane `scraping`): busca o feed, deduplica
por GUID/link, enfileira run por item novo. Precisa de estado de "último item
visto" por trigger.

### 4. `email_trigger` — IMAP
Poller IMAP por caixa configurada; enfileira run por e-mail novo. Requer
credenciais IMAP (integrar com o CRUD de conexões, gated por `FEATURES.database`).

### 5. `postgres_trigger` / `redis_trigger` — listeners
`postgres_trigger`: `LISTEN/NOTIFY` numa conexão dedicada. `redis_trigger`:
`SUBSCRIBE` em canal. Ambos dependem de conexão tipada (`requiresConnection`),
então já estão sob `FEATURES.database` além do gate de triggers. São os de maior
esforço operacional (conexão persistente + reconexão + fan-out por trigger).

### Infra compartilhada (quando ≥1 poller/listener existir)
Os pollers/listeners precisam reagir a mudanças de trigger (criar/editar/desligar)
sem reboot. Um canal pub/sub `trigger-updates` (Redis) publicado pelo controller
no create/update/delete resolve isso. Só vale construir quando o primeiro
poller/listener entrar — form/chat (HTTP) não precisam disso.
