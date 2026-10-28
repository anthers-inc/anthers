-- A notification the service intended to email becomes a ledger row, keyed the way the
-- service now keys it. Suppressed notices have no row here, which is the distinction the
-- intent column used to carry.
INSERT INTO "outbound_emails" ("dedupe_key", "kind", "recipient", "user_id", "subject", "detail", "message_id", "sent_at", "delivery_event", "delivery_event_at", "created_at")
SELECT 'notification:' || n."dedupe_key", 'notification', u."email", n."user_id", n."title",
	jsonb_build_object('notificationKind', n."kind", 'category', n."category"),
	n."email_message_id", n."email_sent_at", n."email_delivery_event", n."email_delivery_event_at", n."created_at"
FROM "notifications" n
JOIN "users" u ON u."id" = n."user_id"
WHERE n."email_intended" = true;--> statement-breakpoint
DROP INDEX "idx_notifications_email_message";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "email_intended";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "email_message_id";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "email_sent_at";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "email_delivery_event";--> statement-breakpoint
ALTER TABLE "notifications" DROP COLUMN "email_delivery_event_at";
