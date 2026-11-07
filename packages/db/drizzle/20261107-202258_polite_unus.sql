-- The basket becomes the cart (2026-11-07): the concept is named cart everywhere a
-- person sees it, and the table follows rather than leaving a divergent name in the
-- schema. A RENAME keeps every buyer's pending lines; the generated drop-and-create
-- would have emptied carts on deploy.
ALTER TABLE "basket_items" RENAME TO "cart_items";--> statement-breakpoint
ALTER TABLE "cart_items" RENAME CONSTRAINT "basket_items_user_id_users_id_fk" TO "cart_items_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "cart_items" RENAME CONSTRAINT "basket_items_work_id_works_id_fk" TO "cart_items_work_id_works_id_fk";--> statement-breakpoint
ALTER TABLE "cart_items" RENAME CONSTRAINT "basket_items_badge_id_badges_id_fk" TO "cart_items_badge_id_badges_id_fk";--> statement-breakpoint
ALTER TABLE "cart_items" RENAME CONSTRAINT "basket_items_exactly_one_kind" TO "cart_items_exactly_one_kind";--> statement-breakpoint
ALTER INDEX "uq_basket_items_user_work" RENAME TO "uq_cart_items_user_work";--> statement-breakpoint
ALTER INDEX "uq_basket_items_user_badge" RENAME TO "uq_cart_items_user_badge";--> statement-breakpoint
ALTER INDEX "idx_basket_items_work" RENAME TO "idx_cart_items_work";--> statement-breakpoint
ALTER INDEX "idx_basket_items_badge" RENAME TO "idx_cart_items_badge";
