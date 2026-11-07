// SPDX-License-Identifier: Apache-2.0
/**
 * One speaker at a time.
 *
 * 🚨 **The app has eight audio-bearing media elements and nothing arbitrated between
 * them.** The persistent bar owns one detached `<audio>`; the Work page's video, music and
 * spoken players each own their own element; the feed's hover preview and a locked Work's
 * trailer carousel own raw ones. The browser happily plays two, so music in the bar kept
 * playing under a video, and a hover preview could start sound over either.
 *
 * The rule is stated once here rather than at each player: an element that starts *audible*
 * playback pauses every other registered element. A muted element does not claim the
 * speaker — a hover preview begins muted by design — but the moment its volume or mute
 * changes to audible it claims too, which is what covers a viewer unmuting the hover sound
 * midway through a track.
 *
 * Registration is per element, in a module-level set, because the surfaces that own media
 * do not share a React subtree (the feed, the Work page and the bar all mount their own).
 * `useExclusivePlayback` is the hook for a JSX element; `registerExclusivePlayback` is for
 * the bar, whose element is created imperatively.
 */

import { type RefObject, useEffect } from "react";

const registered = new Set<HTMLMediaElement>();

/** Whether an element is currently producing sound the listener could hear. */
function audible(element: HTMLMediaElement): boolean {
	return !element.paused && !element.muted && element.volume > 0;
}

/**
 * Pause every other registered element, if `winner` is audible. Called on `play` and on
 * `volumechange`, so an unmute lands the same way a fresh play does.
 */
function claim(winner: HTMLMediaElement): void {
	if (!audible(winner)) return;
	for (const element of registered) {
		if (element !== winner && !element.paused) element.pause();
	}
}

/**
 * Register an element as one of the players that take turns. Returns the cleanup that
 * unregisters it and removes its listeners; idempotent, so unmounting a component twice is
 * harmless.
 */
export function registerExclusivePlayback(element: HTMLMediaElement): () => void {
	registered.add(element);
	const onStart = () => claim(element);
	element.addEventListener("play", onStart);
	element.addEventListener("volumechange", onStart);
	return () => {
		registered.delete(element);
		element.removeEventListener("play", onStart);
		element.removeEventListener("volumechange", onStart);
	};
}

/**
 * The hook form for a player whose element is a JSX child. `attachKey` re-registers when the
 * element itself is replaced (a carousel swapping one trailer for another under the same
 * ref), which a stable ref object does not signal on its own.
 */
export function useExclusivePlayback(
	ref: RefObject<HTMLMediaElement | null>,
	attachKey?: unknown,
): void {
	// biome-ignore lint/correctness/useExhaustiveDependencies: attachKey is the caller's signal that the element under the stable ref changed.
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		return registerExclusivePlayback(element);
	}, [ref, attachKey]);
}
