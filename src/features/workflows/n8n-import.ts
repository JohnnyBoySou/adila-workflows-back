/**
 * Importer de workflows do n8n.
 *
 * Recebe o JSON exportado pelo n8n (estrutura `{ name, nodes[], connections{}, pinData?, settings?, staticData?, tags? }`)
 * e produz um `definition` no formato que o nosso editor/executor consomem,
 * preservando o JSON original em `definition.source` pra round-trip lossless.
 *
 * Mapeamento de tipos:
 *  - Tipos com tradução nativa (TYPE_MAP) viram o equivalente da nossa enum.
 *  - Tipos sem mapeamento entram como `noop` com `originalType`/`parameters`
 *    preservados em config — o editor renderiza, o executor pula com warning.
 *
 * Campos n8n preservados:
 *  - `pinData`        → `definition.pinData`
 *  - `staticData`     → `definition.staticData`
 *  - `settings`       → `definition.settings` (errorWorkflow, executionOrder, timezone, etc)
 *  - `tags`           → `definition.tags`
 *  - `versionId`      → `definition.n8nVersionId`
 *  - `retryOnFail` / `continueOnFail` / `notes` / `disabled` por nó → `config._retry*` etc
 *
 * Conexões: n8n indexa por *name* do nó; convertemos pra edges (`from`/`to`)
 * usando o `id` (uuid) que o n8n já gera por nó.
 */
import type { WorkflowDefinition } from "../../lib/engine/types";
import { type MappedType, translateN8nParameters } from "./n8n-translators";

// ── shapes parciais do JSON do n8n (validamos só o que usamos) ─────────
interface N8nNode {
  id: string;
  name: string;
  type: string;
  typeVersion?: number;
  position?: [number, number];
  parameters?: Record<string, unknown>;
  webhookId?: string;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
  retryOnFail?: boolean;
  continueOnFail?: boolean;
  maxTries?: number;
  waitBetweenTries?: number;
  alwaysOutputData?: boolean;
  executeOnce?: boolean;
}

interface N8nConnectionTarget {
  node: string;
  type?: string;
  index?: number;
}

interface N8nConnections {
  [sourceName: string]: {
    [outputKind: string]: Array<Array<N8nConnectionTarget> | null>;
  };
}

interface N8nSettings {
  executionOrder?: string;
  saveExecutionProgress?: boolean | string;
  timezone?: string;
  errorWorkflow?: string;
  saveDataSuccessExecution?: string;
  saveDataErrorExecution?: string;
  saveManualExecutions?: boolean;
  callerPolicy?: string;
}

export interface N8nWorkflow {
  name: string;
  nodes: N8nNode[];
  connections?: N8nConnections;
  settings?: N8nSettings;
  active?: boolean;
  pinData?: Record<string, unknown>;
  staticData?: Record<string, unknown> | null;
  tags?: Array<{ name?: string; id?: string } | string>;
  versionId?: string;
  meta?: Record<string, unknown>;
}

