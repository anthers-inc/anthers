// SPDX-License-Identifier: Apache-2.0
/**
 * Work links inside a post body — the embeds Parker settled 2026-10-16, doing away with
 * linked Works as a first-class field of a Post: you add a link to a Work in the body,
 * and the post renders a card for it **under the text**, the way a Bluesky post renders
 * a YouTube player for the link it carries. The link stays in the text; the card rides
 * under it.
 *
 * The body is the source of truth, so nothing is stored: the Works a post embeds are
 * extracted from the stored markdown at read time by {@link workPublicIdsFromBody}, in
 * order of first appearance, and resolved through the same gated serializer the
 * `post_work_refs`-based loader used to use (the reference is inert; each Work resolves
 * on its own gates, exactly as the schema's comment on the old join table said). The
 * SQL-side pattern {@link PG_WORK_URL_PATTERN} carries the same shape for the
 * derivations that must run inside the database — the feed's media-type filter and a
 * Work's posting history — where loading and parsing every row would be the wrong cost.
 *
 * A link that no longer resolves (the Work deleted, say) renders as the plain link it
 * already is in the text, with no card — the same decay an embedded video has when its
 * source page goes away.
 */

/**
 * The shape of a Work's public path inside a stored body: `/works/{slug}-{publicId}`,
 * relative, or absolute at an Anthers-hosted domain — `https://anthers.org/works/…`,
 * `https://www.anthers.org/works/…`, or one of the machine's subdomains. The trailing
 * `publicId` (always 9 digits) is what resolves the Work, so the slug part may be
 * anything: `/works/anything-at-all-534000269` and the bare `/works/534000269` both extract.
 *
 * One expression with one capture: the Anthers-hosted domain prefix is optional, and the
 * lookbehind keeps the match from starting inside a longer path or host — a URL on
 * somebody else's domain whose own path happens to carry `/works/…` is not our embed,
 * and neither is a `foo/works/…` fragment of some other kind of address.
 *
 * 🚨 **The capture is the LAST 9-digit run in the path, not the first number that looks
 * long enough.** A slug may itself carry a digit group — `old-game-700065d2-910000001`
 * is a real address this parser sees — and a pattern that stopped at the first six-digit
 * run would capture `700065`, reject it as out of range, and lose the real embed. The
 * greedy path body backtracks to the publicId at the end, and the digit boundaries keep
 * a longer run from yielding its own tail.
 */
const WORK_LINK_RE =
	/(?<![a-zA-Z0-9./-])(?:https?:\/\/(?:[a-zA-Z0-9-]+\.)*anthers\.org)?\/works\/[^\s()>"']*(?<!\d)(\d{9})(?!\d)/g;

/**
 * The public ids a stored markdown body embeds, first appearance first, deduped.
 *
 * ⭐ **A capture is only treated as a publicId when it is in range.** Public ids are
 * always 9 digits (≥ 100,000,000 — `makeUniquePublicId` guarantees it), and the 9-digit
 * capture keeps a slug's own smaller digit groups from being looked up at all.
 */
export function workPublicIdsFromBody(markdown: string | null | undefined): number[] {
	if (!markdown) return [];
	const ids: number[] = [];
	for (const m of markdown.matchAll(WORK_LINK_RE)) {
		const id = Number(m[1]);
		if (id >= 100_000_000 && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * The same shape as a Postgres regex string, for derivations that run inside a query —
 * the feed's media-type filter (`posts whose body embeds a Work of type X`) and a
 * Work's posting history (the posts embedding it). POSIX has no lookahead, so the digit
 * boundary is the alternation form instead, and the capture group is what the caller
 * joins on.
 *
 * The capture is the 9-digit public id itself, so a slug's smaller digit groups no
 * longer swallow the match. Joining `works.public_id` cannot match a capture below the
 * id range, because no row carries one.
 */
export const PG_WORK_URL_PATTERN = "/works/[^[:space:]()>'\"]*([0-9]{9})([^0-9]|$)";

/**
 * The pattern for one specific Work — the posts embedding **this** Work, with its own
 * public id baked in. The same boundary rule; the lookbehind equivalent is the
 * `-?` prefix, because a slug's digits immediately before the id would join it instead.
 */
export function pgWorkEmbedPattern(publicId: number): string {
	return `/works/[^[:space:]()>'"]*-?${publicId}([^0-9]|$)`;
}

/**
 * The pattern for one Work mentioned in a post's TITLE — the Showings lookup.
 *
 * A mention is a markdown link whose text begins with `@` (`[@Curtains](/works/…-123456789)`),
 * and requiring the `@` is what keeps this list equal to the parser's own: a plain Work
 * link pasted into a title is not a mention, and the Showings panel must not claim it is
 * one. Same digit boundary as {@link pgWorkEmbedPattern}.
 */
export function pgWorkTitleMentionPattern(publicId: number): string {
	return `\\[@[^]]*\\]\\([^)]*?/works/[^[:space:]()>'"]*-?${publicId}([^0-9]|$)`;
}
