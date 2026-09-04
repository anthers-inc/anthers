CREATE TABLE "stickers" (
	"id" serial PRIMARY KEY NOT NULL,
	"giver_id" integer,
	"creator_id" integer,
	"subject_type" text NOT NULL,
	"subject_id" integer NOT NULL,
	"billing_cycle" text NOT NULL,
	"amount" numeric NOT NULL,
	"art_key" text,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pool_distributions" ADD COLUMN "sticker_amount" numeric DEFAULT '0.00' NOT NULL;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_giver_id_users_id_fk" FOREIGN KEY ("giver_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stickers" ADD CONSTRAINT "stickers_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_stickers_giver_cycle" ON "stickers" USING btree ("giver_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_stickers_creator_cycle" ON "stickers" USING btree ("creator_id","billing_cycle");--> statement-breakpoint
CREATE INDEX "idx_stickers_subject" ON "stickers" USING btree ("subject_type","subject_id");