// ── tabela de mapeamento ───────────────────────────────────────────────
// MappedType é exportado por n8n-translators — fonte única. Adicionar entrada
// aqui sem registrar tradutor lá é capturado pelo typecheck do TRANSLATORS.
const TYPE_MAP: Record<string, MappedType> = {
  // ── triggers ──────────────────────────────────────────────────────────
  "n8n-nodes-base.webhook": "webhook_trigger",
  "n8n-nodes-base.manualTrigger": "manual_trigger",
  "n8n-nodes-base.start": "start", // legado v0
  "n8n-nodes-base.scheduleTrigger": "schedule_trigger",
  "n8n-nodes-base.cron": "schedule_trigger", // legado
  "n8n-nodes-base.intervalTrigger": "interval_trigger",
  "n8n-nodes-base.interval": "interval_trigger", // legado
  "n8n-nodes-base.errorTrigger": "error_trigger",
  "n8n-nodes-base.executeWorkflowTrigger": "manual_trigger",
  "n8n-nodes-base.rssFeedReadTrigger": "rss_trigger",
  "n8n-nodes-base.emailReadImap": "email_trigger",
  "n8n-nodes-base.formTrigger": "form_trigger",
  "n8n-nodes-base.n8nFormTrigger": "form_trigger",
  "@n8n/n8n-nodes-langchain.chatTrigger": "start",

  // ── HTTP / IO ─────────────────────────────────────────────────────────
  "n8n-nodes-base.httpRequest": "http_request",
  "n8n-nodes-base.httpRequestTool": "http_request",
  "n8n-nodes-base.respondToWebhook": "respond_to_webhook",
  "n8n-nodes-base.webhookResponse": "respond_to_webhook",

  // ── flow control ──────────────────────────────────────────────────────
  "n8n-nodes-base.if": "if",
  "n8n-nodes-base.filter": "filter",
  "n8n-nodes-base.switch": "switch",
  "n8n-nodes-base.wait": "wait",
  "n8n-nodes-base.noOp": "noop",
  "n8n-nodes-base.stopAndError": "stop_and_error",
  "n8n-nodes-base.merge": "merge",
  "n8n-nodes-base.splitOut": "split_out",
  "n8n-nodes-base.splitInBatches": "split_in_batches",
  "n8n-nodes-base.executeWorkflow": "execute_workflow",

  // ── transformações ────────────────────────────────────────────────────
  "n8n-nodes-base.set": "set_variable",
  "n8n-nodes-base.editFields": "edit_fields",
  "n8n-nodes-base.renameKeys": "rename_keys",
  "n8n-nodes-base.sort": "sort",
  "n8n-nodes-base.limit": "limit",
  "n8n-nodes-base.removeDuplicates": "remove_duplicates",
  "n8n-nodes-base.compareDatasets": "compare_datasets",
  "n8n-nodes-base.itemLists": "item_lists",
  "n8n-nodes-base.aggregate": "aggregate",
  "n8n-nodes-base.summarize": "aggregate",

  // ── código / template ─────────────────────────────────────────────────
  "n8n-nodes-base.code": "code",
  "n8n-nodes-base.function": "code", // legado
  "n8n-nodes-base.functionItem": "code", // legado
  "n8n-nodes-base.template": "template",
  "n8n-nodes-base.markdown": "markdown",

  // ── parsers / formatos ────────────────────────────────────────────────
  "n8n-nodes-base.xml": "xml",
  "n8n-nodes-base.html": "html_extract",
  "n8n-nodes-base.htmlExtract": "html_extract",
  "n8n-nodes-base.spreadsheetFile": "csv",
  "n8n-nodes-base.csv": "csv",
  "n8n-nodes-base.readPDF": "pdf_extract",
  "n8n-nodes-base.extractFromFile": "pdf_extract",
  "n8n-nodes-base.compression": "compression",

  // ── DBs ───────────────────────────────────────────────────────────────
  "n8n-nodes-base.postgres": "postgres",
  "n8n-nodes-base.postgresTool": "postgres",
  "n8n-nodes-base.redis": "redis",
  "n8n-nodes-base.redisTool": "redis",

  // ── storage / cloud ───────────────────────────────────────────────────
  "n8n-nodes-base.awsS3": "s3",
  "n8n-nodes-base.s3": "s3",

  // ── comunicação ───────────────────────────────────────────────────────
  "n8n-nodes-base.slack": "slack_webhook",
  "n8n-nodes-base.slackWebhook": "slack_webhook",
  "n8n-nodes-base.discord": "discord_webhook",
  "n8n-nodes-base.discordWebhook": "discord_webhook",
  "n8n-nodes-base.telegram": "telegram_send",
  "n8n-nodes-base.telegramBot": "telegram_send",
  "n8n-nodes-base.emailSend": "email_send",
  "n8n-nodes-base.gmail": "email_send",
  "n8n-nodes-base.gmailTool": "email_send",
  "n8n-nodes-base.smtp": "email_send",

  // ── utilities ─────────────────────────────────────────────────────────
  "n8n-nodes-base.dateTime": "date_time",
  "n8n-nodes-base.dateTimeTool": "date_time",
  "n8n-nodes-base.crypto": "crypto",
  "n8n-nodes-base.jwt": "jwt",
  "n8n-nodes-base.urlTools": "url_tools",
  "n8n-nodes-base.uuid": "uuid",
  "n8n-nodes-base.random": "random",
  "n8n-nodes-base.math": "math",

  // ── visual ────────────────────────────────────────────────────────────
  "n8n-nodes-base.stickyNote": "sticky_note",

  // ── LangChain — chat models / agents → ai_chat (provider inferido) ───
  "@n8n/n8n-nodes-langchain.agent": "ai_agent",
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatAnthropic": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatGoogleGemini": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatGoogleVertex": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatOllama": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatGroq": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatMistralCloud": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatAwsBedrock": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatAzureOpenAi": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatCohere": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatDeepSeek": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatXAiGrok": "ai_chat",
  "@n8n/n8n-nodes-langchain.lmChatOpenRouter": "ai_chat",
  "@n8n/n8n-nodes-langchain.openAi": "ai_chat",
  "@n8n/n8n-nodes-langchain.chainLlm": "ai_chat",
  "@n8n/n8n-nodes-langchain.chainSummarization": "ai_chat",
  "@n8n/n8n-nodes-langchain.chainRetrievalQa": "ai_chat",
  "@n8n/n8n-nodes-langchain.informationExtractor": "ai_chat",
  "@n8n/n8n-nodes-langchain.textClassifier": "ai_chat",
  "@n8n/n8n-nodes-langchain.sentimentAnalysis": "ai_chat",

  // ── LangChain — embeddings ───────────────────────────────────────────
  "@n8n/n8n-nodes-langchain.embeddingsOpenAi": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsCohere": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsHuggingFaceInference": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsAwsBedrock": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsGoogleGemini": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsGoogleVertex": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsMistralCloud": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsOllama": "embeddings",
  "@n8n/n8n-nodes-langchain.embeddingsAzureOpenAi": "embeddings",

  // ── LangChain — memory ───────────────────────────────────────────────
  "@n8n/n8n-nodes-langchain.memoryPostgresChat": "chat_memory",
  "@n8n/n8n-nodes-langchain.memoryBufferWindow": "chat_memory",
  "@n8n/n8n-nodes-langchain.memoryRedisChat": "chat_memory",
  "@n8n/n8n-nodes-langchain.memoryMongoDbChat": "chat_memory",
  "@n8n/n8n-nodes-langchain.memoryXataChat": "chat_memory",
  "@n8n/n8n-nodes-langchain.memoryZep": "chat_memory",
  "@n8n/n8n-nodes-langchain.memoryMotorhead": "chat_memory",

  // ── LangChain — vector stores ────────────────────────────────────────
  "@n8n/n8n-nodes-langchain.vectorStorePGVector": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStorePinecone": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreQdrant": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreWeaviate": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreInMemory": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreSupabase": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreMongoDbAtlas": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreRedis": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreZep": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreMilvus": "vector_store",
  "@n8n/n8n-nodes-langchain.vectorStoreAzureAiSearch": "vector_store",

  // ── LangChain — document loaders / text splitters ────────────────────
  "@n8n/n8n-nodes-langchain.documentDefaultDataLoader": "document_loader",
  "@n8n/n8n-nodes-langchain.documentBinaryInputLoader": "document_loader",
  "@n8n/n8n-nodes-langchain.documentJsonInputLoader": "document_loader",
  "@n8n/n8n-nodes-langchain.textSplitterRecursiveCharacterTextSplitter": "document_loader",
  "@n8n/n8n-nodes-langchain.textSplitterCharacterTextSplitter": "document_loader",
  "@n8n/n8n-nodes-langchain.textSplitterTokenSplitter": "document_loader",

  // ── LangChain — tools / parsers / retrievers → noop (preservados) ────
  "@n8n/n8n-nodes-langchain.toolCalculator": "noop",
  "@n8n/n8n-nodes-langchain.toolWikipedia": "noop",
  "@n8n/n8n-nodes-langchain.toolWolframAlpha": "noop",
  "@n8n/n8n-nodes-langchain.toolSerpApi": "noop",
  "@n8n/n8n-nodes-langchain.toolSearXNG": "noop",
  "@n8n/n8n-nodes-langchain.toolWorkflow": "noop",
  "@n8n/n8n-nodes-langchain.toolCode": "noop",
  "@n8n/n8n-nodes-langchain.toolHttpRequest": "noop",
  "@n8n/n8n-nodes-langchain.toolMcp": "noop",
  "@n8n/n8n-nodes-langchain.toolThink": "noop",
  "@n8n/n8n-nodes-langchain.toolVectorStore": "noop",
  "@n8n/n8n-nodes-langchain.outputParserStructured": "noop",
  "@n8n/n8n-nodes-langchain.outputParserAutoFixing": "noop",
  "@n8n/n8n-nodes-langchain.outputParserItemList": "noop",
  "@n8n/n8n-nodes-langchain.retrieverVectorStore": "noop",
  "@n8n/n8n-nodes-langchain.retrieverMultiQuery": "noop",
  "@n8n/n8n-nodes-langchain.retrieverContextualCompression": "noop",
  "@n8n/n8n-nodes-langchain.retrieverWorkflow": "noop",
  "@n8n/n8n-nodes-langchain.rerankerCohere": "noop",
  "@n8n/n8n-nodes-langchain.modelSelector": "noop",
};

