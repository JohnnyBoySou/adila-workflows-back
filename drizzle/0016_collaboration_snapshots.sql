CREATE TABLE IF NOT EXISTS "collaboration_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "workflow_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "update_base64" text NOT NULL,
  "source_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collaboration_snapshots" ADD CONSTRAINT "collab_snapshots_org_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collaboration_snapshots" ADD CONSTRAINT "collab_snapshots_workflow_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "collaboration_snapshots" ADD CONSTRAINT "collab_snapshots_source_user_fk" FOREIGN KEY ("source_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_snapshots_workflow_created_idx" ON "collaboration_snapshots" USING btree ("workflow_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "collab_snapshots_kind_idx" ON "collaboration_snapshots" USING btree ("kind");
