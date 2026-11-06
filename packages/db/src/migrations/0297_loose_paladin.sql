ALTER TABLE "delivery_connections" ALTER COLUMN "jira_agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD COLUMN "jira_base_url" text;--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD COLUMN "jira_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "delivery_connections" ADD CONSTRAINT "delivery_connections_jira_secret_id_company_secrets_id_fk" FOREIGN KEY ("jira_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;