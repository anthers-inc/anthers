// SPDX-License-Identifier: Apache-2.0
/**
 * The shortcut grammar for the search bar's two actions.
 *
 * A chord is stored as a portable string — `Mod+K`, `Mod+Shift+F` — rather than as a
 * platform-specific one, because `Mod` is Command on Apple platforms and Control
 * everywhere else. The defaults therefore read as `⌘K` on a Mac and `Ctrl+K` elsewhere
 * from one stored value.
 *
 * 🚨 **The server validates with this module, not only the settings card.** A chord is a
 * value a person can type into a request; a client-side check is a convenience. The rules
 * here are the ones the route enforces: at least one real modifier (`Shift` alone is not
 * one), `Mod` and `Ctrl` are never combined because they name the same physical key off
 * Apple, and the two actions cannot share a chord.
 */

export const SEARCH_SHORTCUT_ACTIONS = ["search", "filter"] as const;
export type SearchShortcutAction = (typeof SEARCH_SHORTCUT_ACTIONS)[number];

/** The stored map. A missing action falls back to its default; the server stores the pair. */
export type SearchShortcuts = Record<SearchShortcutAction, string>;

export const DEFAULT_SEARCH_SHORTCUTS: SearchShortcuts = {
	search: "Mod+K",
	filter: "Mod+F",
};

export interface ParsedChord {
	mod: boolean;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
	/** Canonical key: an uppercase letter or digit, or a named key in title case. */
	key: string;
}

const MODIFIERS = ["mod", "ctrl", "alt", "shift"] as const;
const NAMED_KEY_LABELS: Record<string, string> = {
	enter: "Enter",
	escape: "Escape",
	tab: "Tab",
	space: "Space",
	backspace: "Backspace",
	delete: "Delete",
	arrowup: "ArrowUp",
	arrowdown: "ArrowDown",
	arrowleft: "ArrowLeft",
	arrowright: "ArrowRight",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
};
const PUNCTUATION_KEYS = new Set(["/", "?", "[", "]", ";", "'", ",", ".", "-", "=", "`"]);

/** A single printable character that is not the chord separator, or a named key. */
function canonicalKey(raw: string): string | null {
	const key = raw.trim();
	if (key.length === 1) {
		if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
		if (PUNCTUATION_KEYS.has(key)) return key;
		return null;
	}
	const named = key.toLowerCase();
	return NAMED_KEY_LABELS[named] ?? null;
}

/** Parse a stored chord, or null when it is not one this application understands. */
export function parseChord(chord: string): ParsedChord | null {
	const parts = chord
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length < 2) return null;
	const rawKey = parts.pop();
	if (!rawKey) return null;
	const key = canonicalKey(rawKey);
	if (!key) return null;

	const seen = new Set<string>();
	for (const part of parts) {
		const modifier = part.toLowerCase();
		if (!(MODIFIERS as readonly string[]).includes(modifier) || seen.has(modifier)) return null;
		seen.add(modifier);
	}
	// Shift alone is a capital letter, not a shortcut; and Mod and Ctrl are the same
	// physical key off Apple, so a chord naming both cannot be expressed there.
	if (!seen.has("mod") && !seen.has("ctrl") && !seen.has("alt")) return null;
	if (seen.has("mod") && seen.has("ctrl")) return null;
	return {
		mod: seen.has("mod"),
		ctrl: seen.has("ctrl"),
		alt: seen.has("alt"),
		shift: seen.has("shift"),
		key,
	};
}

/** Put a parsed chord back into its canonical modifier order. */
export function chordToString(parsed: ParsedChord): string {
	const parts: string[] = [];
	if (parsed.mod) parts.push("Mod");
	if (parsed.ctrl) parts.push("Ctrl");
	if (parsed.alt) parts.push("Alt");
	if (parsed.shift) parts.push("Shift");
	parts.push(parsed.key);
	return parts.join("+");
}

/** Canonicalize a chord, or null when it is invalid. */
export function canonicalChord(chord: string): string | null {
	const parsed = parseChord(chord);
	return parsed ? chordToString(parsed) : null;
}

/**
 * How a chord reads on the screen. Apple uses its symbols and no separators; everywhere
 * else uses the familiar `Ctrl+…` spelling. An unparseable chord is shown as stored, so a
 * corrupt preference is visible rather than silently renamed.
 */
