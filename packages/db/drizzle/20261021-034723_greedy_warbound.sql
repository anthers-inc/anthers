-- The sidebar's drag-to-reorder is gone (Parker, 2026-10-20): the three user tabs render
-- in one fixed order, Library, Network and Discovery, and what a session opens on is its
-- own setting rather than the top of a stored arrangement.
--
-- The old column still holds a real answer for anyone who rearranged the sidebar, and its
-- first id is exactly what that arrangement meant — where they landed. So the landing is
-- carried forward before the column goes; an account that never rearranged has NULL here
-- and lands on Network, the client's default.
ALTER TABLE "user_preferences" ADD COLUMN "home_default_tab" text;--> statement-breakpoint
UPDATE "user_preferences"
SET "home_default_tab" = "home_nav_order"->>0
WHERE "home_nav_order" IS NOT NULL
	AND "home_nav_order"->>0 IN ('library', 'network', 'discovery');--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN "home_nav_order";
