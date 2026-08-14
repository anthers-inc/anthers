// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keyboard control for a player, as one keymap every player shares.
 *
 * 🚨 **Scoped to the player, never to the document.** A global `keydown` listener is the
 * obvious implementation and it is wrong here: Space would stop scrolling the page, and
 * arrow keys would stop moving the caret — on a site whose pages are mostly reading. So
 * this returns an `onKeyDown` for the player's own container, which means the keys work
 * once the player has focus and are inert until then. Clicking the picture focuses it,
 * which is what makes "click the video, press space" behave the way people expect.
 *
 * The bindings follow the conventions people already have from YouTube and VLC rather
 * than inventing any: space/k play, j/l jump ten, arrows nudge five, f fullscreen,
 * m mute, digits seek by tenths, `,`/`.` step a frame while paused.
 */
import type { KeyboardEvent } from "react";

export interface MediaShortcutHandlers {
	togglePlay?: () => void;
	/** Seconds — negative seeks back. */
	nudge?: (seconds: number) => void;
	/** Fraction 0–1 of the whole duration. */
	seekFraction?: (fraction: number) => void;
	adjustVolume?: (delta: number) => void;
	toggleMuted?: () => void;
	toggleFullscreen?: () => void;
	/** One frame-ish step; only meaningful for video. */
	stepFrame?: (direction: 1 | -1) => void;
	/** Multiplier steps through the speed list. */
	stepRate?: (direction: 1 | -1) => void;
	next?: () => void;
	previous?: () => void;
}

/** Whether the key belongs to whatever the user is typing into rather than to us. */
function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return (
		tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
	);
}

export function useMediaShortcuts(handlers: MediaShortcutHandlers) {
	return function onKeyDown(e: KeyboardEvent<HTMLElement>) {
		// A focused range input inside the transport is a control in its own right: its
		// own arrow keys must seek *it*, not be intercepted here.
		if (isTyping(e.target)) return;
		// Leave every browser and OS shortcut alone. Ctrl+F is find, not fullscreen.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

		const h = handlers;
		const run = (fn: (() => void) | undefined) => {
			if (!fn) return;
			e.preventDefault();
			fn();
		};

		switch (e.key) {
			case " ":
			case "k":
			case "K":
				return run(h.togglePlay);
			case "ArrowLeft":
				return run(h.nudge && (() => h.nudge?.(-5)));
			case "ArrowRight":
				return run(h.nudge && (() => h.nudge?.(5)));
			case "j":
			case "J":
				return run(h.nudge && (() => h.nudge?.(-10)));
			case "l":
			case "L":
				return run(h.nudge && (() => h.nudge?.(10)));
			case "ArrowUp":
				return run(h.adjustVolume && (() => h.adjustVolume?.(0.05)));
			case "ArrowDown":
				return run(h.adjustVolume && (() => h.adjustVolume?.(-0.05)));
			case "m":
			case "M":
				return run(h.toggleMuted);
			case "f":
			case "F":
				return run(h.toggleFullscreen);
			case "n":
			case "N":
				return run(h.next);
			case "p":
			case "P":
				return run(h.previous);
			case ",":
				// Shift turns the frame steps into speed steps, so one pair of keys covers
				// both without a second mnemonic to remember (`<` and `>` are the same keys).
				return run(e.shiftKey ? h.stepRate && (() => h.stepRate?.(-1)) : () => h.stepFrame?.(-1));
			case ".":
				return run(e.shiftKey ? h.stepRate && (() => h.stepRate?.(1)) : () => h.stepFrame?.(1));
			default:
				break;
		}

		// Digits seek by tenths — 0 is the start, 7 is 70% in.
		if (/^[0-9]$/.test(e.key) && h.seekFraction) {
			e.preventDefault();
			h.seekFraction(Number(e.key) / 10);
		}
	};
}
