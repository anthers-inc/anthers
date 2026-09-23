CREATE TABLE "work_panels" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_id" integer NOT NULL,
	"panel_number" integer NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"width" real NOT NULL,
	"height" real NOT NULL,
	"auto" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_panels" ADD CONSTRAINT "work_panels_page_id_work_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."work_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_work_panels" ON "work_panels" USING btree ("page_id","panel_number");--> statement-breakpoint
CREATE INDEX "idx_work_panels_page" ON "work_panels" USING btree ("page_id","panel_number");