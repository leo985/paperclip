CREATE TABLE "delivery_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"demand_no" text NOT NULL,
	"fingerprint" text NOT NULL,
	"request_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"config" jsonb NOT NULL,
	"stages" jsonb NOT NULL,
	"message" text,
	"acceptance" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_workflows" ADD CONSTRAINT "delivery_workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflows" ADD CONSTRAINT "delivery_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_workflows" ADD CONSTRAINT "delivery_workflows_snapshot_id_delivery_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."delivery_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_workflow_request_uq" ON "delivery_workflows" USING btree ("company_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_workflow_entry_uq" ON "delivery_workflows" USING btree ("company_id","project_id","demand_no");--> statement-breakpoint
CREATE INDEX "delivery_workflow_queue_idx" ON "delivery_workflows" USING btree ("state","updated_at");