CREATE TABLE "run_usage_checkpoints" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cached_input_tokens" integer NOT NULL,
	"model" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"scope" jsonb NOT NULL,
	"final_digest" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD COLUMN "tree_stop_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD COLUMN "tree_stop_proof" jsonb;--> statement-breakpoint
ALTER TABLE "seat_execution_permits" ADD COLUMN "ledger_scope" jsonb;--> statement-breakpoint
ALTER TABLE "run_usage_checkpoints" ADD CONSTRAINT "run_usage_checkpoints_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage_checkpoints" ADD CONSTRAINT "run_usage_checkpoints_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage_checkpoints" ADD CONSTRAINT "run_usage_checkpoints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;