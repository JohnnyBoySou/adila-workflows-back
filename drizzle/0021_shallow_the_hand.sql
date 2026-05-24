-- Reconciliação idempotente: o journal marcava 0019 como aplicada, mas o
-- DB ficou sem as colunas. Em vez de mexer no journal, reaplica com
-- IF NOT EXISTS — seguro mesmo em bancos que já têm tudo.
ALTER TABLE "triggers"
  ADD COLUMN IF NOT EXISTS "allowed_methods" text[] DEFAULT ARRAY['POST']::text[] NOT NULL;
--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN IF NOT EXISTS "hmac_secret" text;
--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN IF NOT EXISTS "trigger_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow_runs"
    ADD CONSTRAINT "workflow_runs_trigger_id_triggers_id_fk"
    FOREIGN KEY ("trigger_id") REFERENCES "public"."triggers"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_runs_trigger_id_idx"
  ON "workflow_runs" ("trigger_id");
