CREATE TABLE "work_thumbnail_frames" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"at_seconds" real NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_thumbnail_frames" ADD CONSTRAINT "work_thumbnail_frames_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_thumbnail_frames_work" ON "work_thumbnail_frames" USING btree ("work_id","created_at");