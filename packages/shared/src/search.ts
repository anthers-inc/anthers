// SPDX-License-Identifier: Apache-2.0
/**
 * The one definition of a search term, shared by the API and the browser.
 *
 * 🚨 **Containment, not edit distance.** A query is lowercased, split on whitespace and
 * required to appear, term by term, as a substring of the row's searchable text — in any
 * order and in any field. "Parker Davis" therefore matches a creator called "Parker Davis"
 * and a Work whose title says "Davis" beside a creator called "Parker". A typo still finds
 * nothing, and the helper does not pretend otherwise: a fuzzy matcher that silently widens
 * a search is harder to reason about than one that misses.
 *
 * ⚠️ **Every term must match, never any of them.** "Any" turns a two-word query into a
 * broader search the more the reader types, which is the opposite of what typing more
 * means. This is the rule both the SQL builder and the client's local matcher obey.
 *
 * The stage split lives here too: names and titles first, the secondary prose only when
 * that comes up short. `SEARCH_BODY_STAGE_BELOW` is the count that decides "short", kept
 * beside the rule so the API and the panel cannot disagree about it.
 */

/** The four content kinds the API can search. Modes and Settings are client-side. */
export const SEARCH_TYPES = ["creator", "work", "project", "post"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/** The two passes. `names` is titles and handles; `body` is bios, descriptions and bodies. */
export const SEARCH_SCOPES = ["names", "body"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/**
 * How many name matches make the first pass enough.
 *
 * The second pass costs a second round of queries over the slow fields, so it runs only
 * when the first pass leaves the reader with fewer than a handful of things to choose
 * from. Five is a starting constant rather than a law; it is tuned against real queries.
 */
export const SEARCH_BODY_STAGE_BELOW = 5;

/** What the viewer already has with the row: their own, in their Library, or followed. */
export type SearchConnection = "self" | "library" | "following" | null;

/**
 * One row of either pass. The client builds the link, because the URL helpers own the
 * canonical shapes (`/works/{slug}-{publicId}`, `/posts/...`, a creator's project path).
 */
export interface SearchHit {
	kind: SearchType;
	/** The row's own id, for React keys and for the second pass's exclusion list. */
	id: number;
	title: string;
	/** The creator's name or handle, a Work's media type, or the date a post went out. */
	subtitle: string | null;
	thumbnail: string | null;
	/** The creator's handle, for every kind that belongs to one. */
	handle: string | null;
	/** Works, Projects and Posts. */
	slug: string | null;
	/** Works and Posts, the durable half of their canonical URL. */
	publicId: number | null;
	connection: SearchConnection;
}

/** Characters trimmed from a token's edges — sentence punctuation, never `@`, `#` or `+`. */
const EDGE_PUNCTUATION = /^[,.;:!?'"()[\]{}]+|[,.;:!?'"()[\]{}]+$/g;

/**
 * Split a query into its search terms.
 *
 * Lowercased because every comparison is case-insensitive, deduped because a repeated word
 * must not multiply the SQL, and trimmed of sentence punctuation so "Parker, Davis" is the
 * same query as "Parker Davis". Order is preserved: the first term is the one a caller may
 * want to emphasize, and a stable order keeps tests and ranking readable.
 */
export function searchTerms(query: string): string[] {
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const raw of query.toLowerCase().split(/\s+/)) {
		const term = raw.replace(EDGE_PUNCTUATION, "");
		if (!term || seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
	}
	return terms;
}

/**
 * Whether every term appears somewhere in the row's searchable fields.
 *
 * The fields are joined with a newline rather than a space, so a term cannot be assembled
 * across two fields — a title ending in "Park" beside a creator starting in "er" is not a
 * match for "Parker". An empty term list matches nothing: a blank box is not a query.
 */
export function matchesTerms(
	terms: readonly string[],
	fields: readonly (string | null | undefined)[],
): boolean {
	if (terms.length === 0) return false;
	const haystack = fields
		.filter((field): field is string => typeof field === "string" && field.length > 0)
		.join("\n")
		.toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

/**
 * Escape the characters a SQL `LIKE`/`ILIKE` pattern treats specially.
 *
 * A query containing `%` or `_` is a literal search for those characters, not a wildcard;
 * a reader typing "100%" is asking for the title that says it. The backslash is escaped
 * first by including it in the same class, so the replacement cannot double-escape itself.
 */
export function escapeLike(term: string): string {
	return term.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The `%term%` pattern the SQL builder uses, escaped for a literal containment match. */
export function likeContains(term: string): string {
	return `%${escapeLike(term)}%`;
}

/** A type guard for the query string's `type` parameter. */
export function isSearchType(value: unknown): value is SearchType {
	return typeof value === "string" && (SEARCH_TYPES as readonly string[]).includes(value);
}

/** A type guard for the query string's `scope` parameter. */
export function isSearchScope(value: unknown): value is SearchScope {
	return typeof value === "string" && (SEARCH_SCOPES as readonly string[]).includes(value);
}
