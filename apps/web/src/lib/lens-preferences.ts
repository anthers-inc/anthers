// SPDX-License-Identifier: Apache-2.0
/**
 * The Music Player lens's remembered scope, kept in `localStorage`.
 *
 * ⭐ **Include spoken word moved off the lens itself on 2026-11-06** and into Settings →
 * Experience, beside the rest of the account's and the browser's browsing preferences. The
 * control is no longer a rider on the sidebar row, so the lens pages read the answer here
 * rather than from a URL parameter — a preference set in one place is not a fact about a
 * link, and a shared `?spoken=1` would outlive the setting it was copied from.
 *
 * ⚠️ **It is per-browser, not per-account**, for the same reason Media & Play is: it shapes
 * what this browser's lens draws, and the Settings card says so. Every function is total
 * under `localStorage` failure (Safari private mode throws on access), and a failed read is
 * the default — music only.
 */

const INCLUDE_SPOKEN_KEY = "anthers_music_include_spoken";

/** Whether the Music Player lens draws spoken-word audio beside music. */
export function readIncludeSpoken(): boolean {
	try {
		return globalThis.localStorage?.getItem(INCLUDE_SPOKEN_KEY) === "1";
	} catch {
		return false;
	}
}

export function writeIncludeSpoken(on: boolean): void {
	try {
		if (on) globalThis.localStorage?.setItem(INCLUDE_SPOKEN_KEY, "1");
		else globalThis.localStorage?.removeItem(INCLUDE_SPOKEN_KEY);
	} catch {
		// A browser that refuses storage gets the default on the next render rather than an
		// error; the toggle simply does not persist there.
	}
}
