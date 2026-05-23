import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth-schema";

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
    // Snapshot — nunca é atualizado depois da criação.
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("workflow_versions_wf_version_uq").on(t.workflowId, t.version)],
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
    key: text("key").notNull(),
    // MVP: armazenado em texto. TODO: cifrar em repouso quando isSecret=true
    // (chave simétrica em env, AES-256-GCM via Bun crypto).
    value: text("value").notNull(),
    isSecret: boolean("is_secret").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("env_vars_env_key_uq").on(t.environmentId, t.key)],
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
  input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
  output: jsonb("output").$type<Record<string, unknown> | null>(),
  // Erro estruturado: { message, stack?, code? }.
  error: jsonb("error").$type<Record<string, unknown> | null>(),
  triggeredBy: text("triggered_by").references(() => user.id, { onDelete: "set null" }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export type WorkflowRunStep = typeof workflowRunSteps.$inferSelect;
export type NewWorkflowRunStep = typeof workflowRunSteps.$inferInsert;

// ──────────────────────────────── triggers ────────────────────────────────

export const triggerType = ["cron", "webhook"] as const;
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
    name: text("name").notNull(),
    type: text("type").$type<TriggerType>().notNull(),
    enabled: boolean("enabled").notNull().default(true),

    // Cron — preenchido apenas quando type='cron'.
    cronExpression: text("cron_expression"),
    timezone: text("timezone").default("UTC"),

    // Webhook — token único usado na URL pública /hooks/:token.
    webhookToken: text("webhook_token").unique(),

    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("triggers_webhook_token_uq").on(t.webhookToken)],
);

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
