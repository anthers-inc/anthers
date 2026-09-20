CREATE TABLE "handle_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"old_handle" text NOT NULL,
	"did" text NOT NULL,
	"hold_until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "handle_history_old_handle_unique" UNIQUE("old_handle")
);
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_username_unique";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "atproto_handle" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "atproto_handle" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "username";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_atproto_handle_unique" UNIQUE("atproto_handle");