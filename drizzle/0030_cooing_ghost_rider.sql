-- Reconciliação de drift: copilot_* e template_ratings existem no schema.ts mas
-- nunca tiveram migration (foram aplicadas via db:push). Este migration é
-- IDEMPOTENTE — CREATE TABLE IF NOT EXISTS com FKs inline. Em bancos onde as
-- tabelas já existem (dev/prod via db:push) é no-op; num banco novo criado só
-- por migrations, cria tudo. FKs inline evitam o problema de idempotência do
-- ADD CONSTRAINT (que não tem IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "copilot_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
	"workflow_id" uuid REFERENCES "workflows"("id") ON DELETE cascade,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "copilot_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL REFERENCES "copilot_conversations"("id") ON DELETE cascade,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "copilot_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
	"provider" text DEFAULT 'openai' NOT NULL,
	"api_key_encrypted" text,
	"model" text DEFAULT 'gpt-4.1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_settings_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL REFERENCES "workflow_templates"("id") ON DELETE cascade,
	"organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
	"user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
	"score" integer NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_conversations_scope_idx" ON "copilot_conversations" USING btree ("organization_id","user_id","workflow_id","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "copilot_messages_conversation_idx" ON "copilot_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "template_ratings_template_user_uq" ON "template_ratings" USING btree ("template_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "template_ratings_template_idx" ON "template_ratings" USING btree ("template_id");
