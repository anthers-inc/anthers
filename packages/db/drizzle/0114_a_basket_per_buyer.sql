-- The basket moves server-side, scoped to the buyer's account (Parker, 2026-10-03 —
-- live testing: the client-side localStorage basket followed the browser, so a second
-- account signing in inherited the first account's basket). One row per (user, Work);
-- both FKs cascade, because a basket is a preference, not a record — it dies with the
-- account and with the Work and never outlives either (the money tables' SET NULL rule
-- is the opposite case). The unique pair is the basket's read shape: adding a Work
-- twice is a no-op, and the badge counts rows, never ghosts.
--
-- The one-creator rule and every purchasability check live in the routes
-- (`resolveBasket`), not here: the table is the ids' home, not their judge.

CREATE TABLE "basket_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"work_id" integer NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "basket_items" ADD CONSTRAINT "basket_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "basket_items" ADD CONSTRAINT "basket_items_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_basket_items_user_work" ON "basket_items" USING btree ("user_id","work_id");--> statement-breakpoint
CREATE INDEX "idx_basket_items_work" ON "basket_items" USING btree ("work_id");