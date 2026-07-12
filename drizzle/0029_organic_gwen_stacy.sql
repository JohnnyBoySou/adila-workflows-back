ALTER TABLE "workflow_run_steps" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD COLUMN "total_tokens" integer;--> statement-breakpoint
ALTER TABLE "workflow_run_steps" ADD COLUMN "model" text;
