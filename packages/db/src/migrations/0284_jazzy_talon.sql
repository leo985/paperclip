CREATE TABLE "personnel_departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personnel_people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"username" text NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"department_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_id" text,
	"managed_account" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"activation_hash" text,
	"activation_expires" timestamp with time zone,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personnel_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"corp_id" text NOT NULL,
	"app_key" text NOT NULL,
	"secret_id" uuid,
	"sync_scope" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_sync" boolean DEFAULT false NOT NULL,
	"sync_interval" integer DEFAULT 3600 NOT NULL,
	"lease_until" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "personnel_departments" ADD CONSTRAINT "personnel_departments_source_id_personnel_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."personnel_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_departments" ADD CONSTRAINT "personnel_departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_people" ADD CONSTRAINT "personnel_people_source_id_personnel_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."personnel_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_people" ADD CONSTRAINT "personnel_people_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_people" ADD CONSTRAINT "personnel_people_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personnel_sources" ADD CONSTRAINT "personnel_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_departments_identity" ON "personnel_departments" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_people_identity" ON "personnel_people" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personnel_sources_identity" ON "personnel_sources" USING btree ("company_id","type","corp_id");