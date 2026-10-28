ALTER TABLE "work_caption_tracks" ALTER COLUMN "work_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "work_caption_tracks" ADD COLUMN "preview_id" integer;--> statement-breakpoint
ALTER TABLE "work_caption_tracks" ADD CONSTRAINT "work_caption_tracks_preview_id_work_preview_media_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."work_preview_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DROP INDEX "uq_work_captions_work_language_kind";--> statement-breakpoint
-- A trailer's tracks become rows of the same table, hanging off the preview instead of the
-- Work. Every other column is the same authored track.
INSERT INTO "work_caption_tracks" ("preview_id", "language", "label", "kind", "storage_key", "byte_size", "cue_count", "created_at", "updated_at")
SELECT "preview_id", "language", "label", "kind", "storage_key", "byte_size", "cue_count", "created_at", "updated_at" FROM "work_preview_caption_tracks";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_captions_work_language_kind" ON "work_caption_tracks" USING btree ("work_id","language","kind") WHERE "work_caption_tracks"."work_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_captions_preview_language_kind" ON "work_caption_tracks" USING btree ("preview_id","language","kind") WHERE "work_caption_tracks"."preview_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_work_captions_preview" ON "work_caption_tracks" USING btree ("preview_id");--> statement-breakpoint
ALTER TABLE "work_caption_tracks" ADD CONSTRAINT "work_caption_tracks_one_parent" CHECK (("work_caption_tracks"."work_id" IS NOT NULL) <> ("work_caption_tracks"."preview_id" IS NOT NULL));--> statement-breakpoint
DROP TABLE "work_preview_caption_tracks" CASCADE;
