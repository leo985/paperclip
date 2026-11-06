CREATE TABLE "analysis_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"input_digest" text NOT NULL,
	"content_digest" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analysis_executions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"request_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"demand_no" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"dispatch_id" uuid,
	"active_run_id" uuid,
	"capability_id" text,
	"registry_revision" integer,
	"snapshot" jsonb,
	"delivery" jsonb,
	"publication" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analysis_decisions" ADD CONSTRAINT "analysis_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_decisions" ADD CONSTRAINT "analysis_decisions_execution_id_analysis_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."analysis_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_decisions" ADD CONSTRAINT "analysis_decisions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_executions" ADD CONSTRAINT "analysis_executions_id_issues_id_fk" FOREIGN KEY ("id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_executions" ADD CONSTRAINT "analysis_executions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_executions" ADD CONSTRAINT "analysis_executions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_executions" ADD CONSTRAINT "analysis_executions_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_executions" ADD CONSTRAINT "analysis_executions_active_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_decision_version_uq" ON "analysis_decisions" USING btree ("execution_id","run_id","key","content_digest");--> statement-breakpoint
CREATE INDEX "analysis_decision_list_idx" ON "analysis_decisions" USING btree ("company_id","execution_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_execution_request_uq" ON "analysis_executions" USING btree ("company_id","request_id");--> statement-breakpoint
CREATE INDEX "analysis_execution_list_idx" ON "analysis_executions" USING btree ("company_id","project_id","created_at");