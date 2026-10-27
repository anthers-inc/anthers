ALTER TABLE "badges" ADD COLUMN "art_emblem_color" text;--> statement-breakpoint

-- Backfill the emblem color for every Badge composed before the column existed.
--
-- 🚨 **The color is recoverable because every other fingerprint input is stored.** The hash
-- is a SHA-256 over the icon id, shape, field color, emblem color and placement, so trying
-- the ten `BADGE_EMBLEM_COLORS` swatches against each row's stored inputs finds the one that
-- reproduces the stored fingerprint. This is a bridge, not a foundation: it depends on the
-- palette retaining these exact hex values and on the placement numbers round-tripping
-- through `numeric` to the same four decimal places `toFixed(4)` produced. Composition stores
-- the color from now on, so no future row needs this.
--
-- ⚠️ **A row that matches nothing keeps a null color rather than a guess.** The palette may
-- have moved under a row, or its placement may have been written before this shape existed;
-- either way the editor keeps its old refusal for that Badge instead of recomposing a
-- different foreground than the creator chose.
--
-- The format string is the SQL twin of `toFixed(4)`: FM drops padding, the trailing `0`
-- forces an integer digit, and the four decimal digits force trailing zeros to print.
UPDATE "badges" AS b
SET "art_emblem_color" = swatch.color
FROM "badge_art_provenance" AS p
CROSS JOIN (
	VALUES
		('#ffffff'), ('#000000'), ('#1d1d1d'), ('#3a3a3a'), ('#4b3b2a'),
		('#5f6f3f'), ('#7a5a3a'), ('#96a86b'), ('#bfae7e'), ('#e6d9ac')
) AS swatch(color)
WHERE p."badge_id" = b."id"
	AND b."art_fingerprint" IS NOT NULL
	AND b."art_emblem_color" IS NULL
	AND b."art_shape" IS NOT NULL
	AND b."art_color" IS NOT NULL
	AND b."art_emblem_scale" IS NOT NULL
	AND b."art_emblem_offset_x" IS NOT NULL
	AND b."art_emblem_offset_y" IS NOT NULL
	AND encode(
		sha256(
			convert_to(
				concat_ws(
					E'\n',
					p."noun_icon_id",
					b."art_shape",
					b."art_color",
					swatch.color,
					to_char(b."art_emblem_scale", 'FM999999999990.0000'),
					to_char(b."art_emblem_offset_x", 'FM999999999990.0000'),
					to_char(b."art_emblem_offset_y", 'FM999999999990.0000')
				),
				'UTF8'
			)
		),
		'hex'
	) = b."art_fingerprint";
