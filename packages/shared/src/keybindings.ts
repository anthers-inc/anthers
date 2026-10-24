// SPDX-License-Identifier: Apache-2.0
/**
 * The shortcut grammar for the keys a person can rebind: the page's own shortcuts — the
 * search bar's two and the sidebar's toggle — and a player's full-screen and theater keys.
 *
 * A chord is stored as a portable string — `Mod+K`, `F` — rather than as a
 * platform-specific one, because `Mod` is Command on Apple platforms and Control
 * everywhere else. The defaults therefore read as `⌘K` on a Mac and `Ctrl+K` elsewhere
 * from one stored value. ⚠️ **`sidebar` is the one default that names `Ctrl` instead**,
 * because Control is the key asked for on every platform; a Mac keeps Control there, and
 * rebinding it to `Mod+/` is what moves it to Command.
 *
 * ⚠️ **Two scopes, two rules.** `search`, `filter` and `sidebar` are listened for on the
 * document, so they must carry a modifier or they would eat typing: at least one real
 * modifier, and `Shift` alone is not one. `fullscreen` and `theater` are listened for by a
 * player that already has focus, which is what makes a bare `f` or `t` correct there — and
 * the grammar refuses a bare key for a page action while accepting one for a player action.
 *
 * 🚨 **The server validates with this module, not only the settings card.** A chord is a
 * value a person can type into a request; a client-side check is a convenience. The rules
 * here are the ones the route enforces: each scope's modifier rule, `Mod` and `Ctrl` are
 * never combined because they name the same physical key off Apple, and no two actions
 * may share a chord.
 */

/** Actions listened for on the whole page: they must never fire while somebody is typing. */
export const PAGE_SHORTCUT_ACTIONS = ["search", "filter", "sidebar"] as const;
export type PageShortcutAction = (typeof PAGE_SHORTCUT_ACTIONS)[number];

/** Actions listened for by a focused player: a bare letter is the natural binding here. */
export const PLAYER_SHORTCUT_ACTIONS = ["fullscreen", "theater"] as const;
export type PlayerShortcutAction = (typeof PLAYER_SHORTCUT_ACTIONS)[number];

export const KEYBOARD_SHORTCUT_ACTIONS = [
	...PAGE_SHORTCUT_ACTIONS,
	...PLAYER_SHORTCUT_ACTIONS,
] as const;
export type KeyboardShortcutAction = (typeof KEYBOARD_SHORTCUT_ACTIONS)[number];

/** The stored map. A missing action falls back to its default; the server stores every action. */
export type KeyboardShortcuts = Record<KeyboardShortcutAction, string>;

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcuts = {
	search: "Mod+K",
	filter: "Mod+F",
	sidebar: "Ctrl+/",
	fullscreen: "F",
	theater: "T",
};

/** Whether an action is the player's rather than the page's. */
export function isPlayerShortcutAction(action: string): action is PlayerShortcutAction {
	return (PLAYER_SHORTCUT_ACTIONS as readonly string[]).includes(action);
}

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

/**
 * Parse a stored chord, or null when it is not one this application understands.
 *
 * `bare` permits a key with no modifier, which is only correct for a player action — see
 * the module docblock. The check is a parameter rather than the caller's job so a page
 * action cannot be validated with the player's rule by accident.
 */
