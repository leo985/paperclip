CREATE TABLE "management_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"owner_user_id" text,
	"remind_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "management_follow_ups" ADD CONSTRAINT "management_follow_ups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "management_follow_ups" ADD CONSTRAINT "management_follow_ups_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "management_follow_up_issue_uq" ON "management_follow_ups" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "management_follow_up_owner_idx" ON "management_follow_ups" USING btree ("company_id","owner_user_id","remind_at");