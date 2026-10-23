CREATE TABLE "space_backups" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"did" text NOT NULL,
	"space_uri" text NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"rev" text,
	"commit_data" text,
	"prefix" text NOT NULL,
	"star_key" text,
	"records_key" text NOT NULL,
	"registry_key" text NOT NULL,
	"blobs_key" text,
	"star_bytes" integer DEFAULT 0 NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"blob_count" integer DEFAULT 0 NOT NULL,
	"blob_bytes" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "space_backups" ADD CONSTRAINT "space_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_space_backups_capture" ON "space_backups" USING btree ("space_uri","captured_at");--> statement-breakpoint
CREATE INDEX "idx_space_backups_space" ON "space_backups" USING btree ("space_uri","captured_at");--> statement-breakpoint
CREATE INDEX "idx_space_backups_status" ON "space_backups" USING btree ("status");