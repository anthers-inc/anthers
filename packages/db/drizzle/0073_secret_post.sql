CREATE TABLE "studio_preferences" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"panels" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_preferences" ADD CONSTRAINT "studio_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;