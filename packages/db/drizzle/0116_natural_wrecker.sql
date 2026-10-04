-- The post body's canonical form is markdown. `posts.body_html` was the stored form (the
-- editor's sanitized HTML) with `body` a plain-text shadow; `org.anthers.post` publishes
-- `{ format: "markdown", value }`, which had no source to map from — so the stored form is
-- markdown in `body`, and the HTML column goes. Anthers is pre-launch and every dev session
-- starts empty by decision, so there is no HTML inventory to convert: rows that exist are
-- seed data, re-seeded in markdown by the seed scripts themselves.
ALTER TABLE "posts" DROP COLUMN "body_html";
