CREATE TABLE "desktop_auth_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"challenge" text NOT NULL,
	"code" text,
	"label" text,
	"session_token" text,
	"user_id" integer,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "desktop_auth_requests_challenge_unique" UNIQUE("challenge"),
	CONSTRAINT "desktop_auth_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "desktop_auth_requests" ADD CONSTRAINT "desktop_auth_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;