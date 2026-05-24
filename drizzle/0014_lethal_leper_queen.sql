CREATE TABLE "collaboration_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"workflow_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"update_base64" text NOT NULL,
	"source_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"node_id" text,
	"event_type" text NOT NULL,
	"source" text DEFAULT 'worker' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "queue_priority" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_versions" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "collaboration_snapshots" ADD CONSTRAINT "collaboration_snapshots_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_snapshots" ADD CONSTRAINT "collaboration_snapshots_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collaboration_snapshots" ADD CONSTRAINT "collaboration_snapshots_source_user_id_user_id_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_run_events" ADD CONSTRAINT "workflow_run_events_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "collab_snapshots_workflow_created_idx" ON "collaboration_snapshots" USING btree ("workflow_id","created_at");--> statement-breakpoint
CREATE INDEX "collab_snapshots_kind_idx" ON "collaboration_snapshots" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "workflow_run_events_run_occurred_idx" ON "workflow_run_events" USING btree ("run_id","occurred_at");--> statement-breakpoint
CREATE INDEX "workflow_run_events_type_idx" ON "workflow_run_events" USING btree ("event_type");