export function formatChord(chord: string, apple: boolean): string {
	const parsed = parseChord(chord);
	if (!parsed) return chord;
	const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
	if (apple) {
		return `${parsed.mod ? "⌘" : ""}${parsed.ctrl ? "⌃" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${key}`;
	}
	const modifiers: string[] = [];
	if (parsed.mod || parsed.ctrl) modifiers.push("Ctrl");
	if (parsed.alt) modifiers.push("Alt");
	if (parsed.shift) modifiers.push("Shift");
	return [...modifiers, key].join("+");
}

/** The part of a keyboard event this module reads, without requiring a DOM lib. */
export interface ChordEvent {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	repeat: boolean;
}

/** The canonical key name for a keyboard event, matching `parseChord`'s vocabulary. */
export function keyFromEvent(event: Pick<ChordEvent, "key">): string | null {
	const key = event.key;
	if (key === " ") return "Space";
	if (key.length === 1) {
		if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase();
		if (PUNCTUATION_KEYS.has(key)) return key;
		return null;
	}
	const named = key.toLowerCase();
	return NAMED_KEY_LABELS[named] ?? null;
}

/**
 * Whether a keyboard event is this chord on this platform.
 *
 * Every modifier must match exactly: a chord without Shift does not fire while Shift is
 * held, because that is a different combination the reader may have bound elsewhere.
 * Auto-repeat is ignored — holding a key down should not reopen the panel repeatedly.
 */
export function matchesChord(event: ChordEvent, chord: string, apple: boolean): boolean {
	const parsed = parseChord(chord);
	if (!parsed || event.repeat) return false;
	const wantMeta = apple && parsed.mod;
	const wantCtrl = apple ? parsed.ctrl : parsed.mod || parsed.ctrl;
	if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
	if (event.altKey !== parsed.alt || event.shiftKey !== parsed.shift) return false;
	return keyFromEvent(event) === parsed.key;
}

/**
 * Validate and canonicalize a whole stored map.
 *
 * Returns null rather than a repaired map when anything is wrong: a settings write that
 * half-saves is worse than one that says no, and the client always sends the pair.
 */
export function normalizeSearchShortcuts(raw: Record<string, string>): SearchShortcuts | null {
	const keys = Object.keys(raw);
	if (keys.length !== SEARCH_SHORTCUT_ACTIONS.length) return null;
	for (const key of keys) {
		if (!(SEARCH_SHORTCUT_ACTIONS as readonly string[]).includes(key)) return null;
	}
	const out = {} as SearchShortcuts;
	const seen = new Set<string>();
	for (const action of SEARCH_SHORTCUT_ACTIONS) {
		const chord = raw[action];
		if (typeof chord !== "string") return null;
		const canonical = canonicalChord(chord);
		if (!canonical || seen.has(canonical)) return null;
		seen.add(canonical);
		out[action] = canonical;
	}
	return out;
}

/**
 * The map the browser uses, with defaults filling anything a stored map does not carry.
 *
 * An account that has never opened the setting has `null`; an older row may carry only one
 * action. Neither should break the bar, and an invalid stored chord falls back to its
 * default rather than disabling the shortcut.
 */
export function resolveSearchShortcuts(
	stored: Record<string, string> | null | undefined,
): SearchShortcuts {
	const out = { ...DEFAULT_SEARCH_SHORTCUTS };
	if (!stored) return out;
	for (const action of SEARCH_SHORTCUT_ACTIONS) {
		const chord = stored[action];
		const canonical = typeof chord === "string" ? canonicalChord(chord) : null;
		if (canonical) out[action] = canonical;
	}
	if (out.search === out.filter) out.filter = DEFAULT_SEARCH_SHORTCUTS.filter;
	if (out.search === out.filter) out.search = DEFAULT_SEARCH_SHORTCUTS.search;
	return out;
}

/**
 * Chords a browser or operating system is likely to keep for itself. Allowed, because a
 * person may know something we do not, but the settings card warns instead of pretending
 * the override always wins.
 */
export const BROWSER_RESERVED_CHORDS = new Set([
	"Mod+W",
	"Mod+T",
	"Mod+N",
	"Mod+Shift+N",
	"Mod+Shift+T",
	"Mod+L",
	"Mod+R",
	"Mod+Shift+R",
	"Mod+Q",
	"Mod+Tab",
	"Mod+Space",
	"Ctrl+Tab",
	"Alt+Tab",
]);
