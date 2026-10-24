// SPDX-License-Identifier: Apache-2.0
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
 * t theater, c captions, m mute, digits seek by tenths, `,`/`.` step a frame while paused.
 * j/l move by ten *seconds on video*; a spoken player overrides the step via `jump`, which
 * is what a podcast pair (−15, +30) binds to instead.
 *
 * ⚠️ **Full screen and theater are the account's chords, not constants.** They arrive from
 * `useKeyboardShortcuts`, and are matched before the modifier guard below — a person who
 * rebinds full screen to `Mod+Shift+F` means it, and the player is the only thing listening.
 */
import { matchesChord } from "@anthers/shared/keybindings";
import type { KeyboardEvent } from "react";
import { useKeyboardShortcuts } from "@/lib/keyboard-shortcuts";
import { isApplePlatform } from "@/lib/platform";

export interface MediaShortcutHandlers {
	togglePlay?: () => void;
	/** Seconds — negative seeks back. Bound to the arrow keys. */
	nudge?: (seconds: number) => void;
	/**
	 * j/l, by direction rather than by seconds. Absent, they move ±10 seconds through
	 * `nudge`; the spoken player's pair (−15, +30) is the reason this exists as its own
	 * handler.
	 */
	jump?: (direction: 1 | -1) => void;
	/** Fraction 0–1 of the whole duration. */
	seekFraction?: (fraction: number) => void;
	adjustVolume?: (delta: number) => void;
	toggleMuted?: () => void;
	toggleFullscreen?: () => void;
	/** The page's theater mode, when the player is mounted where one exists. */
	toggleTheater?: () => void;
	/** One frame-ish step; only meaningful for video. */
	stepFrame?: (direction: 1 | -1) => void;
	/** Multiplier steps through the speed list. */
	stepRate?: (direction: 1 | -1) => void;
	/** c — whether captions are showing at all, when the video carries tracks. */
	toggleCaptions?: () => void;
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
	const shortcuts = useKeyboardShortcuts();
	const apple = isApplePlatform();

	return function onKeyDown(e: KeyboardEvent<HTMLElement>) {
		// A focused range input inside the transport is a control in its own right: its
		// own arrow keys must seek *it*, not be intercepted here.
		if (isTyping(e.target)) return;

		const h = handlers;
		const run = (fn: (() => void) | undefined) => {
			if (!fn) return;
			e.preventDefault();
			fn();
		};

		// The account's player chords come first, before the modifier guard: they are
		// matched exactly (a chord without Shift will not fire while Shift is held), and a
		// player is the only listener for them, so a modified binding is safe here.
		if (matchesChord(e, shortcuts.fullscreen, apple)) return run(h.toggleFullscreen);
		if (matchesChord(e, shortcuts.theater, apple)) return run(h.toggleTheater);

		// Leave every browser and OS shortcut alone. Ctrl+F is find, not fullscreen.
		if (e.ctrlKey || e.metaKey || e.altKey) return;

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
				return run((h.jump && (() => h.jump?.(-1))) ?? (h.nudge && (() => h.nudge?.(-10))));
			case "l":
			case "L":
				return run((h.jump && (() => h.jump?.(1))) ?? (h.nudge && (() => h.nudge?.(10))));
			case "ArrowUp":
				return run(h.adjustVolume && (() => h.adjustVolume?.(0.05)));
			case "ArrowDown":
				return run(h.adjustVolume && (() => h.adjustVolume?.(-0.05)));
			case "m":
			case "M":
				return run(h.toggleMuted);
			case "c":
			case "C":
				return run(h.toggleCaptions);
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
