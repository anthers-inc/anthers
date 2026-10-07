CREATE TABLE "receipt_sends" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"user_id" integer,
	"role" text NOT NULL,
	"email" text NOT NULL,
	"sent" boolean DEFAULT false NOT NULL,
	"message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipt_sends_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "stripe_accounts" ADD COLUMN "creator_receipt_emails" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "receipt_sends" ADD CONSTRAINT "receipt_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_receipt_sends_user" ON "receipt_sends" USING btree ("user_id");