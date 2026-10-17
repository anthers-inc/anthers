// SPDX-License-Identifier: Apache-2.0
/**
 * Tags derive from the body (Parker, 2026-10-16): `#hashtag` tokens in the body's own
 * text are the tag list, recomputed from whatever the editor holds at save time — there
 * is no tag field to keep in step with the body, which is the same arrangement the
 * Work embeds follow (the body is the source of truth; the derived things derive).
 */

/** The body HTML's own text — what tag tokens are parsed from. */
export function htmlTextOf(html: string): string {
	if (!html) return "";
	const tmp = document.createElement("div");
	tmp.innerHTML = html;
	return tmp.textContent || "";
}

/** Parse `#hashtag` tokens out of the body text into a deduped tag list. */
export function parseTags(text: string): string[] {
	const set = new Set<string>();
	for (const m of text.matchAll(/#([\p{L}0-9_-]+)/gu)) set.add(m[1]);
	return [...set];
}

/** The tags a body-as-HTML carries, parsed in one step — the save-time shape. */
export function tagsFromBodyHtml(html: string): string[] {
	return parseTags(htmlTextOf(html));
}
