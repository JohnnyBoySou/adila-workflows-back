CREATE TABLE IF NOT EXISTS "workflow_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "workflow_id" uuid NOT NULL,
  "parent_id" uuid,
  "author_id" text NOT NULL,
  "body" text NOT NULL,
  "mentions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
  "x" double precision,
  "y" double precision,
  "resolved" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow_comments" ADD CONSTRAINT "workflow_comments_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow_comments" ADD CONSTRAINT "workflow_comments_workflow_id_fk"
    FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "workflow_comments" ADD CONSTRAINT "workflow_comments_author_id_fk"
    FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_comments_workflow_idx" ON "workflow_comments" ("workflow_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workflow_comments_parent_idx" ON "workflow_comments" ("parent_id");
