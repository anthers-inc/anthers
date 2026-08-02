// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical, durable post URL: `/posts/{slug}-{publicId}`.
 *
 * The numeric `publicId` is the durable key — the API resolves a post by it, so
 * renaming (which changes the slug) never breaks a link. `/posts/{publicId}`
 * alone also resolves and redirects to canonical.
 */
export function postUrl(post: { slug: string; publicId: number }): string {
	return `/posts/${post.slug}-${post.publicId}`;
}

/**
 * A Work's canonical URL. Same shape as a post's and for the same reason: the publicId is
 * the durable part, so renaming a Work never breaks a link someone shared.
 */
export function workUrl(work: { slug?: string | null; publicId?: number | null }): string {
	if (work.publicId == null) return `/works/${work.slug ?? ""}`;
	return `/works/${work.slug ?? ""}-${work.publicId}`;
}

/** Extract the trailing numeric publicId from a `slug-publicId` (or bare publicId) route param. */
export function publicIdFromParam(param: string): number | null {
	if (/^\d+$/.test(param)) return Number(param);
	const m = param.match(/-(\d{6,})$/);
	return m ? Number(m[1]) : null;
}
