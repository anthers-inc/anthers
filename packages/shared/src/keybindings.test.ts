// SPDX-License-Identifier: Apache-2.0
/**
 * The shortcut grammar, pinned where a second implementation would drift: the canonical
 * order, the two platforms' meaning of `Mod`, the exact-modifier rule, the page/player
 * split over bare keys, and the server's whole-map validation.
 */
import { describe, expect, it } from "bun:test";
import {
	canonicalChord,
	chordsCollide,
	chordToString,
	DEFAULT_KEYBOARD_SHORTCUTS,
	formatChord,
	keyFromEvent,
	matchesChord,
	normalizeKeyboardShortcuts,
	parseChord,
	resolveKeyboardShortcuts,
} from "./keybindings";

describe("parsing and formatting", () => {
	it("canonicalizes the modifier order", () => {
		expect(canonicalChord("shift+mod+k")).toBe("Mod+Shift+K");
		expect(canonicalChord("Alt+Ctrl+Enter")).toBe("Ctrl+Alt+Enter");
	});

	it("refuses a bare key for a page action, Shift alone, both Mod and Ctrl, duplicates and unknown keys", () => {
		expect(parseChord("K")).toBeNull();
		expect(parseChord("Shift+K")).toBeNull();
		expect(parseChord("Mod+Ctrl+K")).toBeNull();
		expect(parseChord("Mod+Mod+K")).toBeNull();
		expect(parseChord("Mod+Banana")).toBeNull();
	});

	it("accepts a bare key only when the caller says the scope allows one", () => {
		expect(canonicalChord("f", { bare: true })).toBe("F");
		expect(canonicalChord("Shift+T", { bare: true })).toBe("Shift+T");
		expect(canonicalChord("f")).toBeNull();
	});

	it("renders Apple symbols and the rest with words", () => {
		expect(formatChord("Mod+K", true)).toBe("⌘K");
		expect(formatChord("Mod+Shift+F", true)).toBe("⌘⇧F");
		expect(formatChord("Mod+K", false)).toBe("Ctrl+K");
		expect(formatChord("Ctrl+Alt+ArrowUp", false)).toBe("Ctrl+Alt+ArrowUp");
		expect(formatChord("F", false)).toBe("F");
	});

	it("round-trips a parsed chord", () => {
		const parsed = parseChord("Mod+Alt+P");
		expect(parsed && chordToString(parsed)).toBe("Mod+Alt+P");
	});
});

describe("matching an event", () => {
	const event = {
		key: "k",
		ctrlKey: false,
		metaKey: true,
		altKey: false,
		shiftKey: false,
		repeat: false,
	};

	it("reads Mod as Command on Apple and Control elsewhere", () => {
		expect(matchesChord(event, "Mod+K", true)).toBe(true);
		expect(matchesChord(event, "Mod+K", false)).toBe(false);
		expect(matchesChord({ ...event, metaKey: false, ctrlKey: true }, "Mod+K", false)).toBe(true);
	});

	it("matches a player's bare key, and only without the modifiers it did not name", () => {
		const bare = { ...event, key: "f", metaKey: false };
		expect(matchesChord(bare, "F", false)).toBe(true);
		expect(matchesChord({ ...bare, ctrlKey: true }, "F", false)).toBe(false);
		expect(matchesChord({ ...bare, key: "F", shiftKey: true }, "F", false)).toBe(false);
	});

	it("requires every modifier to match exactly", () => {
		expect(matchesChord({ ...event, shiftKey: true }, "Mod+K", true)).toBe(false);
		expect(matchesChord({ ...event, altKey: true }, "Mod+K", true)).toBe(false);
	});

	it("ignores auto-repeat and unknown keys", () => {
		expect(matchesChord({ ...event, repeat: true }, "Mod+K", true)).toBe(false);
		expect(matchesChord({ ...event, key: "x" }, "Mod+K", true)).toBe(false);
	});

	it("names the space bar and punctuation the way a stored chord does", () => {
		expect(keyFromEvent({ key: " " })).toBe("Space");
		expect(keyFromEvent({ key: "Escape" })).toBe("Escape");
		expect(keyFromEvent({ key: "/" })).toBe("/");
		expect(keyFromEvent({ key: "k" })).toBe("K");
	});
});

