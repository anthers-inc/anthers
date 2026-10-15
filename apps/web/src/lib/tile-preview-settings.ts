// SPDX-License-Identifier: Apache-2.0
/**
 * The feed-tile preview preferences, remembered per install.
 *
 * Both are properties of *the browser*, not of the account — the same home the desktop
 * home and the remembered volume keep — so they live in `localStorage` beside them. The
 * settings page reads and writes them through this module's hook, and the feed reads
 * them on every render, so a stop takes effect the moment it is set, preview or no.
 *
 * ## Play previews as I browse (Parker, 2026-10-15)
 *
 * Defaults **on**, per the brief that called for the stop: inline hover playback is
 * the cursor's doing, and it stays that way by being stoppable rather than by being
 * forced. Turning it off returns every tile to its poster — see the gate in
 * `lib/tile-preview.ts`, which is the one function every tile's preview passes.
 */

import { useSyncExternalStore } from "react";

const PREVIEWS_KEY = "anthers_tile_previews";

/** What is stored, or the first-visit default. Exported so it is testable alone. */
export function readStoredPreviews(): boolean {
	try {
		// Anything but the off mark is on: a missing key, a corrupted value and
		// unreadable storage all land on the default. `getItem` never throws here that
		// the catch would need to mean anyway.
		return localStorage.getItem(PREVIEWS_KEY) !== "0";
	} catch {
		// Storage disabled (private mode, a hardened browser): the default, which is on.
		return true;
	}
}

let current: boolean = readStoredPreviews();
const listeners = new Set<() => void>();

/** Write the preference through, so a later visit reads the same answer. */
export function setPreviewsEnabled(next: boolean): void {
	current = next;
	try {
		localStorage.setItem(PREVIEWS_KEY, next ? "1" : "0");
	} catch {
		// Unwritable storage costs persistence, not the setting — the same failure
		// mode the remembered volume keeps.
	}
	for (const fn of listeners) fn();
}

export function previewsEnabled(): boolean {
	return current;
}

/** The store's change subscription, as an unsubscribe — the hook registers the readers. */
export function subscribe(fn: () => void): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

/** The current preference with live updates — setting it re-renders every reader. */
export function usePreviewsEnabled(): boolean {
	return useSyncExternalStore(subscribe, previewsEnabled);
}
