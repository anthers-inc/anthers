-- Work links become part of the post's body (Parker, 2026-10-16): you write the link
-- into the body and the page renders a card for it under the text — nothing about the
-- link is stored, so `post_work_refs` retires. First: convert every reference a post
-- still carries into the body link the embed derives from, in the refs' own order,
-- skipping the ones the body already links; then drop the table.
--
-- ⚠️ The appended link is a BARE url rather than a title link on purpose: escaping a
-- work title into a markdown link safely is bracket-paren arithmetic on live data, and
-- autolinked text is what "a link in the body" reads as everywhere else in a post.
WITH refs AS (
	SELECT r.post_id, r.position,
		'https://anthers.org/works/' || w.slug || '-' || w.public_id AS url
	FROM post_work_refs r
	JOIN works w ON w.id = r.work_id
	JOIN posts p ON p.id = r.post_id
	WHERE coalesce(p.body, '') NOT LIKE '%/' || w.slug || '-' || w.public_id || '%'
), blocks AS (
	SELECT post_id, E'\n\n' || string_agg(url, E'\n\n' ORDER BY position) AS block
	FROM refs
	GROUP BY post_id
)
UPDATE posts p SET body = coalesce(p.body, '') || b.block FROM blocks b WHERE p.id = b.post_id;--> statement-breakpoint
DROP TABLE "post_work_refs" CASCADE;