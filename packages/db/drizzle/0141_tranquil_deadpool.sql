CREATE TABLE "work_section_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"path" text NOT NULL,
	"file" text NOT NULL,
	"mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_sections" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"position" integer NOT NULL,
	"href" text NOT NULL,
	"file" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"size_bytes" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_section_assets" ADD CONSTRAINT "work_section_assets_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_sections" ADD CONSTRAINT "work_sections_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_section_assets" ON "work_section_assets" USING btree ("work_id","path");--> statement-breakpoint
CREATE INDEX "idx_work_section_assets_work" ON "work_section_assets" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_sections" ON "work_sections" USING btree ("work_id","position");--> statement-breakpoint
CREATE INDEX "idx_work_sections_work" ON "work_sections" USING btree ("work_id","position");