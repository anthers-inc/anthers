CREATE TABLE "media_scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"storage_key" text NOT NULL,
	"work_id" integer,
	"pdq_hash" text,
	"pdq_quality" integer,
	"determination" text NOT NULL,
	"vendor_match" jsonb,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_scans_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "media_scans" ADD CONSTRAINT "media_scans_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_scans_work_idx" ON "media_scans" USING btree ("work_id");--> statement-breakpoint
CREATE INDEX "media_scans_determination_idx" ON "media_scans" USING btree ("determination");