describe("the stored map", () => {
	const stored = {
		search: "mod+k",
		filter: "alt+f",
		sidebar: "ctrl+/",
		fullscreen: "f",
		theater: "t",
	};

	it("accepts all five and canonicalizes them within each action's scope", () => {
		expect(normalizeKeyboardShortcuts(stored)).toEqual({
			search: "Mod+K",
			filter: "Alt+F",
			sidebar: "Ctrl+/",
			fullscreen: "F",
			theater: "T",
		});
	});

	it("refuses a missing action, an unknown action and a duplicate chord", () => {
		const { theater: _theater, ...partial } = stored;
		expect(normalizeKeyboardShortcuts(partial)).toBeNull();
		expect(normalizeKeyboardShortcuts({ ...stored, extra: "Mod+X" })).toBeNull();
		expect(normalizeKeyboardShortcuts({ ...stored, theater: "Mod+K" })).toBeNull();
	});

	it("refuses a bare page action and a modified player action that collides with one", () => {
		expect(normalizeKeyboardShortcuts({ ...stored, search: "K" })).toBeNull();
		expect(normalizeKeyboardShortcuts({ ...stored, sidebar: "/" })).toBeNull();
		expect(normalizeKeyboardShortcuts({ ...stored, fullscreen: "Alt+F" })).toBeNull();
	});

	it("refuses a Mod chord and a Ctrl chord on one key, which are one key off Apple", () => {
		// Command+K and Control+K on a Mac; Control+K twice on Windows and Linux. A map
		// follows the account across devices, so the second reading is the one that matters.
		expect(chordsCollide("Mod+K", "Ctrl+K")).toBe(true);
		expect(chordsCollide("Mod+K", "Mod+K")).toBe(true);
		expect(
			normalizeKeyboardShortcuts({ ...stored, search: "Mod+K", sidebar: "Ctrl+K" }),
		).toBeNull();
		// Distinct keys, or a modifier that genuinely differs, stay distinct.
		expect(chordsCollide("Mod+K", "Ctrl+F")).toBe(false);
		expect(chordsCollide("Mod+K", "Mod+Shift+K")).toBe(false);
		expect(chordsCollide("Mod+K", "Alt+K")).toBe(false);
		expect(
			normalizeKeyboardShortcuts({ ...stored, search: "Mod+K", sidebar: "Ctrl+F" }),
		).not.toBeNull();
	});

	it("fills defaults for an account that never set any", () => {
		expect(resolveKeyboardShortcuts(null)).toEqual(DEFAULT_KEYBOARD_SHORTCUTS);
		expect(resolveKeyboardShortcuts({ search: "Alt+S" })).toEqual({
			...DEFAULT_KEYBOARD_SHORTCUTS,
			search: "Alt+S",
		});
	});

	it("gives a row stored before the sidebar existed its default", () => {
		expect(
			resolveKeyboardShortcuts({
				search: "Mod+K",
				filter: "Mod+F",
				fullscreen: "F",
				theater: "T",
			}),
		).toEqual(DEFAULT_KEYBOARD_SHORTCUTS);
	});

	it("keeps the default map free of a collision on either platform reading", () => {
		const chords = Object.values(DEFAULT_KEYBOARD_SHORTCUTS);
		for (let i = 0; i < chords.length; i++) {
			for (let j = i + 1; j < chords.length; j++) {
				expect(chordsCollide(chords[i], chords[j]), `${chords[i]} / ${chords[j]}`).toBe(false);
			}
		}
		expect(DEFAULT_KEYBOARD_SHORTCUTS.sidebar).toBe("Ctrl+/");
	});

	it("falls back rather than disabling a broken stored chord", () => {
		expect(
			resolveKeyboardShortcuts({
				search: "Banana",
				filter: "Mod+F",
				fullscreen: "f",
				theater: "t",
			}),
		).toEqual(DEFAULT_KEYBOARD_SHORTCUTS);
	});

	it("falls back to the whole default map when a legacy row carries a collision", () => {
		expect(resolveKeyboardShortcuts({ search: "Mod+K", filter: "Mod+K" })).toEqual(
			DEFAULT_KEYBOARD_SHORTCUTS,
		);
	});
});
