// SPDX-License-Identifier: Apache-2.0
/**
 * The shortcut grammar, pinned where a second implementation would drift: the canonical
 * order, the two platforms' meaning of `Mod`, the exact-modifier rule, and the server's
 * whole-map validation.
 */
import { describe, expect, it } from "bun:test";
import {
	canonicalChord,
	chordToString,
	DEFAULT_SEARCH_SHORTCUTS,
	formatChord,
	keyFromEvent,
	matchesChord,
	normalizeSearchShortcuts,
	parseChord,
	resolveSearchShortcuts,
} from "./keybindings";

describe("parsing and formatting", () => {
	it("canonicalizes the modifier order", () => {
		expect(canonicalChord("shift+mod+k")).toBe("Mod+Shift+K");
		expect(canonicalChord("Alt+Ctrl+Enter")).toBe("Ctrl+Alt+Enter");
	});

	it("refuses a bare key, Shift alone, both Mod and Ctrl, duplicates and unknown keys", () => {
		expect(parseChord("K")).toBeNull();
		expect(parseChord("Shift+K")).toBeNull();
		expect(parseChord("Mod+Ctrl+K")).toBeNull();
		expect(parseChord("Mod+Mod+K")).toBeNull();
		expect(parseChord("Mod+Banana")).toBeNull();
	});

	it("renders Apple symbols and the rest with words", () => {
		expect(formatChord("Mod+K", true)).toBe("⌘K");
		expect(formatChord("Mod+Shift+F", true)).toBe("⌘⇧F");
		expect(formatChord("Mod+K", false)).toBe("Ctrl+K");
		expect(formatChord("Ctrl+Alt+ArrowUp", false)).toBe("Ctrl+Alt+ArrowUp");
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
	it("accepts the whole pair and canonicalizes it", () => {
		expect(normalizeSearchShortcuts({ search: "mod+k", filter: "alt+f" })).toEqual({
			search: "Mod+K",
			filter: "Alt+F",
		});
	});

	it("refuses a missing action, an unknown action and a duplicate chord", () => {
		expect(normalizeSearchShortcuts({ search: "Mod+K" })).toBeNull();
		expect(
			normalizeSearchShortcuts({ search: "Mod+K", filter: "Mod+F", extra: "Mod+X" }),
		).toBeNull();
		expect(normalizeSearchShortcuts({ search: "Mod+K", filter: "Mod+K" })).toBeNull();
	});

	it("fills defaults for an account that never set any", () => {
		expect(resolveSearchShortcuts(null)).toEqual(DEFAULT_SEARCH_SHORTCUTS);
		expect(resolveSearchShortcuts({ search: "Alt+S" })).toEqual({
			search: "Alt+S",
			filter: "Mod+F",
		});
	});

	it("falls back rather than disabling a broken stored chord", () => {
		expect(resolveSearchShortcuts({ search: "Banana", filter: "Mod+F" })).toEqual(
			DEFAULT_SEARCH_SHORTCUTS,
		);
	});
});
