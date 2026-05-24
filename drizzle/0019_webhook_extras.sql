ALTER TABLE "triggers" ADD COLUMN "allowed_methods" text[] DEFAULT ARRAY['POST']::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "hmac_secret" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "trigger_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_trigger_id_triggers_id_fk" FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;--> statement-breakpoint
CREATE INDEX "workflow_runs_trigger_id_idx" ON "workflow_runs" ("trigger_id");