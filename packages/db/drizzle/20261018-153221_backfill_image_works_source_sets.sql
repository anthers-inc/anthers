-- The image kind joins the source set (2026-10-18): an Image Work may carry a set of
-- images the Work displays as a gallery, and `work_source_files` is row-level truth for
-- the image kind the way it became for the paged kinds in 0138. No schema change — this
-- backfill gives every existing image Work with a file its one-row set, so its set editor,
-- its delivery and its cover never run on the legacy-column fallback.
--
-- 🚨 The mime is read off the stored URL's extension where the extension says something,
-- and left as the `image` marker where it does not. Nothing displays or processes from it;
-- the guard that keeps a gallery image-only reads it only to keep an honest set honest,
-- and the image set's rows are otherwise address-shaped, not mime-shaped.
INSERT INTO "work_source_files" ("work_id", "position", "file", "filename", "mime_type")
SELECT
	id,
	0,
	source_key,
	split_part(source_key, '/', -1),
	CASE lower(split_part(split_part(source_key, '?', 1), '.', -1))
		WHEN 'jpg' THEN 'image/jpeg'
		WHEN 'jpeg' THEN 'image/jpeg'
		WHEN 'png' THEN 'image/png'
		WHEN 'webp' THEN 'image/webp'
		WHEN 'gif' THEN 'image/gif'
		WHEN 'avif' THEN 'image/avif'
		WHEN 'bmp' THEN 'image/bmp'
		WHEN 'tif' THEN 'image/tiff'
		WHEN 'tiff' THEN 'image/tiff'
		ELSE 'image'
	END
FROM works
WHERE type = 'image' AND source_key <> '';