CREATE TABLE "web_build_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"build_id" integer NOT NULL,
	"path" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_size" bigint DEFAULT 0,
	"mime_type" text DEFAULT '',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_builds" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"entry_path" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_build_files" ADD CONSTRAINT "web_build_files_build_id_web_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."web_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_builds" ADD CONSTRAINT "web_builds_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_web_build_files" ON "web_build_files" USING btree ("build_id","path");--> statement-breakpoint
CREATE INDEX "idx_web_builds_work" ON "web_builds" USING btree ("work_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_web_build_primary" ON "web_builds" USING btree ("work_id","is_primary") WHERE is_primary;