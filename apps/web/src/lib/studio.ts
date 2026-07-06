// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resolve the Creator Studio's origin (studio.anthers.org) as seen from the consumer
 * site. Post authoring lives on the Studio — a separate, cross-origin-isolated origin
 * (see epic E50) — so New-Post/Edit entry points are full-page links there, not in-app
 * routes. Counterpart to the Studio's `consumerOrigin()`.
 *   - localhost / 127.0.0.1 → the Studio dev server on :3001
 *   - otherwise             → `studio.<apex>` (canonical prod domain is anthers.org)
 */
export function studioOrigin(): string {
	if (typeof location === "undefined") return "";
	const h = location.hostname;
	if (h === "localhost" || h === "127.0.0.1") return "http://localhost:3001";
	return `${location.protocol}//studio.${h.replace(/^www\./, "")}`;
}

/** Full URL to the Studio's "new post" authoring page. */
export function studioNewPostUrl(): string {
	return `${studioOrigin()}/posts/new`;
}

/** Full URL to the Studio's edit page for a given post slug. */
export function studioEditPostUrl(slug: string): string {
	return `${studioOrigin()}/posts/${slug}/edit`;
}
