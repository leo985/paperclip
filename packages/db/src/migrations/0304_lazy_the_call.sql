CREATE TABLE "seat_qingzhou_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"seat_id" uuid NOT NULL,
	"username" text,
	"credential_secret_id" uuid,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_check_status" text DEFAULT 'not_checked' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "seat_qingzhou_accounts" ADD CONSTRAINT "seat_qingzhou_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_qingzhou_accounts" ADD CONSTRAINT "seat_qingzhou_accounts_seat_id_agents_id_fk" FOREIGN KEY ("seat_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_qingzhou_accounts" ADD CONSTRAINT "seat_qingzhou_accounts_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "seat_qingzhou_accounts_seat_idx" ON "seat_qingzhou_accounts" USING btree ("company_id","seat_id");