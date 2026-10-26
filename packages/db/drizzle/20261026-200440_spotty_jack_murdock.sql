CREATE TABLE "physical_listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"work_id" integer NOT NULL,
	"shipping_price" numeric DEFAULT '0.00' NOT NULL,
	"handling_business_days" integer DEFAULT 3 NOT NULL,
	"tax_category" text DEFAULT 'general' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "physical_listings_work_id_unique" UNIQUE("work_id")
);
--> statement-breakpoint
ALTER TABLE "physical_listings" ADD CONSTRAINT "physical_listings_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;