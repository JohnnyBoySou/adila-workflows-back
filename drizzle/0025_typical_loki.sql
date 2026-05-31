CREATE TABLE "template_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"template_id" uuid NOT NULL,
	"purchased_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'brl' NOT NULL,
	"stripe_session_id" text,
	"stripe_payment_intent_id" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"category" text DEFAULT 'Geral' NOT NULL,
	"tier" text DEFAULT 'free' NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"icon" text DEFAULT 'Workflow' NOT NULL,
	"accent_color" text DEFAULT '#6366f1' NOT NULL,
	"definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"node_count" integer DEFAULT 0 NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "webhook_path" text;--> statement-breakpoint
ALTER TABLE "template_purchases" ADD CONSTRAINT "template_purchases_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_purchases" ADD CONSTRAINT "template_purchases_template_id_workflow_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_purchases" ADD CONSTRAINT "template_purchases_purchased_by_user_id_fk" FOREIGN KEY ("purchased_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_purchases_org_template_uq" ON "template_purchases" USING btree ("organization_id","template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_purchases_session_uq" ON "template_purchases" USING btree ("stripe_session_id");--> statement-breakpoint
CREATE INDEX "template_purchases_org_idx" ON "template_purchases" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_templates_slug_uq" ON "workflow_templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "workflow_templates_tier_idx" ON "workflow_templates" USING btree ("tier");--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_webhook_path_unique" UNIQUE("webhook_path");