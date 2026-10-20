// SPDX-License-Identifier: Apache-2.0
/**
 * `@` mentions of a Work in a Post's title.
 *
 * A title mention is written and stored as an ordinary markdown link whose text is the
 * `@` name and whose destination is the Work's public path:
 *
 *     [@Curtains](/works/curtains-123456789) Discussion (Spoilers)
 *
 * 🚨 **The destination is the durable half; the text is only a fallback.** A Work may be
 * retitled at any time, so every surface renders the name the public id resolves to and
 * keeps the stored text only for the case where the Work is gone. That is the same
 * bargain the body's Work links make — the title is the source of truth and nothing is
 * stored beside it — and it is why there is no mention table to drift from the text.
 *
 * The destination is the shape body embeds already use (`/works/{slug}-{publicId}`), so
 * the same SQL pattern finds a title mention (`pgWorkEmbedPattern` in the API).
 */

/** One run of a title: ordinary text, or a mention carrying the Work it resolves. */
export type PostTitleSegment =
	| { kind: "text"; text: string }
	| { kind: "mention"; text: string; publicId: number };

/**
 * A mention-shaped link. The optional host is the same Anthers-hosted prefix the body
 * parser accepts, so a pasted absolute link works and somebody else's `/works/…` path
 * does not. The text must begin with `@`: a plain Work link in a title is not a mention.
 */
const TITLE_MENTION_RE =
	/\[(@[^\]]*)\]\((?:https?:\/\/(?:[a-zA-Z0-9-]+\.)*anthers\.org)?\/works\/[^\s()>"']*?(\d{6,})(?!\d)\)/g;

/** Public ids are always nine digits (`makeUniquePublicId`); a slug's digits are not. */
const MIN_PUBLIC_ID = 100_000_000;

/**
 * A title as its parts, in order. A malformed or below-range id stays ordinary text, so
 * a title that merely looks like a mention never resolves to an unrelated Work.
 */
export function postTitleSegments(title: string | null | undefined): PostTitleSegment[] {
	if (!title) return [];
	const segments: PostTitleSegment[] = [];
	let cursor = 0;
	for (const match of title.matchAll(TITLE_MENTION_RE)) {
		const publicId = Number(match[2]);
		if (publicId < MIN_PUBLIC_ID) continue;
		const start = match.index ?? 0;
		if (start > cursor) segments.push({ kind: "text", text: title.slice(cursor, start) });
		segments.push({ kind: "mention", text: match[1], publicId });
		cursor = start + match[0].length;
	}
	if (cursor < title.length) segments.push({ kind: "text", text: title.slice(cursor) });
	if (segments.length === 0) segments.push({ kind: "text", text: title });
	return segments;
}

/**
 * The title as a reader would say it, with every mention kept as its stored text. This is
 * what a slug is derived from, so a mention never puts the Work's public id into a post's
 * URL, and what search matches (the stored text is the name at write time).
 */
export function visiblePostTitle(title: string | null | undefined): string {
	return postTitleSegments(title)
		.map((segment) => segment.text)
		.join("");
}

/** The Works a title mentions, first appearance first, deduped. */
export function mentionedWorkPublicIds(title: string | null | undefined): number[] {
	const ids: number[] = [];
	for (const segment of postTitleSegments(title)) {
		if (segment.kind === "mention" && !ids.includes(segment.publicId)) ids.push(segment.publicId);
	}
	return ids;
}

/**
 * The visible `@` name for a Work. Titles may contain the bracket that would end a
 * markdown link, so `[` and `]` are normalized to parentheses; the rendered name comes
 * from the Work's current title, so this is the one place a mention's look is decided.
 */
export function workMentionLabel(title: string): string {
	const clean = title
		.replace(/[[\]]/g, (bracket) => (bracket === "[" ? "(" : ")"))
		.replace(/\s+/g, " ")
		.trim();
	return `@${clean || "Untitled"}`;
}

/**
 * The canonical form of one mention, as the picker inserts it and as a title stores it.
 */
export function workMentionMarkdown(work: {
	title: string;
	slug: string;
	publicId: number;
}): string {
	return `[${workMentionLabel(work.title)}](/works/${work.slug}-${work.publicId})`;
}

/**
 * The title with every mention's stored text replaced by the Work's current name. The
 * resolver returns the name without its `@`; an unresolved Work keeps the stored text,
 * which is the fallback the segment carries.
 */
export function resolvedPostTitle(
	title: string | null | undefined,
	nameFor: (publicId: number) => string | null | undefined,
): string {
	return postTitleSegments(title)
		.map((segment) => {
			if (segment.kind !== "mention") return segment.text;
			const name = nameFor(segment.publicId);
			return name ? workMentionLabel(name) : segment.text;
		})
		.join("");
}

/** Whether a title carries any mention at all — the cheap gate before resolving one. */
export function hasWorkMention(title: string | null | undefined): boolean {
	return postTitleSegments(title).some((segment) => segment.kind === "mention");
}
