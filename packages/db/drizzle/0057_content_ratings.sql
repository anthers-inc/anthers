CREATE TABLE "work_rating_appeals" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"creator_id" integer,
	"requested_maturity" text NOT NULL,
	"corrected_maturity" text NOT NULL,
	"statement" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" integer,
	"resolved_at" timestamp with time zone,
	"resolution_note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "maturity" text DEFAULT 'unrated' NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "maturity_notes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "maturity_source" text;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "maturity_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "work_rating_appeals" ADD CONSTRAINT "work_rating_appeals_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_rating_appeals" ADD CONSTRAINT "work_rating_appeals_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_rating_appeals" ADD CONSTRAINT "work_rating_appeals_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_rating_appeals_status" ON "work_rating_appeals" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_rating_appeals_work" ON "work_rating_appeals" USING btree ("work_id","status");