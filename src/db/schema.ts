import {
  type AnyPgColumn,
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organization, user } from "./auth-schema";

// ── Tipos compartilhados ──────────────────────────────────────────────────────

export type WebhookFieldSchema = {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array";
  description?: string;
  // string
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  // number/integer
  minimum?: number;
  maximum?: number;
};

export type WebhookInputSchema = {
  properties: Record<string, WebhookFieldSchema>;
  required?: string[];
};

// ───────────────────────────── folders ─────────────────────────────

export const folders = pgTable("folders", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Self-reference: subfolders. Deletar pai → filhos viram raiz (parent_id NULL).
  parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, {
    onDelete: "set null",
  }),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

// ─────────────────────────── environments ──────────────────────────

export const environmentKind = ["development", "test", "stage", "production"] as const;
export type EnvironmentKind = (typeof environmentKind)[number];

export const environments = pgTable(
  "environments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Slug curto, único por org (ex: "production", "stage", "qa-1").
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<EnvironmentKind>().notNull().default("development"),
    description: text("description"),
    // Apenas um ambiente default por org (garantido na aplicação; índice abaixo só evita duplicar slug).
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("environments_org_slug_uq").on(t.organizationId, t.slug)],
);

export type Environment = typeof environments.$inferSelect;
export type NewEnvironment = typeof environments.$inferInsert;

// ───────────────────────────── workflows ────────────────────────────

