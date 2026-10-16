CREATE TABLE "card_impressions" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" integer NOT NULL,
	"kind" text NOT NULL,
	"surface" text DEFAULT 'discover' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_impressions_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" integer NOT NULL,
	"surface" text DEFAULT 'discover' NOT NULL,
	"shown" integer DEFAULT 0 NOT NULL,
	"clicked" integer DEFAULT 0 NOT NULL,
	"creator_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traffic_daily" (
	"id" serial PRIMARY KEY NOT NULL,
	"day" text NOT NULL,
	"path" text NOT NULL,
	"referrer_source" text NOT NULL,
	"device" text NOT NULL,
	"views" integer DEFAULT 0 NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traffic_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text,
	"referrer_source" text NOT NULL,
	"previous_path" text,
	"session_id" text NOT NULL,
	"device" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_card_impressions_created" ON "card_impressions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_card_impressions_subject" ON "card_impressions" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_card_impressions_daily_key" ON "card_impressions_daily" USING btree ("day","subject_kind","subject_id","surface");--> statement-breakpoint
CREATE INDEX "idx_card_impressions_daily_creator" ON "card_impressions_daily" USING btree ("creator_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_traffic_daily_key" ON "traffic_daily" USING btree ("day","path","referrer_source","device");--> statement-breakpoint
CREATE INDEX "idx_traffic_daily_day" ON "traffic_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "idx_traffic_created" ON "traffic_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_traffic_path" ON "traffic_events" USING btree ("path");