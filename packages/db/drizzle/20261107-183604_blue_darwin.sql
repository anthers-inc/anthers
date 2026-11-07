ALTER TABLE "badges" ADD COLUMN "art_edge_color" text;
-- The Seed shape left the library when Diamond and Heart joined it. A stored Seed row
-- falls back to the default Circle so the row and the editor agree; the old composed PNG
-- keeps showing its own shape until the creator next rebuilds the art.
UPDATE "badges" SET "art_shape" = 'circle' WHERE "art_shape" = 'seed';
