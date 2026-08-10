CREATE TABLE "attention_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"creator_id" integer NOT NULL,
	"work_id" integer,
	"day" text NOT NULL,
	"event_type" text NOT NULL,
	"event_count" integer DEFAULT 0 NOT NULL,
	"total_seconds" integer DEFAULT 0 NOT NULL,
	"unique_viewers" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attention_daily" ADD CONSTRAINT "attention_daily_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_daily" ADD CONSTRAINT "attention_daily_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_attention_daily_key" ON "attention_daily" USING btree ("creator_id",COALESCE("work_id", -1),"day","event_type");--> statement-breakpoint
CREATE INDEX "idx_attention_daily_creator_day" ON "attention_daily" USING btree ("creator_id","day");