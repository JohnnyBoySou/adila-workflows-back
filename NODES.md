# Nós do motor de workflows

Catálogo de todos os tipos de nó suportados pelo motor de execução.

A **fonte da verdade** é `src/lib/engine/types.ts` (a tupla `nodeTypes`), que
define quais `type` o executor reconhece. Cada nó tem um handler na tabela de
despacho `nodeHandlers` (`src/lib/engine/nodes/index.ts`). Os rótulos, descrições
e categorias visíveis ao usuário vêm da biblioteca do editor
(`front/app/components/flow/node-library.ts`) e são mantidos alinhados 1:1 com
estes tipos.

> Total: **72 tipos** de nó.

## Convenções

- **Tipo** — o identificador canônico persistido em `definition.nodes[].type`.
- **Gatilho** — ponto de entrada do run (`TRIGGER_NODE_TYPES`). O executor elege
  o primeiro nó a rodar entre estes; em runtime os handlers de gatilho são
  _passthrough_ (a entrada já chega resolvida pelo poller/listener/webhook).
- **Visual** — nó puramente de editor (`visualNodeTypes`). Não executa; o
  executor pula e qualquer aresta apontando pra ele vira no-op.
- **env** — variáveis que o handler lê de `context.env` (validadas na aba
  "Conexões" do workflow contra o environment ativo).
- **conexão** — credencial tipada exigida (`postgres` ou `redis`), resolvida via
  `config.connectionRef`. A connection string nunca trafega pela API HTTP.

> **Aliases legados:** definições antigas/importadas podem trazer tipos curtos.
> São normalizados pro canônico na hidratação, no schema de config e no
> `normalizeDefinition` — e o próximo save persiste o tipo canônico.
> Atualmente: `http` → `http_request`.

---

## Gatilhos

Pontos de entrada do workflow.

| Tipo | Rótulo | Descrição |
|------|--------|-----------|
| `start` | Início (manual) | Disparado pelo botão Play do editor |
| `manual_trigger` | Rodar agora | Disparo manual com payload default opcional (testes e ad-hoc) |
| `webhook_trigger` | Webhook | URL pública com token, métodos configuráveis, HMAC e tester integrado |
| `schedule_trigger` | Agendamento (cron) | Disparado em horários definidos por cron |
| `interval_trigger` | Intervalo | Disparado a cada N segundos/minutos/horas |
| `email_trigger` | Novo e-mail | Dispara quando chega e-mail em caixa IMAP |
| `form_trigger` | Formulário | Disparado por submissão de form público |
| `chat_trigger` | Chat | Disparado por mensagem em janela de chat |
| `error_trigger` | On error | Dispara quando outro workflow falha |
| `workflow_called_trigger` | Chamado por workflow | Entrada quando outro workflow invoca este |
| `rss_trigger` | RSS | Dispara em novo item de feed RSS/Atom |
| `postgres_trigger` | Postgres LISTEN | Dispara em NOTIFY no canal Postgres |
| `redis_trigger` | Redis Pub/Sub | Dispara em mensagem em canal Redis |

## Ações

I/O externo: HTTP, código, mensageria, armazenamento.

