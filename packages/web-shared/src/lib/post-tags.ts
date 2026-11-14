// SPDX-License-Identifier: Apache-2.0
/**
 * Tags derive from the body (Parker, 2026-10-16): `#hashtag` tokens in the body's own
 * text are the tag list, recomputed from whatever the editor holds at save time — there
 * is no tag field to keep in step with the body, which is the same arrangement the
 * Work embeds follow (the body is the source of truth; the derived things derive).
 */

/**
 * The body HTML's own text — what tag tokens are parsed from.
 *
 * ⚠️ **`doc` is a seam for tests, not a second behavior.** A comment's tags are parsed in the
 * browser, where the global document is the page's; a unit test passes a detached window's
 * document so it does not register a DOM into a process that also runs the server suites.
 */
export function htmlTextOf(html: string, doc: Document = document): string {
	if (!html) return "";
	const tmp = doc.createElement("div");
	tmp.innerHTML = html;
	// 🚨 A tag is a public label, and a spoiler's words were withheld from the reader on
	// purpose — a `#hashtag` typed inside one must not mint one. The element is removed
	// rather than its text filtered, so the words are gone before parsing ever sees them.
	for (const hidden of tmp.querySelectorAll(".spoiler")) hidden.remove();
	return tmp.textContent || "";
}

/** Parse `#hashtag` tokens out of the body text into a deduped tag list. */
export function parseTags(text: string): string[] {
	const set = new Set<string>();
	for (const m of text.matchAll(/#([\p{L}0-9_-]+)/gu)) set.add(m[1]);
	return [...set];
}

/** The tags a body-as-HTML carries, parsed in one step — the save-time shape. */
export function tagsFromBodyHtml(html: string, doc?: Document): string[] {
	return parseTags(htmlTextOf(html, doc));
}
