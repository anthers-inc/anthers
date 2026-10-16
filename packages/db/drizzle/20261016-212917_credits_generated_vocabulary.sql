-- The credits vocabulary's first-edition values rewrite. Settled 2026-10-16: `generated`
-- replaces `ai` (same meaning — a machine not capable of authorship made the part), and
-- `licensed` retires: a named one becomes `created` (the source named its maker — the deal
-- behind the credit is not the reader's business), an unnamed one is dropped entirely,
-- because material brought in unnamed is not credited rather than credited anonymously.
--
-- Rules the rewrite follows, per row of each Work's `credits` array:
--   `created`  stays `created`.
--   `ai`       becomes `generated`.
--   `licensed` becomes `created` when the row names a human or entity — the named maker is
--              real regardless of the contract — and vanishes otherwise.
--   A named row whose types map to no `created` gains one — a name is a human's claim, and
--              `licensed` was the only type that could arrive named without it.
--   A row left asserting nothing (an unnamed licensed import) is dropped; an empty table
--              stays `[]`.
--
-- Mapped values are deduplicated and ordered `created` before `generated` by the single
-- aggregation, so the rewrite is deterministic and idempotent (a second run's WHERE filter
-- finds nothing left to touch).
--
-- The released-Work gate never gains a refusal from this: a Work released under the old
-- vocabulary carried a `created` row, and `created` passes unmapped. No DB reader must
-- ever meet the old values again — the API accepts only `created` and `generated` at the
-- write boundary as of this deploy, so nothing reintroduces them. Network records
-- published before this migration keep the first-edition values by design (the lexicon's
-- open set keeps them valid) — they live outside this database and are interpreted by the
-- lexicon's own description.
UPDATE "works"
SET "credits" = COALESCE(
	(
		SELECT jsonb_agg(e.val || jsonb_build_object('types', nt.new_types) ORDER BY e.ord)
		FROM jsonb_array_elements("works"."credits") WITH ORDINALITY AS e(val, ord)
		CROSS JOIN LATERAL (
			SELECT CASE WHEN (e.val ->> 'contributor') ~ '\S' THEN e.val ->> 'contributor' ELSE '' END AS contributor
		) AS c
		CROSS JOIN LATERAL (
			-- One aggregation per row: map each old type, add the named-human gain when the
			-- mapped set cannot carry one, then dedupe and order created before generated.
			SELECT jsonb_agg(DISTINCT s.val ORDER BY s.val) AS new_types
			FROM (
				SELECT m.new_type AS val
				FROM jsonb_array_elements(e.val -> 'types') AS t(old)
				CROSS JOIN LATERAL (
					SELECT CASE
						WHEN t.old = to_jsonb('created'::text) THEN 'created'::text
						WHEN t.old = to_jsonb('ai'::text) THEN 'generated'::text
						WHEN t.old = to_jsonb('licensed'::text) AND c.contributor <> '' THEN 'created'::text
						ELSE NULL
					END AS new_type
				) AS m
				WHERE m.new_type IS NOT NULL
				UNION ALL
				SELECT 'created'::text
				WHERE c.contributor <> ''
					AND NOT (e.val -> 'types') @> '"created"'::jsonb
					AND NOT (e.val -> 'types') @> '"licensed"'::jsonb
			) AS s
		) AS nt(new_types)
		WHERE nt.new_types <> '[]'::jsonb
	),
	'[]'::jsonb
)
WHERE EXISTS (
	SELECT 1
	FROM jsonb_array_elements("works"."credits") AS el(val)
	WHERE (el.val -> 'types') ?| ARRAY['ai', 'licensed']
);