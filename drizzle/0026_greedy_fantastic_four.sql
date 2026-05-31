ALTER TABLE "workflow_templates" ADD COLUMN "clone_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "stars" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "rating_count" integer DEFAULT 0 NOT NULL;