CREATE TABLE "work_media_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"uploaded_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	"media" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "version_added_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "works" SET "version_added_at" = "created_at";--> statement-breakpoint
ALTER TABLE "work_media_versions" ADD CONSTRAINT "work_media_versions_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_work_media_versions_work" ON "work_media_versions" USING btree ("work_id","uploaded_at");