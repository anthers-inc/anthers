CREATE TABLE "work_caption_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
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
ALTER TABLE "work_caption_tracks" ADD CONSTRAINT "work_caption_tracks_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_captions_work_language_kind" ON "work_caption_tracks" USING btree ("work_id","language","kind");--> statement-breakpoint
CREATE INDEX "idx_work_captions_work" ON "work_caption_tracks" USING btree ("work_id");