// Tipos puramente visuais — descartados no import (atualmente nenhum;
// sticky-note vira nó pra preservar layout).
const SKIPPED_TYPES = new Set<string>();

export interface ImportSummary {
  total: number;
  mapped: number;
  unsupported: number;
  skipped: number;
  unsupportedTypes: string[];
  pinDataKeys: number;
  hasStaticData: boolean;
  hasErrorWorkflow: boolean;
  tagCount: number;
}

export interface ImportResult {
  definition: WorkflowDefinition & {
    source: { format: "n8n"; raw: N8nWorkflow };
    importMeta: ImportSummary;
    pinData?: Record<string, unknown>;
    staticData?: Record<string, unknown> | null;
    settings?: Record<string, unknown>;
    tags?: string[];
    n8nVersionId?: string;
  };
  name: string;
  summary: ImportSummary;
}

// ── conversor ──────────────────────────────────────────────────────────
export function importN8nWorkflow(raw: unknown): ImportResult | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "invalid_payload" };

  // n8n também exporta envelope `{ workflows: [...] }` para múltiplos workflows.
  let wf = raw as Partial<N8nWorkflow> & { workflows?: unknown[] };
  if (Array.isArray(wf.workflows) && wf.workflows.length > 0) {
    wf = wf.workflows[0] as Partial<N8nWorkflow>;
  }

  // `nodes` é o único campo realmente obrigatório — o n8n às vezes exporta
  // sem `name` (copy-paste do canvas, fragmentos parciais, exports antigos).
  // Aceitamos e geramos um nome default em vez de rejeitar.
  if (!Array.isArray(wf.nodes)) {
    return { error: "invalid_n8n_workflow" };
  }
  const workflowName =
    typeof wf.name === "string" && wf.name.trim() ? wf.name : "Workflow importado do n8n";
  wf = { ...wf, name: workflowName } as Partial<N8nWorkflow>;

  // Garante que wf.nodes existe como array — Partial<N8nWorkflow> torna tudo
  // opcional. Sem isso, o resto do código teria que checar undefined em N
  // lugares. Aqui congelamos como const local pra TS estreitar o tipo.
  const wfNodes = Array.isArray(wf.nodes) ? wf.nodes : [];

  // Tags podem vir como string[] ou objeto[]; normalizamos pra string[]
  const tagNames: string[] = [];
  if (Array.isArray(wf.tags)) {
    for (const t of wf.tags) {
      if (typeof t === "string") tagNames.push(t);
      else if (t && typeof t === "object" && typeof t.name === "string") tagNames.push(t.name);
    }
  }

  const summary: ImportSummary = {
    total: wfNodes.length,
    mapped: 0,
    unsupported: 0,
    skipped: 0,
    unsupportedTypes: [],
    pinDataKeys: wf.pinData && typeof wf.pinData === "object" ? Object.keys(wf.pinData).length : 0,
    hasStaticData:
      !!wf.staticData && typeof wf.staticData === "object" && Object.keys(wf.staticData).length > 0,
    hasErrorWorkflow: !!(
      wf.settings &&
      typeof wf.settings.errorWorkflow === "string" &&
      wf.settings.errorWorkflow
    ),
    tagCount: tagNames.length,
  };
  const unsupportedSet = new Set<string>();

  // Constrói name→id pra resolver conexões + pinData (n8n usa nome como chave em ambos).
  const nameToId = new Map<string, string>();
  for (const n of wfNodes) {
    if (n && typeof n.name === "string" && typeof n.id === "string") {
      nameToId.set(n.name, n.id);
    }
  }

  // Posições do n8n vêm em coordenadas absolutas muito distantes da origem
  // (ex: [6624, 2944]). Normalizamos transladando todas pra começarem perto
  // de (0,0), preservando o layout relativo.
  const positions = wfNodes
    .map((n) => n?.position)
    .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2);
  const offsetX = positions.length > 0 ? Math.min(...positions.map((p) => p[0])) : 0;
  const offsetY = positions.length > 0 ? Math.min(...positions.map((p) => p[1])) : 0;

  const buildEditor = (n: N8nNode): Record<string, unknown> => {
    const editor: Record<string, unknown> = {
      position: n.position
        ? { x: n.position[0] - offsetX, y: n.position[1] - offsetY }
        : { x: 0, y: 0 },
      title: n.name,
    };
    if (n.notes) editor.notes = n.notes;
    return editor;
  };

  // Re-map pinData de `name` (n8n) → `id` (engine) pra editor poder usar.
  const pinDataById: Record<string, unknown> = {};
  if (wf.pinData && typeof wf.pinData === "object") {
    for (const [nodeName, data] of Object.entries(wf.pinData)) {
      const id = nameToId.get(nodeName);
      if (id) pinDataById[id] = data;
    }
  }

  const nodes: WorkflowDefinition["nodes"] = [];
  for (const n of wfNodes) {
    if (!n || typeof n.id !== "string" || typeof n.type !== "string") continue;
    if (SKIPPED_TYPES.has(n.type)) {
      summary.skipped++;
      continue;
    }
    const mapped = TYPE_MAP[n.type];

    // Metadados de runtime preservados em todos os nós
    const runtimeMeta: Record<string, unknown> = {};
    if (n.retryOnFail) runtimeMeta.retryOnFail = true;
    if (typeof n.maxTries === "number") runtimeMeta.maxTries = n.maxTries;
    if (typeof n.waitBetweenTries === "number") runtimeMeta.waitBetweenTries = n.waitBetweenTries;
    if (n.continueOnFail) runtimeMeta.continueOnFail = true;
    if (n.alwaysOutputData) runtimeMeta.alwaysOutputData = true;
    if (n.executeOnce) runtimeMeta.executeOnce = true;
    if (typeof n.typeVersion === "number") runtimeMeta.n8nTypeVersion = n.typeVersion;
    if (n.webhookId) runtimeMeta.n8nWebhookId = n.webhookId;
    if (n.credentials) runtimeMeta.n8nCredentials = n.credentials;

    if (mapped) {
      const translated = translateN8nParameters(mapped, n.parameters, nameToId);
      const editor = buildEditor(n);

      // Sticky note: o editor espera `text` (não `content`) e width/height
      // em `_editor`, não no top-level. Também mapeia color numérica n8n → nome.
      if (mapped === "sticky_note") {
        const t = translated as Record<string, unknown>;
        if (typeof t.width === "number") editor.width = t.width;
        if (typeof t.height === "number") editor.height = t.height;
        // n8n sticky color: 1=yellow, 2=orange, 3=red, 4=blue, 5=cyan, 6=green, 7=purple
        const colorName =
          typeof t.color === "number"
            ? (["yellow", "orange", "red", "blue", "cyan", "green", "purple"][t.color - 1] ??
              "yellow")
            : typeof t.color === "string"
              ? t.color
              : undefined;
        nodes.push({
          id: n.id,
          type: mapped,
          config: {
            text: typeof t.content === "string" ? t.content : "",
            ...(colorName !== undefined && { color: colorName }),
            n8nName: n.name,
            originalType: n.type,
            ...(n.disabled && { disabled: true }),
            ...(Object.keys(runtimeMeta).length > 0 && { _runtime: runtimeMeta }),
            _editor: editor,
          },
        });
        summary.mapped++;
        continue;
      }

      nodes.push({
        id: n.id,
        type: mapped,
        config: {
          ...translated,
          n8nName: n.name,
          originalType: n.type,
          ...(n.disabled && { disabled: true }),
          ...(Object.keys(runtimeMeta).length > 0 && { _runtime: runtimeMeta }),
          _editor: editor,
        },
      });
      summary.mapped++;
    } else {
      // Tipos sem mapeamento entram como `noop` — o editor preserva e o
      // executor pula com warning. Antes era `unsupported`, mas isso quebrava
      // a normalização (não é valor válido na enum NodeType).
      nodes.push({
        id: n.id,
        type: "noop",
        config: {
          n8nName: n.name,
          originalType: n.type,
          parameters: n.parameters ?? {},
          _unsupported: true,
          ...(Object.keys(runtimeMeta).length > 0 && { _runtime: runtimeMeta }),
          _editor: buildEditor(n),
        },
      });
      summary.unsupported++;
      unsupportedSet.add(n.type);
    }
  }

  // Conexões → edges. n8n estrutura: connections[sourceName][outputKind][outputIndex] = [targets].
  // Engine usa nextLabel específico por tipo:
  //   - if/filter:  "true" (idx 0) | "false" (idx 1)
  //   - switch:     "0", "1", ... (numéricos, alinhados com `cases` do tradutor)
  //   - default:    sem label (linear) ou índice como string
  const sourceTypeByName = new Map<string, string>();
  // Pra switch n8n: idx do ramo de fallback (quando `fallbackOutput === "extra"`).
  // Esse ramo é o último branch da conexão e precisa virar label "default"
  // pra casar com o `nextLabel: "default"` do switchHandler. Sem isso, a aresta
  // do fallback fica com label numérico ("5") e o handler não acha → cai no
  // primeiro edge e roteia errado.
  const switchFallbackIdxByName = new Map<string, number>();
  for (const n of wfNodes) {
    if (n && typeof n.name === "string" && typeof n.type === "string") {
      sourceTypeByName.set(n.name, n.type);
      if (n.type === "n8n-nodes-base.switch") {
        const params = (n.parameters ?? {}) as Record<string, unknown>;
        const rules = (params.rules as Record<string, unknown> | undefined)?.values;
        const opts = (params.options ?? {}) as Record<string, unknown>;
        if (Array.isArray(rules) && opts.fallbackOutput === "extra") {
          switchFallbackIdxByName.set(n.name, rules.length);
        }
      }
    }
  }

  const edges: WorkflowDefinition["edges"] = [];
  const connections = wf.connections ?? {};
  for (const [sourceName, outputs] of Object.entries(connections)) {
    const fromId = nameToId.get(sourceName);
    if (!fromId) continue;
    const sourceType = sourceTypeByName.get(sourceName) ?? "";
    const isIfLike = sourceType === "n8n-nodes-base.if" || sourceType === "n8n-nodes-base.filter";
    const isSwitch = sourceType === "n8n-nodes-base.switch";
    const switchFallbackIdx = isSwitch ? (switchFallbackIdxByName.get(sourceName) ?? -1) : -1;
    for (const [outputKind, branches] of Object.entries(outputs)) {
      if (!Array.isArray(branches)) continue;
      branches.forEach((branch, branchIdx) => {
        if (!Array.isArray(branch)) return;
        for (const target of branch) {
          if (!target || typeof target.node !== "string") continue;
          const toId = nameToId.get(target.node);
          if (!toId) continue;
          let label: string | undefined;
          if (outputKind !== "main") {
            label = outputKind;
          } else if (isIfLike) {
            // n8n if/filter: idx 0 = true, idx 1 = false (engine espera essas strings)
            label = branchIdx === 0 ? "true" : "false";
          } else if (isSwitch && branchIdx === switchFallbackIdx) {
            // switch fallback (`fallbackOutput: "extra"`) → "default" pra
            // alinhar com `switchHandler` que retorna `nextLabel: "default"`.
            label = "default";
          } else if (branches.length > 1) {
            label = String(branchIdx);
          }
          edges.push({ from: fromId, to: toId, label });
        }
      });
    }
  }

  // oxlint-disable-next-line unicorn/no-array-sort
  summary.unsupportedTypes = [...unsupportedSet].sort();

  return {
    name: wf.name ?? "Imported workflow",
    summary,
    definition: {
      nodes,
      edges,
      source: { format: "n8n", raw: wf as N8nWorkflow },
      importMeta: summary,
      ...(Object.keys(pinDataById).length > 0 && { pinData: pinDataById }),
      ...(wf.staticData &&
        typeof wf.staticData === "object" &&
        Object.keys(wf.staticData as Record<string, unknown>).length > 0 && {
          staticData: wf.staticData as Record<string, unknown>,
        }),
      ...(wf.settings &&
        Object.keys(wf.settings).length > 0 && {
          settings: wf.settings as Record<string, unknown>,
        }),
      ...(tagNames.length > 0 && { tags: tagNames }),
      ...(typeof wf.versionId === "string" && { n8nVersionId: wf.versionId }),
    },
  };
}
