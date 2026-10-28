CREATE TABLE "outbound_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"user_id" integer,
	"subject" text DEFAULT '' NOT NULL,
	"detail" jsonb,
	"message_id" text,
	"sent_at" timestamp with time zone,
	"delivery_event" text,
	"delivery_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_outbound_emails_dedupe" ON "outbound_emails" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_outbound_emails_message" ON "outbound_emails" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_outbound_emails_kind_created" ON "outbound_emails" USING btree ("kind","created_at");--> statement-breakpoint
-- A receipt's row carries its own transaction kind and the recipient's side in `detail`, so
-- the failed-mail panel keeps both. `sent` becomes a stamp: the old table recorded no send
-- time, so an accepted receipt takes its creation moment as the closest honest reading.
INSERT INTO "outbound_emails" ("dedupe_key", "kind", "recipient", "user_id", "detail", "message_id", "sent_at", "delivery_event", "delivery_event_at", "created_at")
SELECT "dedupe_key", 'receipt', "email", "user_id",
	jsonb_build_object('receiptKind', "kind", 'role', "role"),
	"message_id", CASE WHEN "sent" THEN "created_at" END, "delivery_event", "delivery_event_at", "created_at"
FROM "receipt_sends";--> statement-breakpoint
-- A deadline reminder's title is the mail's subject and its source rides in `detail`; the
-- send stamp it already had carries across unchanged.
INSERT INTO "outbound_emails" ("dedupe_key", "kind", "recipient", "subject", "detail", "sent_at", "created_at")
SELECT "dedupe_key", 'deadline', "recipient", "title",
	jsonb_build_object('source', "source", 'reminderKind', "kind"), "sent_at", "created_at"
FROM "deadline_reminders";--> statement-breakpoint
DROP TABLE "receipt_sends" CASCADE;--> statement-breakpoint
DROP TABLE "deadline_reminders" CASCADE;
