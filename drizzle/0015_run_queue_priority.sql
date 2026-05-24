ALTER TABLE "workflow_runs"
ADD COLUMN IF NOT EXISTS "queue_priority" integer DEFAULT 5 NOT NULL;
