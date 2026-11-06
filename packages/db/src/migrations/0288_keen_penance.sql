CREATE TABLE "delivery_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"source_origin" text NOT NULL,
	"demand_no" text NOT NULL,
	"fingerprint" text NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" text NOT NULL,
	"plan" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_snapshots" ADD CONSTRAINT "delivery_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_snapshots" ADD CONSTRAINT "delivery_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_snapshots_identity_idx" ON "delivery_snapshots" USING btree ("company_id","project_id","source_origin","demand_no","fingerprint");--> statement-breakpoint
CREATE INDEX "delivery_snapshots_listing_idx" ON "delivery_snapshots" USING btree ("company_id","project_id","created_at");