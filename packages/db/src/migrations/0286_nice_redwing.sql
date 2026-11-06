CREATE TABLE "dsp7_managed_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_contents" (
	"position" bigserial NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"stream_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision" text NOT NULL,
	"sequence" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"manifest" jsonb NOT NULL,
	"complete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"stream_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_generation" text NOT NULL,
	"source_offset" bigint NOT NULL,
	"digest" text NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_jira_workloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"owner_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"total" integer NOT NULL,
	"revision" integer NOT NULL,
	"scope" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_parts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"stream_id" text NOT NULL,
	"content_id" text NOT NULL,
	"revision" text NOT NULL,
	"part_index" integer NOT NULL,
	"data" text NOT NULL,
	"encoding" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_quality" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"owner_user_id" text,
	"jira_key" text NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_days" integer DEFAULT 14 NOT NULL,
	"defects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_seat_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"owner_user_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text NOT NULL,
	"task_id" uuid,
	"backlog" integer DEFAULT 0 NOT NULL,
	"through" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"native_session_id" uuid NOT NULL,
	"machine_id" uuid NOT NULL,
	"machine_fingerprint" text NOT NULL,
	"owner_user_id" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"coverage" text DEFAULT 'from_start' NOT NULL,
	"sync_state" text DEFAULT 'collecting' NOT NULL,
	"collection_paused" boolean DEFAULT false NOT NULL,
	"upload_paused" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"last_observation" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_streams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"stream_id" text NOT NULL,
	"ack_sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dsp7_managed_task_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"owner_user_id" text,
	"kind" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dsp7_managed_bindings" ADD CONSTRAINT "dsp7_managed_bindings_session_id_dsp7_managed_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dsp7_managed_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_bindings" ADD CONSTRAINT "dsp7_managed_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_bindings" ADD CONSTRAINT "dsp7_managed_bindings_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_contents" ADD CONSTRAINT "dsp7_managed_contents_session_id_dsp7_managed_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dsp7_managed_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_contents" ADD CONSTRAINT "dsp7_managed_contents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_events" ADD CONSTRAINT "dsp7_managed_events_session_id_dsp7_managed_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dsp7_managed_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_events" ADD CONSTRAINT "dsp7_managed_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_jira_workloads" ADD CONSTRAINT "dsp7_managed_jira_workloads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_jira_workloads" ADD CONSTRAINT "dsp7_managed_jira_workloads_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_parts" ADD CONSTRAINT "dsp7_managed_parts_session_id_dsp7_managed_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dsp7_managed_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_parts" ADD CONSTRAINT "dsp7_managed_parts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_quality" ADD CONSTRAINT "dsp7_managed_quality_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_quality" ADD CONSTRAINT "dsp7_managed_quality_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_quality" ADD CONSTRAINT "dsp7_managed_quality_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_seat_samples" ADD CONSTRAINT "dsp7_managed_seat_samples_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_seat_samples" ADD CONSTRAINT "dsp7_managed_seat_samples_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_sessions" ADD CONSTRAINT "dsp7_managed_sessions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_sessions" ADD CONSTRAINT "dsp7_managed_sessions_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_sessions" ADD CONSTRAINT "dsp7_managed_sessions_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_sessions" ADD CONSTRAINT "dsp7_managed_sessions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_streams" ADD CONSTRAINT "dsp7_managed_streams_session_id_dsp7_managed_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dsp7_managed_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_streams" ADD CONSTRAINT "dsp7_managed_streams_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_task_facts" ADD CONSTRAINT "dsp7_managed_task_facts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_task_facts" ADD CONSTRAINT "dsp7_managed_task_facts_task_id_issues_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dsp7_managed_task_facts" ADD CONSTRAINT "dsp7_managed_task_facts_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_mb_run_uq" ON "dsp7_managed_bindings" USING btree ("session_id","run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_mc_uq" ON "dsp7_managed_contents" USING btree ("session_id","stream_id","content_id");--> statement-breakpoint
CREATE INDEX "dsp7_mc_page_idx" ON "dsp7_managed_contents" USING btree ("session_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_me_seq_uq" ON "dsp7_managed_events" USING btree ("session_id","stream_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_me_event_uq" ON "dsp7_managed_events" USING btree ("session_id","event_id");--> statement-breakpoint
CREATE INDEX "dsp7_me_time_idx" ON "dsp7_managed_events" USING btree ("session_id","event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "dsp7_mjira_time_idx" ON "dsp7_managed_jira_workloads" USING btree ("company_id","seat_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_mp_uq" ON "dsp7_managed_parts" USING btree ("session_id","stream_id","content_id","revision","part_index");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_mquality_task_uq" ON "dsp7_managed_quality" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "dsp7_mquality_seat_idx" ON "dsp7_managed_quality" USING btree ("company_id","seat_id");--> statement-breakpoint
CREATE INDEX "dsp7_msample_time_idx" ON "dsp7_managed_seat_samples" USING btree ("company_id","seat_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_ms_native_uq" ON "dsp7_managed_sessions" USING btree ("company_id","seat_id","machine_id","native_session_id");--> statement-breakpoint
CREATE INDEX "dsp7_ms_task_idx" ON "dsp7_managed_sessions" USING btree ("company_id","task_id");--> statement-breakpoint
CREATE INDEX "dsp7_ms_seat_idx" ON "dsp7_managed_sessions" USING btree ("company_id","seat_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_mstream_uq" ON "dsp7_managed_streams" USING btree ("session_id","stream_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dsp7_mfact_kind_uq" ON "dsp7_managed_task_facts" USING btree ("company_id","task_id","kind");--> statement-breakpoint
CREATE INDEX "dsp7_mfact_time_idx" ON "dsp7_managed_task_facts" USING btree ("company_id","seat_id","at");