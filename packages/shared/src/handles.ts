// SPDX-License-Identifier: Apache-2.0
/**
 * What a handle Anthers issues may be called — the half of the rules both sides know.
 *
 * 🚨 **Shared because the browser has to answer some of this without asking.** Signing up
 * begins by typing a name, and a name with an underscore in it is wrong in a way that needs no
 * server: round-tripping it costs a debounce plus latency to say something knowable
 * immediately, and reads as *"we couldn't check"* rather than *"that is not allowed"* whenever
 * the API is unreachable. So syntax lives here and runs in both places.
 *
 * ⚠️ **Only syntax. Which names are RESERVED stays on the server**, and that split is
 * deliberate rather than an accident of what was easy to move. Reserved names are a policy
 * list of about a thousand words — the node's own, plus Anthers' — and a policy belongs with
 * the party that enforces it, which is the node. Shipping it to every visitor would put a
 * kilobyte of vocabulary in a marketing bundle to answer a question the server answers anyway.
 *
 * ⭐ **The node is the authority over all of it regardless.** Nothing here decides that a name
 * is available; it decides that a name is not worth asking about.
 */

/** The shortest name Anthers will issue. Two characters is a namespace worth squatting in. */
export const MIN_HANDLE_NAME = 3;

/**
 * The longest. A DNS label may be 63 characters and a handle 253, so this is Anthers' limit
 * rather than the protocol's — a name has to be sayable, and nobody is served by a 63-
 * character one.
 */
export const MAX_HANDLE_NAME = 30;

/**
 * Turn whatever somebody typed into the name part of a handle.
 *
 * People write handles several ways and none of them are wrong: with a leading `@`, with the
 * suffix already on the end, in the case they think in. Stripping all of that on the way in
 * means the field never fights anybody, which is the same argument the Bluesky door's handle
 * input makes about its own leading `@`.
 *
 * The suffix is passed in rather than read from the environment, because this runs in a
 * browser that learns it from the API and on a server that derives it from the node's URL.
 */
export function normalizeHandleName(raw: string, suffix: string): string {
	let value = raw.trim().toLowerCase().replace(/^@/, "");
	const dotted = `.${suffix}`;
	if (dotted.length > 1 && value.endsWith(dotted)) {
		value = value.slice(0, -dotted.length);
	}
	return value;
}

/**
 * Why this name could not be a handle at all, or null when nothing about its spelling refuses
 * it. **A null answer is not availability** — see the module note.
 *
 * Answers sentences rather than codes because every one of them is shown to whoever typed the
 * name, and there is nothing here a caller needs to branch on.
 */
export function handleSyntaxProblem(name: string): string | null {
	if (name.length < MIN_HANDLE_NAME) {
		return `A handle needs at least ${MIN_HANDLE_NAME} characters.`;
	}
	if (name.length > MAX_HANDLE_NAME) {
		return `A handle can be at most ${MAX_HANDLE_NAME} characters.`;
	}
	// A handle is a domain name, so the alphabet is a DNS label's rather than a username's.
	// ⚠️ The underscore is the one people are surprised by, because Anthers usernames allow
	// them — so the message names the character instead of restating the rule. Kept short as
	// well as specific: it sits in a fixed two-line region under the field, and a third line
	// would grow the panel.
	if (name.includes("_")) {
		return "A handle is a web address, so no underscores. Use a hyphen.";
	}
	if (!/^[a-z0-9-]+$/.test(name)) {
		return "A handle can only contain letters, numbers and hyphens.";
	}
	if (name.startsWith("-") || name.endsWith("-")) {
		return "A handle can't start or end with a hyphen.";
	}
	return null;
}
