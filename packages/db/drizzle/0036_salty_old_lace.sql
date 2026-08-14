CREATE TABLE "work_pages" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"page_number" integer NOT NULL,
	"file" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_pages" ADD CONSTRAINT "work_pages_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_pages" ON "work_pages" USING btree ("work_id","page_number");--> statement-breakpoint
CREATE INDEX "idx_work_pages_work" ON "work_pages" USING btree ("work_id","page_number");