CREATE TABLE "media_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" integer NOT NULL,
	"key" text NOT NULL,
	"upload_id" text NOT NULL,
	"content_type" text NOT NULL,
	"part_size" bigint NOT NULL,
	"part_count" integer NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"client_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_upload_sessions_open_age" ON "media_upload_sessions" USING btree ("status","created_at");