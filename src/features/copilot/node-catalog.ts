/**
 * Catálogo de node types conhecidos pelo Noud.
 *
 * Fonte da verdade pareada com o `NODE_LIBRARY` do front
 * (`front/app/components/flow/node-library.ts`): o agente só pode propor
 * `nodeType`s que existam aqui, porque o `applyProposal` do canvas usa a
 * entry correspondente do `NODE_LIBRARY` para construir o nó. Propor um tipo
 * fora desta lista resultaria numa operação inaplicável.
 *
 * Mantido enxuto de propósito — é um resumo (tipo + rótulo + categoria +
 * descrição + dica de config), não o schema completo de cada nó. Entra no
 * system prompt; quanto mais compacto, mais barato e focado o turno.
 */

export type CatalogEntry = {
  type: string;
  label: string;
  category: string;
  description: string;
  /** Dica curta dos campos de `config` mais relevantes (quando aplicável). */
  configHint?: string;
};

export const NODE_CATALOG: CatalogEntry[] = [
  // ── Gatilhos ──────────────────────────────────────────────────────────
  { type: "start", label: "Início (manual)", category: "Gatilhos", description: "Disparado pelo botão Play do editor" },
  { type: "manual_trigger", label: "Rodar agora", category: "Gatilhos", description: "Disparo manual com payload default opcional" },
  { type: "webhook_trigger", label: "Webhook", category: "Gatilhos", description: "URL pública com token, métodos configuráveis e HMAC", configHint: "method, path, auth" },
  { type: "schedule_trigger", label: "Agendamento (cron)", category: "Gatilhos", description: "Disparado em horários definidos por cron", configHint: "cron" },
  { type: "interval_trigger", label: "Intervalo", category: "Gatilhos", description: "Disparado a cada N segundos/minutos/horas", configHint: "every, unit" },
  { type: "email_trigger", label: "Novo e-mail", category: "Gatilhos", description: "Dispara quando chega e-mail em caixa IMAP" },
  { type: "form_trigger", label: "Formulário", category: "Gatilhos", description: "Disparado por submissão de form público" },
  { type: "chat_trigger", label: "Chat", category: "Gatilhos", description: "Disparado por mensagem em janela de chat" },
  { type: "error_trigger", label: "On error", category: "Gatilhos", description: "Dispara quando outro workflow falha" },
  { type: "workflow_called_trigger", label: "Chamado por workflow", category: "Gatilhos", description: "Entrada quando outro workflow invoca este" },
  { type: "rss_trigger", label: "RSS", category: "Gatilhos", description: "Dispara em novo item de feed RSS/Atom", configHint: "url" },
  { type: "postgres_trigger", label: "Postgres LISTEN", category: "Gatilhos", description: "Dispara em NOTIFY no canal Postgres", configHint: "channel" },
  { type: "redis_trigger", label: "Redis Pub/Sub", category: "Gatilhos", description: "Dispara em mensagem em canal Redis", configHint: "channel" },

  // ── Ações ─────────────────────────────────────────────────────────────
  { type: "http_request", label: "Requisição HTTP", category: "Ações", description: "Chama uma API externa", configHint: "method, url, headers, body" },
  { type: "code", label: "Código", category: "Ações", description: "Executa JavaScript arbitrário", configHint: "code" },
  { type: "respond_to_webhook", label: "Responder webhook", category: "Ações", description: "Envia resposta HTTP custom no modo sync", configHint: "statusCode, body" },
  { type: "email_send", label: "Enviar e-mail", category: "Ações", description: "Envia e-mail via SMTP configurado", configHint: "to, subject, body" },
  { type: "slack_webhook", label: "Slack", category: "Ações", description: "Posta mensagem em Incoming Webhook do Slack", configHint: "webhookUrl, text" },
  { type: "discord_webhook", label: "Discord", category: "Ações", description: "Posta mensagem em Webhook do Discord", configHint: "webhookUrl, content" },
  { type: "telegram_send", label: "Telegram", category: "Ações", description: "Envia mensagem via Bot API do Telegram", configHint: "chatId, text" },
  { type: "s3", label: "S3", category: "Ações", description: "get/put/delete/list em buckets S3-compatíveis", configHint: "operation, key" },
  { type: "pdf_extract", label: "PDF Extract", category: "Ações", description: "Extrai texto e metadados de um PDF" },
  { type: "websocket", label: "WebSocket", category: "Ações", description: "Conecta, envia e opcionalmente coleta respostas", configHint: "url, message" },

  // ── Banco de Dados ────────────────────────────────────────────────────
  { type: "postgres", label: "Postgres", category: "Banco de Dados", description: "Executa SQL em um banco Postgres", configHint: "connectionRef, query" },
  { type: "db_query", label: "DB Query", category: "Banco de Dados", description: "Monta SELECT/INSERT/UPDATE/DELETE visualmente", configHint: "connectionRef, operation, table" },
  { type: "redis", label: "Redis", category: "Banco de Dados", description: "Operação de chave/valor ou lista", configHint: "connectionRef, operation, key" },

  // ── Lógica ────────────────────────────────────────────────────────────
  { type: "if", label: "Condição", category: "Lógica", description: "Bifurca em true/false por regra. Tem duas saídas: true e false", configHint: "conditions" },
  { type: "switch", label: "Switch", category: "Lógica", description: "Múltiplos caminhos por valor", configHint: "rules" },
  { type: "split_in_batches", label: "Loop em lotes", category: "Lógica", description: "Itera array em batches", configHint: "batchSize" },
  { type: "wait", label: "Aguardar", category: "Lógica", description: "Pausa por intervalo ou até horário", configHint: "duration, unit" },
  { type: "noop", label: "No-op", category: "Lógica", description: "Passa adiante sem efeito" },
  { type: "execute_workflow", label: "Sub-workflow", category: "Lógica", description: "Invoca outro workflow e aguarda", configHint: "workflowId" },
  { type: "stop_and_error", label: "Parar com erro", category: "Lógica", description: "Aborta o run com mensagem custom", configHint: "message" },
  { type: "end", label: "Fim", category: "Lógica", description: "Encerra o workflow" },

  // ── Dados ─────────────────────────────────────────────────────────────
  { type: "set_variable", label: "Variável", category: "Dados", description: "Define ou atualiza variáveis do run", configHint: "name, value" },
  { type: "date_time", label: "Data e hora", category: "Dados", description: "Parse, format, diff, add em datas", configHint: "operation" },
  { type: "crypto", label: "Crypto", category: "Dados", description: "Hash, HMAC, UUID, base64", configHint: "operation" },
  { type: "item_lists", label: "Listas", category: "Dados", description: "Filtra, ordena, fatia, distinct" },
  { type: "aggregate", label: "Agregação", category: "Dados", description: "Sum, avg, min, max, group by", configHint: "operation, field" },
  { type: "filter", label: "Filtrar", category: "Dados", description: "Mantém apenas itens que casam com a regra", configHint: "conditions" },
  { type: "sort", label: "Ordenar", category: "Dados", description: "Ordena itens por campo asc/desc", configHint: "field, order" },
  { type: "limit", label: "Limitar", category: "Dados", description: "Mantém apenas os primeiros N itens", configHint: "max" },
  { type: "remove_duplicates", label: "Remover duplicados", category: "Dados", description: "Deduplica itens por valor ou campo", configHint: "field" },
  { type: "merge", label: "Mesclar", category: "Dados", description: "Combina dois conjuntos por append, merge ou join", configHint: "mode" },
  { type: "split_out", label: "Split out", category: "Dados", description: "Explode um array em itens individuais", configHint: "field" },
  { type: "compare_datasets", label: "Comparar datasets", category: "Dados", description: "Diff entre dois conjuntos: novos, removidos, alterados" },
  { type: "rename_keys", label: "Renomear chaves", category: "Dados", description: "Reescreve nomes de campos do payload", configHint: "mappings" },
  { type: "transform", label: "Transformar", category: "Dados", description: "Mapper declarativo: reescreve a forma do payload" },
  { type: "edit_fields", label: "Editar campos", category: "Dados", description: "Adiciona, remove ou altera campos do item", configHint: "fields" },
  { type: "json", label: "JSON", category: "Dados", description: "Parse, stringify e extração via JSONPath", configHint: "operation" },
  { type: "xml", label: "XML", category: "Dados", description: "Parse e build de documentos XML", configHint: "operation" },
  { type: "csv", label: "CSV", category: "Dados", description: "Lê ou gera CSV/TSV com cabeçalho", configHint: "operation" },
  { type: "html_extract", label: "HTML Extract", category: "Dados", description: "Extrai dados de HTML via seletores CSS", configHint: "selectors" },
  { type: "markdown", label: "Markdown", category: "Dados", description: "Converte entre Markdown e HTML", configHint: "direction" },
  { type: "text_manipulation", label: "Texto", category: "Dados", description: "Replace, split, join, case, trim, regex", configHint: "operation" },
  { type: "math", label: "Matemática", category: "Dados", description: "Avalia expressões e funções numéricas", configHint: "expression" },
  { type: "shuffle", label: "Embaralhar", category: "Dados", description: "Reordena aleatoriamente itens do array" },
  { type: "template", label: "Template", category: "Dados", description: "Renderiza string com placeholders {{ ... }}", configHint: "template" },
  { type: "yaml", label: "YAML", category: "Dados", description: "Parse e stringify de documentos YAML", configHint: "operation" },
  { type: "jwt", label: "JWT", category: "Dados", description: "Assina, verifica ou decodifica JSON Web Tokens", configHint: "operation" },
  { type: "url_tools", label: "URL Tools", category: "Dados", description: "Parse, build, encode e query string de URLs", configHint: "operation" },
  { type: "uuid", label: "UUID", category: "Dados", description: "Gera identificadores únicos (v4)" },
  { type: "random", label: "Aleatório", category: "Dados", description: "Inteiro, float, string, bytes ou pick aleatório", configHint: "type" },
  { type: "compression", label: "Compressão", category: "Dados", description: "gzip/deflate compress e decompress", configHint: "operation" },

  // ── IA ────────────────────────────────────────────────────────────────
  { type: "ai_chat", label: "Chat IA", category: "IA", description: "Anthropic / OpenAI chat completion", configHint: "provider, model, prompt" },
  { type: "ai_agent", label: "Agente IA", category: "IA", description: "LLM com loop de ferramentas (tool calling até maxSteps)", configHint: "provider, model, system, tools" },
  { type: "embeddings", label: "Embeddings", category: "IA", description: "Gera vetores via OpenAI", configHint: "input" },
  { type: "vector_store", label: "Banco Vetorial", category: "Banco de Dados", description: "Insert / search em banco vetorial (pgvector)", configHint: "connectionRef, operation" },
  { type: "chat_memory", label: "Memória de chat", category: "IA", description: "Histórico de mensagens em Postgres" },
  { type: "document_loader", label: "Document loader", category: "IA", description: "Chunking de texto pra RAG", configHint: "chunkSize" },

  // ── Anotações ─────────────────────────────────────────────────────────
  { type: "sticky_note", label: "Sticky note", category: "Anotações", description: "Anotação rápida em post-it", configHint: "text" },
];

/** Conjunto de tipos válidos para checagem rápida. */
export const KNOWN_NODE_TYPES: ReadonlySet<string> = new Set(NODE_CATALOG.map((e) => e.type));

/** Renderiza o catálogo como texto compacto para o system prompt. */
export function renderCatalogForPrompt(): string {
  const byCategory = new Map<string, CatalogEntry[]>();
  for (const entry of NODE_CATALOG) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const lines: string[] = [];
  for (const [category, entries] of byCategory) {
    lines.push(`### ${category}`);
    for (const e of entries) {
      const hint = e.configHint ? ` — config: ${e.configHint}` : "";
      lines.push(`- \`${e.type}\` (${e.label}): ${e.description}${hint}`);
    }
  }
  return lines.join("\n");
}