| Tipo | Rótulo | Descrição | Requisitos |
|------|--------|-----------|------------|
| `http_request` | Requisição HTTP | Chama uma API externa | — |
| `code` | Código | Executa JavaScript arbitrário | — |
| `respond_to_webhook` | Responder webhook | Envia resposta HTTP custom no modo sync | — |
| `email_send` | Enviar e-mail | Envia e-mail via SMTP configurado | env: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` |
| `slack_webhook` | Slack | Posta mensagem em Incoming Webhook do Slack | — |
| `discord_webhook` | Discord | Posta mensagem em Webhook do Discord | — |
| `telegram_send` | Telegram | Envia mensagem via Bot API do Telegram | — |
| `s3` | S3 | get/put/delete/list em buckets S3-compatíveis | env: `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`, `AWS_ENDPOINT_URL` |
| `pdf_extract` | PDF Extract | Extrai texto e metadados de um PDF | — |
| `websocket` | WebSocket | Conecta, envia e opcionalmente coleta respostas | — |

## Banco de Dados

Conectores de banco. Exigem credencial tipada (`config.connectionRef`).

| Tipo | Rótulo | Descrição | Conexão |
|------|--------|-----------|---------|
| `postgres` | Postgres | Executa SQL em um banco Postgres | `postgres` |
| `db_query` | DB Query | Monte SELECT/INSERT/UPDATE/DELETE visualmente, sem escrever SQL | `postgres` |
| `redis` | Redis | Operação de chave/valor ou lista | `redis` |

## Lógica

Controle de fluxo: condições, loops, espera, término.

| Tipo | Rótulo | Descrição |
|------|--------|-----------|
| `if` | Condição | Bifurca em true/false por regra |
| `switch` | Switch | Múltiplos caminhos por valor |
| `split_in_batches` | Loop em lotes | Itera array em batches |
| `wait` | Aguardar | Pausa por intervalo ou até horário |
| `noop` | No-op | Passa adiante sem efeito |
| `execute_workflow` | Sub-workflow | Invoca outro workflow e aguarda |
| `stop_and_error` | Parar com erro | Aborta o run com mensagem custom (validation gate) |
| `end` | Fim | Encerra o workflow |

## Dados

Manipulação de payload local — sem I/O externo.

| Tipo | Rótulo | Descrição |
|------|--------|-----------|
| `set_variable` | Variável | Define ou atualiza variáveis do run |
| `date_time` | Data e hora | Parse, format, diff, add em datas |
| `crypto` | Crypto | Hash, HMAC, UUID, base64 |
| `item_lists` | Listas | Filtra, ordena, fatia, distinct |
| `aggregate` | Agregação | Sum, avg, min, max, group by |
| `filter` | Filtrar | Mantém apenas itens que casam com a regra |
| `sort` | Ordenar | Ordena itens por campo ascendente ou descendente |
| `limit` | Limitar | Mantém apenas os primeiros N itens |
| `remove_duplicates` | Remover duplicados | Deduplica itens por valor ou campo |
| `merge` | Mesclar | Combina dois conjuntos por append, merge ou join |
| `split_out` | Split out | Explode um array em itens individuais |
| `compare_datasets` | Comparar datasets | Diff entre dois conjuntos: novos, removidos, alterados |
| `rename_keys` | Renomear chaves | Reescreve nomes de campos do payload |
| `transform` | Transformar | Mapper declarativo: reescreve a forma do payload sem código |
| `edit_fields` | Editar campos | Adiciona, remove ou altera campos do item |
| `json` | JSON | Parse, stringify e extração via JSONPath |
| `xml` | XML | Parse e build de documentos XML |
| `csv` | CSV | Lê ou gera CSV/TSV com cabeçalho |
| `html_extract` | HTML Extract | Extrai dados de HTML via seletores CSS |
| `markdown` | Markdown | Converte entre Markdown e HTML |
| `text_manipulation` | Texto | Replace, split, join, case, trim, regex |
| `math` | Matemática | Avalia expressões e funções numéricas |
| `shuffle` | Embaralhar | Reordena aleatoriamente itens do array |
| `template` | Template | Renderiza string com placeholders `{{ ... }}` |
| `yaml` | YAML | Parse e stringify de documentos YAML |
| `jwt` | JWT | Assina, verifica ou decodifica JSON Web Tokens |
| `url_tools` | URL Tools | Parse, build, encode e query string de URLs |
| `uuid` | UUID | Gera identificadores únicos (v4) |
| `random` | Aleatório | Inteiro, float, string, bytes ou pick aleatório |
| `compression` | Compressão | gzip/deflate compress e decompress |

## IA

Blocos estilo LangChain: chat, agente, embeddings, vetores, memória, docs.

| Tipo | Rótulo | Descrição |
|------|--------|-----------|
| `ai_chat` | Chat IA | Anthropic / OpenAI chat completion |
| `ai_agent` | Agente IA | LLM com loop de ferramentas (tool calling até maxSteps) |
| `embeddings` | Embeddings | Gera vetores via OpenAI |
| `vector_store` | Vector store | Insert / search em pgvector |
| `chat_memory` | Memória de chat | Histórico de mensagens em Postgres |
| `document_loader` | Document loader | Chunking de texto pra RAG |

## Anotações (visuais)

Não executam — servem só ao editor. Pulados pelo executor.

| Tipo | Rótulo | Descrição |
|------|--------|-----------|
| `sticky_note` | Sticky note | Anotação rápida em post-it |
| `container` | Frame / Grupo | Circula uma área para agrupar nós |
