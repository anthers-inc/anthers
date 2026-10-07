CREATE TABLE "noun_blocklist" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"reason" text NOT NULL,
	"added_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "noun_spend" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"day" text NOT NULL,
	"icon_calls" integer DEFAULT 0 NOT NULL,
	"service_calls" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "noun_spend" ADD CONSTRAINT "noun_spend_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_noun_blocklist_kind_value" ON "noun_blocklist" USING btree ("kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_noun_spend_creator_day" ON "noun_spend" USING btree ("creator_id","day");