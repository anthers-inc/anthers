ALTER TABLE "purchases" DROP CONSTRAINT "purchases_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "creator_id" integer;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "work_title" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "work_type" text;--> statement-breakpoint
ALTER TABLE "purchases" ADD COLUMN "work_public_id" bigint;--> statement-breakpoint
-- Backfill, hand-added: drizzle-kit generates the columns but never the data, and
-- these columns are only worth having if EVERY row carries them. A purchase whose
-- snapshot is null is indistinguishable from a Seed buy (which legitimately has no
-- Work), so leaving existing rows blank would make the null ambiguous from day one.
-- Rows with a null work_id are Seed buys and are correctly skipped by the join.
UPDATE "purchases" p
SET "creator_id" = w."creator_id",
    "work_title" = w."title",
    "work_type" = w."type",
    "work_public_id" = w."public_id"
FROM "works" w
WHERE p."work_id" = w."id";--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_purchases_creator" ON "purchases" USING btree ("creator_id");
