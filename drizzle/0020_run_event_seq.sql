-- Sequência monotônica por evento — usada pelo SSE para resume via
-- `Last-Event-Id`. bigserial = bigint + sequence + default + not null,
-- backfilla rows existentes automaticamente em ordem de inserção física.
ALTER TABLE "workflow_run_events" ADD COLUMN "seq" bigserial NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_run_events_run_seq_idx"
  ON "workflow_run_events" ("run_id", "seq");
