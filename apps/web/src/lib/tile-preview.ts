// SPDX-License-Identifier: Apache-2.0
/**
 * The feed tile's hover preview: the gate that decides what may play, and the
 * one-active-tile store that keeps the grid honest.
 *
 * The two halves sit here rather than in the component because both are policy
 * with consumers beyond the player component's props, and because both are pure
 * enough to hold a standing test.
 *
 * ## The gate (Parker, 2026-10-12)
 *
 * A tile previews only when the viewer **could actually open the work**: the
 * access verdict answers `canAccess`, and — when the work draws the Public
 * Access allowance — the user's meter has not spent. A locked tile stays a
 * poster, and so does a spent meter; delivery refuses both cases anyway, and a
 * preview that ships bytes to fail is wasted bytes and a misleading affordance.
 *
 * ## The crediting ruling
 *
 * Preview playback **earns like playback**: the preview registers an ordinary
 * playback-mode attention claim (`lib/attention.ts`), so the seconds are earned
 * by the creator and — on Public Access work — spent by the viewer exactly as
 * they would be on the opened Work page. There is no limit on how long a
 * preview may play: a hover-to-glance and a click-in-then-back-out are
 * interchangeable behaviors, and the one is not a lesser version of the other.
 * What the ruling explicitly rules out is **autoplay at any scroll position** —
 * desktop or mobile — because that would be an engagement mechanic rather than
 * a deliberate hover.
 *
 * ## One tile at a time
 *
 * The grid can hold dozens of tiles and the browser holds one stream of
 * attention: this module keeps the single `activeKey` for whichever tile's
 * preview is playing, and a tile tears its player down when the store says
 * another tile took it. Moving the pointer from one tile to a neighbor
 * therefore never plays two previews, and never plays one "in the gap".
 */

import { isListened } from "@anthers/shared/content";
import type { PublicAccessBudget } from "@anthers/shared/public-access";
import { apiBaseUrl } from "@anthers/web-shared/rpc";
import type { AccessResult } from "@anthers/web-shared/types";

/** How long a hover must hold before bytes ship — long enough that a cursor in transit never loads a stream. */
export const PREVIEW_HOVER_DELAY_MS = 500;

/**
 * Whether this tile's work may preview for this viewer right now.
 *
 * Playback types only — the brief's "not a poster animation for other types":
 * video and the listened family play, everything else keeps its static band.
 * The access verdict is `AccessResult` (the user shape — feed entries carry it),
 * and the spent check reads the budget store so a metered preview never starts
 * what delivery would refuse.
 */
export function tilePreviewPlayable(params: {
	type: string;
	access: AccessResult | null | undefined;
	budget: PublicAccessBudget | null;
}): boolean {
	// Playback types only — the brief's "not a poster animation for other types":
	// video and the listened family play, everything else keeps its static band.
	if (params.type !== "video" && !isListened(params.type)) return false;
	if (!params.access?.canAccess) return false;
	// Unlimited users and any signed-in state the store has not heard from yet
	// carry `allowed: true` or a null budget that means "no limit in force here" —
	// delivery is the backstop for a budget gone stale between flushes.
	if (params.budget && !params.budget.allowed) return false;
	return true;
}

/**
 * Where a preview's bytes come from — the same delivery endpoints the Work page's
 * players use, minted per request. The feed serializes no payload, so nothing
 * here can be cached from the listing: every hover goes back through the gates.
 *
 * 🚨 **Addressed absolutely through `apiBaseUrl()`** — the work page's player receives
 * a Work-detail URL minted server-side, but the preview builds its own, and a *relative*
 * path would resolve against the page's host and fetch the SPA shell instead of the API
 * wherever the two differ (the plain dev checkout's API is another port entirely; the
 * web server answers every path with the app HTML and a cheerful 200, so hls.js then
 * dies parsing markup as a manifest). The one sanctioned resolver is `apiBaseUrl()`.
 *
 * A ladder-less video falls back to `/works/:id/original` when the manifest's
 * HLS attempt 404s, matching the Work page's own ladder-then-original rule; the
 * fallback happens in the player component, which owns the elements.
 */
export function previewSourceFor(work: { id: number; type: string }): string {
	const base = apiBaseUrl();
	if (work.type === "video") return `${base}/api/content/works/${work.id}/hls/master.m3u8`;
	return `${base}/api/content/works/${work.id}/audio`;
}

/** The ladder-less video's fallback route, addressed the same way. */
export function previewOriginalSourceFor(workId: number): string {
	return `${apiBaseUrl()}/api/content/works/${workId}/original`;
}

// ── The one-active-tile store ────────────────────────────────────────────────

let activeKey: string | null = null;
const listeners = new Set<(key: string | null) => void>();

/**
 * Make `key`'s tile the one playing, or clear the board entirely with null.
 *
 * A tile passes its own key on hover-after-debounce and null on leave; asking
 * for itself while already active is the refresh case and does nothing, so a
 * tile never tears its own preview down by confirming it.
 */
export function requestTilePreview(key: string | null): void {
	if (activeKey === key) return;
	activeKey = key;
	for (const fn of listeners) fn(key);
}

export function activeTilePreview(): string | null {
	return activeKey;
}

/** The store's change subscription, as an unsubscribe — the tiles use `useSyncExternalStore` with it. */
export function subscribeTilePreview(fn: (key: string | null) => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}
