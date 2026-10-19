// SPDX-License-Identifier: Apache-2.0
/**
 * Work tags — the vocabulary a creator puts on a Work, and the bounds both the API and
 * the Details tab enforce.
 *
 * A tag is a **slug-shaped word**: lowercased, whitespace turned into a hyphen, and
 * limited to letters, numbers, hyphens and underscores. That is the shape the filter
 * sidebar's curated vocabulary already uses (`indie`, `pixel-art`, `lo-fi`), so a tag
 * typed in the editor matches the same way a curated one does, and a URL carrying it
 * stays readable. The normalization runs on both sides from this module so the chip the
 * creator sees and the value the server stores cannot disagree.
 *
 * ⚠️ **Arbitrary means "not from a fixed list", not "any characters".** A creator can
 * start a tag nobody has used, which is the point — the suggestion list shows live
 * popularity so a specific new tag is a deliberate choice rather than a typo. A string
 * that cannot be a slug is refused with a sentence rather than silently truncated.
 */

/** The most tags one Work may carry. Changing one is fine; the cap is the list's length. */
export const MAX_WORK_TAGS = 5;

/** A tag's longest normalized form, in characters. */
export const TAG_MAX_LENGTH = 32;

/** What a normalized tag may contain: unicode letters and numbers, hyphen and underscore. */
const TAG_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/**
 * The canonical form of one typed tag: trimmed, lowercased, whitespace collapsed into a
 * hyphen, repeated hyphens collapsed, and a leading `#` dropped so a creator can paste a
 * hashtag. Returns `""` when nothing is left.
 */
export function normalizeTag(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replace(/^#+/, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Why a tag cannot be used, as a sentence a creator can act on, or `null` when it can.
 * The check is against the normalized form, so `"  Cozy Horror "` is accepted as
 * `cozy-horror`.
 */
export function tagProblem(raw: string): string | null {
	const tag = normalizeTag(raw);
	if (!tag) return "A tag needs at least one letter or number.";
	if (tag.length > TAG_MAX_LENGTH) return `Tags are at most ${TAG_MAX_LENGTH} characters long.`;
	if (!TAG_PATTERN.test(tag)) return "Tags can use letters, numbers, hyphens and underscores.";
	return null;
}

/** Normalize a whole list, dropping blanks and duplicates while keeping the first order. */
export function normalizeWorkTags(raw: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of raw) {
		const tag = normalizeTag(value);
		if (!tag || seen.has(tag)) continue;
		seen.add(tag);
		out.push(tag);
	}
	return out;
}

/** Why a whole tag list cannot be saved, or `null` when it can. */
export function workTagsProblem(tags: readonly string[]): string | null {
	if (tags.length > MAX_WORK_TAGS) {
		return `A Work can carry up to ${MAX_WORK_TAGS} tags.`;
	}
	for (const tag of tags) {
		const problem = tagProblem(tag);
		if (problem) return problem;
	}
	return null;
}
