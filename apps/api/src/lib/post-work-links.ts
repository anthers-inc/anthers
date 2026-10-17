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
 * `publicId` (≥ 6 digits) is what resolves the Work, so the slug part may be anything:
 * `/works/anything-at-all-534000269` and the bare `/works/534000269` both extract.
 *
 * One expression with one capture: the Anthers-hosted domain prefix is optional, and the
 * lookbehind keeps the match from starting inside a longer path or host — a URL on
 * somebody else's domain whose own path happens to carry `/works/…` is not our embed,
 * and neither is a `foo/works/…` fragment of some other kind of address.
 */
const WORK_LINK_RE =
	/(?<![a-zA-Z0-9./-])(?:https?:\/\/(?:[a-zA-Z0-9-]+\.)*anthers\.org)?\/works\/[^\s()>"']*?(\d{6,})(?!\d)/g;

/**
 * The public ids a stored markdown body embeds, first appearance first, deduped.
 *
 * ⭐ **A capture is only treated as a publicId when it is in range.** Public ids are
 * always 9 digits (≥ 100,000,000 — `makeUniquePublicId` guarantees it), and a slug's own
 * digit groups can look like one: anything smaller cannot be a public id and is ignored
 * rather than looked up, so `/works/123456-title` extracts nothing.
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
 * The same ≥-9-digit readback applies: joining `works.public_id` cannot match a capture
 * below the id range, because no row carries one.
 */
export const PG_WORK_URL_PATTERN = "/works/[^[:space:]()>'\"]*?-?([0-9]{6,})([^0-9]|$)";

/**
 * The pattern for one specific Work — the posts embedding **this** Work, with its own
 * public id baked in. The same boundary rule; the lookbehind equivalent is the
 * `-?` prefix, because a slug's digits immediately before the id would join it instead.
 */
export function pgWorkEmbedPattern(publicId: number): string {
	return `/works/[^[:space:]()>'"]*-?${publicId}([^0-9]|$)`;
}