export function parseChord(chord: string, options: { bare?: boolean } = {}): ParsedChord | null {
	const bare = options.bare ?? false;
	const parts = chord
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const rawKey = parts.pop();
	if (!rawKey) return null;
	const key = canonicalKey(rawKey);
	if (!key) return null;
	if (parts.length === 0 && !bare) return null;

	const seen = new Set<string>();
	for (const part of parts) {
		const modifier = part.toLowerCase();
		if (!(MODIFIERS as readonly string[]).includes(modifier) || seen.has(modifier)) return null;
		seen.add(modifier);
	}
	// Shift alone is a capital letter, not a shortcut; and Mod and Ctrl are the same
	// physical key off Apple, so a chord naming both cannot be expressed there.
	if (!bare && !seen.has("mod") && !seen.has("ctrl") && !seen.has("alt")) return null;
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

/** Canonicalize a chord, or null when it is invalid for that scope. */
export function canonicalChord(chord: string, options: { bare?: boolean } = {}): string | null {
	const parsed = parseChord(chord, options);
	return parsed ? chordToString(parsed) : null;
}

/**
 * How a chord reads on the screen. Apple uses its symbols and no separators; everywhere
 * else uses the familiar `Ctrl+…` spelling. An unparseable chord is shown as stored, so a
 * corrupt preference is visible rather than silently renamed.
 */
export function formatChord(chord: string, apple: boolean): string {
	const parsed = parseChord(chord, { bare: true });
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
	const parsed = parseChord(chord, { bare: true });
	if (!parsed || event.repeat) return false;
	const wantMeta = apple && parsed.mod;
	const wantCtrl = apple ? parsed.ctrl : parsed.mod || parsed.ctrl;
	if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false;
	if (event.altKey !== parsed.alt || event.shiftKey !== parsed.shift) return false;
	return keyFromEvent(event) === parsed.key;
}

/**
 * Whether two stored chords answer the same physical combination on any platform.
 *
 * ⚠️ **This is stricter than string equality, and it has to be.** On Apple `Mod` and `Ctrl`
 * are Command and Control, two different keys; everywhere else both mean Control. So
 * `Mod+K` and `Ctrl+K` are distinct chords on a Mac and *one chord* on Windows and Linux —
 * and because a shortcut map follows the account across devices, a map that is unambiguous
 * on the machine it was written on can answer two actions at once on the next one. Two
 * actions may not share a combination on any platform the account may sign in from.
 *
 * An unparseable chord takes part in no collision; it is refused or defaulted elsewhere.
 */
export function chordsCollide(a: string, b: string): boolean {
	const left = parseChord(a, { bare: true });
	const right = parseChord(b, { bare: true });
	if (!left || !right) return false;
	if (left.key !== right.key || left.alt !== right.alt || left.shift !== right.shift) return false;
	const sameOnApple = left.mod === right.mod && left.ctrl === right.ctrl;
	const sameElsewhere = (left.mod || left.ctrl) === (right.mod || right.ctrl);
	return sameOnApple || sameElsewhere;
}

/**
 * Validate and canonicalize a whole stored map.
 *
 * Returns null rather than a repaired map when anything is wrong: a settings write that
 * half-saves is worse than one that says no, and the client always sends every action.
 */
export function normalizeKeyboardShortcuts(raw: Record<string, string>): KeyboardShortcuts | null {
	const keys = Object.keys(raw);
	if (keys.length !== KEYBOARD_SHORTCUT_ACTIONS.length) return null;
	for (const key of keys) {
		if (!(KEYBOARD_SHORTCUT_ACTIONS as readonly string[]).includes(key)) return null;
	}
	const out = {} as KeyboardShortcuts;
	for (const action of KEYBOARD_SHORTCUT_ACTIONS) {
		const chord = raw[action];
		if (typeof chord !== "string") return null;
		const canonical = canonicalChord(chord, { bare: isPlayerShortcutAction(action) });
		if (!canonical) return null;
		out[action] = canonical;
	}
	for (let i = 0; i < KEYBOARD_SHORTCUT_ACTIONS.length; i++) {
		for (let j = i + 1; j < KEYBOARD_SHORTCUT_ACTIONS.length; j++) {
			const left = out[KEYBOARD_SHORTCUT_ACTIONS[i]];
			const right = out[KEYBOARD_SHORTCUT_ACTIONS[j]];
			if (chordsCollide(left, right)) return null;
		}
	}
	return out;
}

/**
 * The map the browser uses, with defaults filling anything a stored map does not carry.
 *
 * An account that has never opened the setting has `null`; an older row may carry only the
 * search pair. Neither should break the bar or the player, and an invalid stored chord
 * falls back to its default rather than disabling the shortcut. A duplicate pair — which
 * the server refuses but a legacy row may carry — falls back to the whole default map,
 * because two actions answering one key is a conflict the client cannot resolve for the
 * person.
 */
export function resolveKeyboardShortcuts(
	stored: Record<string, string> | null | undefined,
): KeyboardShortcuts {
	const out = { ...DEFAULT_KEYBOARD_SHORTCUTS };
	if (!stored) return out;
	for (const action of KEYBOARD_SHORTCUT_ACTIONS) {
		const chord = stored[action];
		const canonical =
			typeof chord === "string"
				? canonicalChord(chord, { bare: isPlayerShortcutAction(action) })
				: null;
		if (canonical) out[action] = canonical;
	}
	const chords = KEYBOARD_SHORTCUT_ACTIONS.map((action) => out[action]);
	for (let i = 0; i < chords.length; i++) {
		for (let j = i + 1; j < chords.length; j++) {
			if (chordsCollide(chords[i], chords[j])) return { ...DEFAULT_KEYBOARD_SHORTCUTS };
		}
	}
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
