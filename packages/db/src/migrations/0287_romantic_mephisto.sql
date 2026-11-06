CREATE TABLE "dsp7_managed_seat_report_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"work_schedule" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dsp7_managed_seat_report_settings" ADD CONSTRAINT "dsp7_managed_seat_report_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;