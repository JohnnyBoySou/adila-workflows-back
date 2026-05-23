ALTER TABLE "triggers" ADD COLUMN "webhook_response_mode" text DEFAULT 'async';--> statement-breakpoint
ALTER TABLE "triggers" ADD COLUMN "webhook_response_timeout_ms" integer DEFAULT 30000;