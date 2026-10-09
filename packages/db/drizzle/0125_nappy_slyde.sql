ALTER TABLE "user_preferences" ADD COLUMN "notification_delivery" jsonb;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD COLUMN "notification_unsubscribe_token" text;--> statement-breakpoint
-- Map the old boolean rather than drop it blind: somebody who turned activity email off
-- has said no to email, and arriving at `notificationDelivery = {}` (every group at its
-- `both` default) would re-mail them the first time a reply, comment, review or follow
-- notification landed. `{ "*": "app" }` is that no, carried into the new mechanism —
-- every group app-only, which is what their one switch said. Everyone else gets `{}`:
-- every group at its `both` default, the new behavior.
UPDATE "user_preferences"
SET "notification_delivery" = CASE WHEN "notify_activity_email" = false THEN '{"*":"app"}'::jsonb ELSE '{}'::jsonb END;--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN "notify_activity_email";