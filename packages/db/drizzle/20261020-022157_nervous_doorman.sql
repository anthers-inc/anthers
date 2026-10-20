CREATE TABLE "work_preview_caption_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"preview_id" integer NOT NULL,
	"language" text NOT NULL,
	"label" text DEFAULT '',
	"kind" text DEFAULT 'captions' NOT NULL,
	"storage_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"cue_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_preview_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"kind" text NOT NULL,
	"file" text NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "cover_work_id" integer;--> statement-breakpoint
ALTER TABLE "work_preview_caption_tracks" ADD CONSTRAINT "work_preview_caption_tracks_preview_id_work_preview_media_id_fk" FOREIGN KEY ("preview_id") REFERENCES "public"."work_preview_media"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_preview_media" ADD CONSTRAINT "work_preview_media_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_preview_captions_preview_language_kind" ON "work_preview_caption_tracks" USING btree ("preview_id","language","kind");--> statement-breakpoint
CREATE INDEX "idx_work_preview_captions_preview" ON "work_preview_caption_tracks" USING btree ("preview_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_preview_media" ON "work_preview_media" USING btree ("work_id","position");--> statement-breakpoint
CREATE INDEX "idx_work_preview_media_work" ON "work_preview_media" USING btree ("work_id","position");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_cover_work_id_works_id_fk" FOREIGN KEY ("cover_work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;