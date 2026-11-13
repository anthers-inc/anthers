// SPDX-License-Identifier: Apache-2.0
/**
 * Whether this browser has put the alpha notice away, kept in `localStorage`.
 *
 * ⚠️ **It is per-browser rather than per-account**, like the other device preferences beside
 * it: the notice says the same sentence to everybody, nothing about it is account state, and a
 * column, a migration and an API door would be more machinery than a temporary banner earns.
 * The cost is that somebody who dismisses it on a laptop meets it again on their phone, which
 * is the right trade for a notice that only ever says one thing.
 *
 * Every function is total under `localStorage` failure (Safari private mode throws on access),
 * and a failed read is the notice still showing — the direction a first visit fails in.
 */

const DISMISSED_KEY = "anthers_alpha_notice_dismissed";

/** Whether the reader has already closed the alpha notice on this browser. */
export function readAlphaNoticeDismissed(): boolean {
	try {
		return globalThis.localStorage?.getItem(DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

/** Remember that the reader closed the alpha notice on this browser. */
export function dismissAlphaNotice(): void {
	try {
		globalThis.localStorage?.setItem(DISMISSED_KEY, "1");
	} catch {
		// A browser that refuses storage has nowhere to remember the choice, so the click
		// still puts the notice away for this page and it returns on the next visit. Throwing
		// here would turn a working button into a broken one.
	}
}
