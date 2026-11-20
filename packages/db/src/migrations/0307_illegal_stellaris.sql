CREATE TABLE "delivery_plan_previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_origin" text NOT NULL,
	"demand_no" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"preview" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_plan_previews" ADD CONSTRAINT "delivery_plan_previews_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_plan_previews" ADD CONSTRAINT "delivery_plan_previews_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_plan_previews" ADD CONSTRAINT "delivery_plan_previews_snapshot_id_delivery_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."delivery_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_plan_previews_entry_idx" ON "delivery_plan_previews" USING btree ("company_id","project_id","source_origin","demand_no");