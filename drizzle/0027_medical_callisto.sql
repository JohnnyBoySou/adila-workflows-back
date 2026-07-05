DROP INDEX IF EXISTS "env_vars_env_key_uq";--> statement-breakpoint
ALTER TABLE "environment_variables" ADD COLUMN IF NOT EXISTS "workflow_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "env_vars_org_env_key_uq" ON "environment_variables" USING btree ("organization_id","environment_id","key") WHERE "environment_variables"."workflow_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "env_vars_wf_env_key_uq" ON "environment_variables" USING btree ("workflow_id","environment_id","key") WHERE "environment_variables"."workflow_id" is not null;
