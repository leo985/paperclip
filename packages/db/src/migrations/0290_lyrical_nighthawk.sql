CREATE TABLE "seat_execution_permits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"lease_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"stop_reason" text,
	"process_exit_observed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD CONSTRAINT "seat_execution_permits_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD CONSTRAINT "seat_execution_permits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD CONSTRAINT "seat_execution_permits_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD CONSTRAINT "seat_execution_permits_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seat_execution_permits_run_idx" ON "seat_execution_permits" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "seat_execution_permits_agent_idx" ON "seat_execution_permits" USING btree ("company_id","agent_id","expires_at");