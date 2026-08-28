CREATE TABLE "parental_controls" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"pin_hash" text NOT NULL,
	"lock_maturity" boolean DEFAULT false NOT NULL,
	"creators" jsonb,
	"types" jsonb,
	"daily_seconds" integer,
	"weekly_seconds" integer,
	"monthly_seconds" integer,
	"language_filter" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "parental_controls" ADD CONSTRAINT "parental_controls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;