export const workflowStatus = ["draft", "active", "paused", "archived"] as const;
export type WorkflowStatus = (typeof workflowStatus)[number];

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  // Pasta opcional. Deletar a pasta → workflow vira raiz (folder_id NULL).
  folderId: uuid("folder_id").references(() => folders.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").$type<WorkflowStatus>().notNull().default("draft"),
  // Definição do fluxo (nós, conexões, parâmetros). JSONB pra evoluir sem migrations.
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull().default({}),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type Workflow = typeof workflows.$inferSelect;
export type NewWorkflow = typeof workflows.$inferInsert;

// ─────────────────────── workflow_versions ───────────────────────
// Snapshot imutável do `definition` num momento no tempo. Cada `run`
// referencia a versão que executou — histórico fica fiel mesmo depois
// que o draft do workflow muda.

export const workflowVersions = pgTable(
  "workflow_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    // Número monotônico por workflow (1, 2, 3…), calculado na criação.
    version: integer("version").notNull(),
    // Rótulo opcional ("v1.0", "produção quinta-feira").
    name: text("name"),
    // Notas da versão / changelog (Markdown aceito).
    notes: text("notes"),
    // Snapshot — nunca é atualizado depois da criação.
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    // SHA-256 do definition serializado com chaves ordenadas. Permite
    // detectar publishes idempotentes (mesmo draft → mesma versão).
    definitionHash: text("definition_hash"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workflow_versions_wf_version_uq").on(t.workflowId, t.version),
    // Índice parcial NÃO-único sobre (workflow_id, definition_hash) para
    // publishes anônimas (name IS NULL). Acelera lookup por hash e documenta a
    // intenção de dedupe.
    //
    // Por que NÃO é `uniqueIndex`: a idempotência do `publish` só compara o draft
    // contra a ÚLTIMA versão (`findLatest`), não contra todas. O fluxo
    // `restore()` + `publish` legitimamente republica um `definition` idêntico a
    // uma versão ANTIGA (não a latest), gerando duas rows com o mesmo
    // (workflow_id, definition_hash) e name NULL. Um índice único rejeitaria esse
    // insert válido. O backfill + a checagem contra a latest já previnem o caso
    // comum de duplicata; este índice fica não-único de propósito.
    index("workflow_versions_wf_defhash_null_name_idx")
      .on(t.workflowId, t.definitionHash)
      .where(sql`name is null`),
  ],
);

export type WorkflowVersion = typeof workflowVersions.$inferSelect;
export type NewWorkflowVersion = typeof workflowVersions.$inferInsert;

// ──────────────────────── environment_variables ────────────────────────

export const environmentVariables = pgTable(
  "environment_variables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environments.id, { onDelete: "cascade" }),
    // Escopo da variável dentro do ambiente:
    //   NULL        → variável da organização (compartilhada por todos os workflows)
    //   <uuid>      → variável específica do workflow (sobrepõe a da org na resolução)
    // Resolução em runtime: org-level merge workflow-level, workflow vence.
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    // Cifrado em repouso quando isSecret=true (AES-256-GCM, ver lib/crypto).
    value: text("value").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // Unicidade da key por escopo. Índices parciais separados porque o Postgres
  // trata NULL como distinto num índice composto — sem o split, duas vars org
  // com a mesma key (workflowId NULL) não colidiriam.
  (t) => [
    uniqueIndex("env_vars_org_env_key_uq")
      .on(t.organizationId, t.environmentId, t.key)
      .where(sql`${t.workflowId} is null`),
    uniqueIndex("env_vars_wf_env_key_uq")
      .on(t.workflowId, t.environmentId, t.key)
      .where(sql`${t.workflowId} is not null`),
  ],
);

export type EnvironmentVariable = typeof environmentVariables.$inferSelect;
export type NewEnvironmentVariable = typeof environmentVariables.$inferInsert;

// ────────────────────────────── workflow_runs ──────────────────────────

export const workflowRunStatus = ["queued", "running", "success", "failed", "cancelled"] as const;
export type WorkflowRunStatus = (typeof workflowRunStatus)[number];

export const workflowRuns = pgTable("workflow_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  workflowId: uuid("workflow_id")
    .notNull()
    .references(() => workflows.id, { onDelete: "cascade" }),
  // Snapshot imutável que de fato executou. Nullable por compat com runs
  // pré-versionamento; novos runs sempre preenchem.
  workflowVersionId: uuid("workflow_version_id").references(() => workflowVersions.id, {
    onDelete: "restrict",
  }),
  // Ambiente em que rodou — pode virar NULL se o ambiente for apagado.
  environmentId: uuid("environment_id").references(() => environments.id, {
    onDelete: "set null",
  }),
  status: text("status").$type<WorkflowRunStatus>().notNull().default("queued"),
  // Referência ao job BullMQ enquanto a execução está viva.
  jobId: text("job_id"),
  // Prioridade da fila BullMQ: menor número = maior prioridade.
  queuePriority: integer("queue_priority").notNull().default(5),
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb("output").$type<Record<string, unknown> | null>(),
  // Erro estruturado: { message, stack?, code? }.
  error: jsonb("error").$type<Record<string, unknown> | null>(),
  triggeredBy: text("triggered_by").references(() => user.id, { onDelete: "set null" }),
  // Trigger que originou este run (NULL para runs manuais ou pré-feature).
  triggerId: uuid("trigger_id").references((): AnyPgColumn => triggers.id, {
    onDelete: "set null",
  }),
  // Cancelamento cooperativo: o endpoint seta true; o executor checa entre
  // nós e aborta com CancelledError. Worker grava status='cancelled'.
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

// ────────────────────────── workflow_run_steps ──────────────────────────
// Log por nó executado dentro de um run. O motor escreve uma linha por
// node visitado, com input/output/erro/duração — base pro debug visual.

export const workflowRunStepStatus = [
  "pending",
  "running",
  "success",
  "failed",
  "skipped",
] as const;
export type WorkflowRunStepStatus = (typeof workflowRunStepStatus)[number];

export const workflowRunSteps = pgTable("workflow_run_steps", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id")
    .notNull()
    .references(() => workflowRuns.id, { onDelete: "cascade" }),
  // Posição de execução (1, 2, 3…) — ordem estável mesmo com timestamps iguais.
  index: integer("index").notNull(),
  // ID do nó dentro do definition (estável no editor) + tipo (start, http_request, …).
  nodeId: text("node_id").notNull(),
  nodeType: text("node_type").notNull(),
  status: text("status").$type<WorkflowRunStepStatus>().notNull().default("pending"),
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb("output").$type<Record<string, unknown> | null>(),
  // Erro estruturado: { message, stack?, code? }.
  error: jsonb("error").$type<Record<string, unknown> | null>(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  // Consumo de tokens dos nós de IA (ai_chat, ai_agent, embeddings). NULL pra
  // nós que não consomem LLM. `model` guarda o id do modelo (ex.: "claude-sonnet-4-6")
  // pra o custo ser calculado no read a partir da tabela de preço — assim
  // reajuste de preço vale retroativo, sem congelar valor no banco.
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert;

// ────────────────────────── workflow_run_events ──────────────────────────
// Event log append-only por execução. Cada transição relevante vira evento
// (run/step/retry/etc). Fonte para replay, timeline, métricas e analytics.

export const workflowRunEvents = pgTable(
  "workflow_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    nodeId: text("node_id"),
    eventType: text("event_type").notNull(),
    source: text("source").notNull().default("worker"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    // Sequência monotônica global — usada pelo SSE para resume via
    // `Last-Event-Id`. Ordem física de INSERT define ordering dentro do run.
    seq: bigserial("seq", { mode: "number" }).notNull(),
  },
  (t) => [
    index("workflow_run_events_run_occurred_idx").on(t.runId, t.occurredAt),
    index("workflow_run_events_type_idx").on(t.eventType),
    uniqueIndex("workflow_run_events_run_seq_idx").on(t.runId, t.seq),
  ],
);

export type WorkflowRunEvent = typeof workflowRunEvents.$inferSelect;
export type NewWorkflowRunEvent = typeof workflowRunEvents.$inferInsert;

// ───────────────────── collaboration_snapshots ─────────────────────
// Snapshots/patches incrementais de colaboração (Yjs/awareness) por workflow.

export const collaborationSnapshots = pgTable(
  "collaboration_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"snapshot" | "patch">().notNull(),
    updateBase64: text("update_base64").notNull(),
    sourceUserId: text("source_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("collab_snapshots_workflow_created_idx").on(t.workflowId, t.createdAt),
    index("collab_snapshots_kind_idx").on(t.kind),
  ],
);

export type CollaborationSnapshot = typeof collaborationSnapshots.$inferSelect;
export type NewCollaborationSnapshot = typeof collaborationSnapshots.$inferInsert;

// ─────────────────────────── workflow comments ───────────────────────────
// Threads de comentários ancorados em coords do canvas (estilo Figma).
// - Raiz: parentId=null, x/y obrigatórios (posição mundo).
// - Reply: parentId aponta pra raiz, x/y null (herda do pai).
// - mentions: lista de userIds notificados (in-room toast).
// - resolved: marcado na raiz; cascade lógico nas replies via UI.

export const workflowComments = pgTable(
  "workflow_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    parentId: uuid("parent_id"),
    authorId: text("author_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    mentions: text("mentions")
      .array()
      .default(sql`ARRAY[]::text[]`)
      .notNull(),
    x: doublePrecision("x"),
    y: doublePrecision("y"),
    resolved: boolean("resolved").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("workflow_comments_workflow_idx").on(t.workflowId, t.createdAt),
    index("workflow_comments_parent_idx").on(t.parentId),
  ],
);

export type WorkflowComment = typeof workflowComments.$inferSelect;
export type NewWorkflowComment = typeof workflowComments.$inferInsert;

// ─────────────────────────────── copiloto (IA) ───────────────────────────────
// Agente nativo do editor que ajuda a criar/manter nodes via chat.
// - copilotSettings: BYOK por organização (chave do provider criptografada em repouso).
// - copilotConversations: threads por workflow (workflowId setado) ou gerais (workflowId null).
// - copilotMessages: histórico no formato de `parts` do Vercel AI SDK (texto + tool-calls).

export const copilotSettings = pgTable("copilot_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .unique()
    .references(() => organization.id, { onDelete: "cascade" }),
  provider: text("provider").default("openai").notNull(),
  // Chave do provider criptografada via `lib/crypto.ts` (formato `enc:v1:...`).
  // Nunca retornada em claro pela API — mascarada na leitura.
  apiKeyEncrypted: text("api_key_encrypted"),
  model: text("model").default("gpt-4.1").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export type CopilotSettings = typeof copilotSettings.$inferSelect;
export type NewCopilotSettings = typeof copilotSettings.$inferInsert;

export const copilotConversations = pgTable(
  "copilot_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // null = thread geral do usuário; setado = thread acoplada a um workflow.
    workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("copilot_conversations_scope_idx").on(
      t.organizationId,
      t.userId,
      t.workflowId,
      t.updatedAt,
    ),
  ],
);

export type CopilotConversation = typeof copilotConversations.$inferSelect;
export type NewCopilotConversation = typeof copilotConversations.$inferInsert;

export const copilotMessages = pgTable(
  "copilot_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => copilotConversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    // `parts` do AI SDK: blocos de texto + tool-calls (com estado aplicado/descartado).
    parts: jsonb("parts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("copilot_messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

export type CopilotMessage = typeof copilotMessages.$inferSelect;
export type NewCopilotMessage = typeof copilotMessages.$inferInsert;

// ──────────────────────────────── triggers ────────────────────────────────

export const triggerType = [
  "cron",
  "webhook",
  // Disparadores adicionais — config específica em `triggers.config` JSONB.
  "interval_trigger",
  "schedule_trigger",
  "email_trigger",
  "form_trigger",
  "chat_trigger",
  "error_trigger",
  "workflow_called_trigger",
  "rss_trigger",
  "postgres_trigger",
  "redis_trigger",
] as const;
export type TriggerType = (typeof triggerType)[number];

export const triggers = pgTable(
  "triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    // Ambiente em que o trigger executa o workflow. NULL = sem ambiente.
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    /**
     * Snapshot pinado: quando setado, o trigger sempre dispara este
     * `workflow_versions.id`. NULL = comportamento legado, usa a latest
     * (ou auto-publica o draft via ensureLatest). É o pino que torna o
     * promote entre envs explícito — cada env pode rodar uma versão
     * diferente sem mexer no `definition` do workflow.
     */
    workflowVersionId: uuid("workflow_version_id").references(() => workflowVersions.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    type: text("type").$type<TriggerType>().notNull(),
    enabled: boolean("enabled").notNull().default(true),

    // Cron — preenchido apenas quando type='cron'.
    cronExpression: text("cron_expression"),
    timezone: text("timezone").default("UTC"),

    // Config específica por tipo (interval: {every,unit}, email: {host,port,...},
    // rss: {url,pollIntervalMinutes,lastSeenGuid}, etc). JSONB livre — validado
    // por tipo no schema TypeBox e consumido pelo poller/listener correspondente.
    config: jsonb("config")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    // Webhook — token único usado na URL pública /hooks/:token.
    webhookToken: text("webhook_token").unique(),
    /**
     * Path personalizado opcional. Quando setado, o webhook responde também em
     * /hooks/<path> além do token. Útil pra alias amigável (ex.: "clinicare1"
     * em vez de "5b63103cd3ef..."). Único globalmente. Slug ascii [a-z0-9-_].
     */
    webhookPath: text("webhook_path").unique(),
    /**
     * Métodos HTTP aceitos no endpoint público /hooks/:token. Default ['POST'].
     * Validado pelo webhook-router antes de criar o run.
     */
    allowedMethods: text("allowed_methods")
      .array()
      .notNull()
      .default(sql`ARRAY['POST']::text[]`),
    /**
     * Segredo opcional para validação HMAC-SHA256. Quando setado, o webhook-router
     * exige header `X-Signature-256: sha256=<hex>` calculado sobre o raw body.
     */
    hmacSecret: text("hmac_secret"),
    /**
     * ID do node no `definition.nodes[]` ao qual este trigger está associado
     * (tipicamente um `webhook_trigger` ou `cron_trigger`). Nulo em triggers
     * legacy criados antes do modelo trigger-como-node. Texto porque IDs de
     * node no canvas são strings opacas geradas pelo editor.
     */
    nodeId: text("node_id"),
    // 'async' (default): responde 202 imediatamente.
    // 'sync': aguarda o run terminar e devolve o output (ou um respond_to_webhook node).
    webhookResponseMode: text("webhook_response_mode").$type<"async" | "sync">().default("async"),
    // Limite máximo de espera em modo sync. Default 30s; suficiente pra request-response típico.
    webhookResponseTimeoutMs: integer("webhook_response_timeout_ms").default(30_000),
    /**
     * Schema de validação do body de entrada (subconjunto de JSON Schema).
     * Quando definido, o webhook-router valida o body antes de criar o run.
     * Retorna 400 com erros por campo se inválido.
     * Shape: { properties: Record<string, FieldSchema>, required?: string[] }
     */
    inputSchema: jsonb("input_schema").$type<WebhookInputSchema | null>(),

    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("triggers_webhook_token_uq").on(t.webhookToken),
    index("triggers_workflow_version_id_idx").on(t.workflowVersionId),
  ],
);

// FK trigger_id ⇢ triggers.id é adicionada via SQL puro na migração (evita
// ciclo de import na definição de tabela).

export type Trigger = typeof triggers.$inferSelect;
export type NewTrigger = typeof triggers.$inferInsert;

// ─────────────────────────────── audit_logs ───────────────────────────────
// Log de ações sensíveis (criar/atualizar/deletar recursos, rotacionar token,
// cancelar run). Best-effort: falha gravando não derruba o request.
// O actor é o user; pode ser NULL pra ações do sistema (cron, webhook).

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Quem fez. NULL = ação do sistema (cron scheduler, webhook anônimo).
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    // Verbo no formato "<resource>.<verb>" (ex: "workflow.created", "trigger.deleted").
    action: text("action").notNull(),
    // Tipo e id do recurso afetado — id pode ser null pra ações em massa.
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    // Detalhes específicos da ação (diff, nome, etc).
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Listagem por org ordenada por tempo é o caso 99%.
    index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;

// ──────────────────────── database_connections ────────────────────────
// Registro de conexões nomeadas (Postgres/Redis) por workflow.
// Nodes do canvas referenciam por `connectionId` e nunca veem a URL.
//
// Escopo:
//   - (workflowId, environmentId, name) único.
//   - environmentId NULL = fallback default usado quando o run roda num
//     environment sem override específico.
//
// Segurança:
//   - `connectionString` cifrado em repouso via AES-256-GCM (helper em
//     lib/crypto.ts). Chave em ENCRYPTION_KEY env var, idêntica entre back
//     e worker.

// pgvector é Postgres (mesma URL/protocolo/driver) — a distinção é só de
// intenção/UX: o node vector_store filtra por ela. Toda validação e runtime
// trata pgvector idêntico a postgres.
export const databaseConnectionKind = ["postgres", "redis", "pgvector"] as const;
export type DatabaseConnectionKind = (typeof databaseConnectionKind)[number];

export const databaseConnections = pgTable(
  "database_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    // NULL = fallback default (usado quando não há override pro env do run).
    environmentId: uuid("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    kind: text("kind").$type<DatabaseConnectionKind>().notNull(),
    // Cifrado em repouso. Nunca expor cru via API.
    encryptedConnectionString: text("encrypted_connection_string").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Trata env null como valor único — Postgres considera NULL ≠ NULL em
    // unique constraint, então isso aqui não bloqueia múltiplos defaults com
    // o mesmo nome. Resolvido na aplicação (service rejeita duplicatas).
    uniqueIndex("db_connections_wf_env_name_uq").on(t.workflowId, t.environmentId, t.name),
    index("db_connections_workflow_idx").on(t.workflowId),
  ],
);

export type DatabaseConnection = typeof databaseConnections.$inferSelect;
export type NewDatabaseConnection = typeof databaseConnections.$inferInsert;

// ──────────────────────────── workflow_templates ────────────────────────────
// Catálogo GLOBAL de templates de workflow prontos (não pertence a nenhuma org).
// O usuário navega na Store e "instala" um template → cria um workflow novo na
// org dele a partir do `definition` snapshot. Templates "paid" exigem uma
// compra confirmada (ver template_purchases) antes de instalar.

export const templateTier = ["free", "paid"] as const;
export type TemplateTier = (typeof templateTier)[number];

export const workflowTemplates = pgTable(
  "workflow_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Slug estável e único — usado em URLs e no seed idempotente.
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    // Categoria livre para agrupar na vitrine (ex: "Integrações", "IA", "Dados").
    category: text("category").notNull().default("Geral"),
    tier: text("tier").$type<TemplateTier>().notNull().default("free"),
    // Preço em centavos (BRL). 0 para free. Fonte de verdade do valor cobrado.
    priceCents: integer("price_cents").notNull().default(0),
    // Tags para busca/filtro na vitrine.
    tags: jsonb("tags")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Identificador do ícone (lucide) e cor de destaque para o card.
    icon: text("icon").notNull().default("Workflow"),
    accentColor: text("accent_color").notNull().default("#6366f1"),
    // Snapshot do fluxo que será clonado para a org na instalação.
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull().default({}),
    // Metadados de exibição.
    nodeCount: integer("node_count").notNull().default(0),
    // Métricas sociais da vitrine. `cloneCount` é incrementado a cada clone/instalação.
    // `stars` é a média (0–5) e `ratingCount` o total de avaliações que a compõem.
    cloneCount: integer("clone_count").notNull().default(0),
    stars: doublePrecision("stars").notNull().default(0),
    ratingCount: integer("rating_count").notNull().default(0),
    featured: boolean("featured").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    // Quando false, some da vitrine (descontinuado) sem apagar histórico de compras.
    published: boolean("published").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("workflow_templates_slug_uq").on(t.slug),
    index("workflow_templates_tier_idx").on(t.tier),
  ],
);

export type WorkflowTemplate = typeof workflowTemplates.$inferSelect;
export type NewWorkflowTemplate = typeof workflowTemplates.$inferInsert;

// ──────────────────────────── template_purchases ────────────────────────────
// Entitlement: registra que uma org comprou (e pagou) um template "paid".
// Fluxo: cria linha status='pending' ao abrir o checkout Stripe → webhook
// `checkout.session.completed` marca 'paid'. Instalação de template paid só é
// permitida quando existe uma linha 'paid' para (organizationId, templateId).

export const templatePurchaseStatus = ["pending", "paid", "refunded", "failed"] as const;
export type TemplatePurchaseStatus = (typeof templatePurchaseStatus)[number];

export const templatePurchases = pgTable(
  "template_purchases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    templateId: uuid("template_id")
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: "cascade" }),
    // Quem iniciou a compra.
    purchasedBy: text("purchased_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    status: text("status").$type<TemplatePurchaseStatus>().notNull().default("pending"),
    // Valor cobrado no momento da compra (snapshot — preço do template pode mudar).
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("brl"),
    // Identificadores Stripe para reconciliação e idempotência do webhook.
    stripeSessionId: text("stripe_session_id"),
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Uma org compra um template uma vez (entitlement único). Recompra reaproveita a linha.
    uniqueIndex("template_purchases_org_template_uq").on(t.organizationId, t.templateId),
    uniqueIndex("template_purchases_session_uq").on(t.stripeSessionId),
    index("template_purchases_org_idx").on(t.organizationId),
  ],
);

export type TemplatePurchase = typeof templatePurchases.$inferSelect;
export type NewTemplatePurchase = typeof templatePurchases.$inferInsert;

// ──────────────────────────── template_ratings ──────────────────────────────
// Avaliação de um template por um usuário: nota (1–5) + observação opcional.
// Só pode avaliar quem tem direito ao template (free, ou paid já comprado).
// O agregado (stars/ratingCount em workflow_templates) é recalculado a cada
// upsert a partir desta tabela (fonte da verdade das avaliações individuais).

export const templateRatings = pgTable(
  "template_ratings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Nota de 1 a 5 (validada na borda da API via TypeBox).
    score: integer("score").notNull(),
    // Observação/comentário livre (opcional).
    comment: text("comment"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Um usuário avalia um template uma única vez (reavaliar atualiza a linha).
    uniqueIndex("template_ratings_template_user_uq").on(t.templateId, t.userId),
    index("template_ratings_template_idx").on(t.templateId),
  ],
);

export type TemplateRating = typeof templateRatings.$inferSelect;
export type NewTemplateRating = typeof templateRatings.$inferInsert;
