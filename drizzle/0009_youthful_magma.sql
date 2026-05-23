CREATE TABLE "database_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid NOT NULL,
	"environment_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"encrypted_connection_string" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "database_connections" ADD CONSTRAINT "database_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "db_connections_wf_env_name_uq" ON "database_connections" USING btree ("workflow_id","environment_id","name");--> statement-breakpoint
CREATE INDEX "db_connections_workflow_idx" ON "database_connections" USING btree ("workflow_id");