CREATE TABLE "work_source_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"position" integer NOT NULL,
	"file" text NOT NULL,
	"filename" text DEFAULT '' NOT NULL,
	"file_size" integer,
	"mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_source_files" ADD CONSTRAINT "work_source_files_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_source_files" ON "work_source_files" USING btree ("work_id","position");--> statement-breakpoint
CREATE INDEX "idx_work_source_files_work" ON "work_source_files" USING btree ("work_id","position");--> statement-breakpoint
-- The backfill the multi-PDF task decided on (pre-launch default: migrate into what it should
-- be): every existing paged Work with a file becomes the one-row set that represents it, so the
-- paged kinds' row-level truth moves here wholesale and `works.source_key` can stop meaning
-- anything for them. Nothing is re-rendered: the Work's existing pages were rendered from this
-- same file and stay valid.
INSERT INTO "work_source_files" ("work_id", "position", "file", "filename")
SELECT id, 0, source_key, split_part(source_key, '/', -1)
FROM works
WHERE type IN ('comic', 'ebook') AND source_key <> '';
