CREATE TABLE "delivery_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"jira_agent_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"credential_secret_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_check_status" text DEFAULT 'not_checked' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD CONSTRAINT "delivery_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD CONSTRAINT "delivery_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD CONSTRAINT "delivery_connections_jira_agent_id_agents_id_fk" FOREIGN KEY ("jira_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD CONSTRAINT "delivery_connections_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_connections_project_idx" ON "delivery_connections" USING btree ("company_id","project_id");--> statement-breakpoint
CREATE INDEX "delivery_connections_company_idx" ON "delivery_connections" USING btree ("company_id");