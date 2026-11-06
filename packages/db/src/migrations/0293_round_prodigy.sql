CREATE TABLE "run_usage_observations" (
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"digest" text NOT NULL,
	"event_id" uuid NOT NULL,
	CONSTRAINT "run_usage_observations_run_id_sequence_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "run_usage_observations" ADD CONSTRAINT "run_usage_observations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage_observations" ADD CONSTRAINT "run_usage_observations_event_id_cost_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."cost_events"("id") ON DELETE no action ON UPDATE no action;