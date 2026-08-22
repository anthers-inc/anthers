// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `?next=` — where to send someone once an interruption is over.
 *
 * A person who hits a gated post while logged out is trying to *do* something. The auth
 * detour is an interruption, and losing the thing they wanted at the end of it is the
 * failure this exists to prevent. `/login` has read a `?next=` for a long time; the
 * signup path lost its equivalent on 2026-08-17 when the Create Account card — which
 * honoured `location.state.from` — was deleted, so the destination now travels as a
 * query parameter through `/subscribe` → `/welcome` instead.
 *
 * 🚨 **A redirect target that arrives from the URL is attacker-controlled, and that is
 * the whole reason this module exists rather than a `searchParams.get("next")` at each
 * call site.** `sanitizeNextPath` is the one gate, so there is one thing to get right and
 * one thing to test. What it enforces:
 *
 *   • It must be an **absolute path on this origin** — one leading `/`, and not `//`.
 *     `//evil.example` is protocol-relative: browsers read it as another *host*, and it
 *     is the classic open-redirect payload precisely because it looks like a path.
 *   • **No scheme**, so `https://evil.example` and `javascript:alert(1)` are refused.
 *     React Router's `navigate()` would treat both as relative paths rather than
 *     actually leaving the site, but that is a property of today's router, not a
 *     decision — and `window.location.assign` is one refactor away.
 *   • **No backslashes**, which several browsers normalise to `/` — so `/\evil.example`
 *     reaches the same place `//evil.example` does while passing a naive `//` check.
 *   • **No control characters**, including the ones a `\n` in an encoded parameter can
 *     smuggle in.
 *
 * Anything that fails returns `null`, which every caller reads as *"no destination"* and
 * falls back to its own default. Refusing is always safe here; the cost of a bad refusal
 * is one extra click, and the cost of a bad acceptance is sending a person who just typed
 * a password somewhere we did not choose.
 *
 * ⚠️ **It lives in `@anthers/shared` rather than in the web package because the API reads
 * a `next` too** (2026-08-22). Signing in with Bluesky leaves the site and comes back
 * through `/api/atproto/callback`, so the destination has to survive a round trip through
 * an authorization server — it rides in the OAuth flow's server-side `appState` and is
 * spliced into the redirect the API issues. A second copy of these rules in the API would
 * be a second thing to get right, which is the shape of defect this project has already
 * paid for once in a duplicated session-cookie helper.
 */

/**
 * Any C0 control character, or DEL — rejected wherever they appear.
 *
 * A loop rather than a regex on purpose. `/[\u0000-\u001f\u007f]/` is the obvious spelling and
 * Biome rejects it (`noControlCharactersInRegex`), correctly: a control character inside
 * a character class is nearly always a typo rather than an intention, and the rule cannot
 * tell the two apart. Suppressing it would trade a real check for a comment; comparing
 * char codes says the same thing and reads better anyway.
 */
function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

/**
 * Narrow a caller-supplied `next` to a safe in-app destination, or `null`.
 *
 * Accepts the value straight off `URLSearchParams.get()` — already percent-decoded, which
 * matters: the checks below have to run on what the browser will actually navigate to,
 * not on its encoded spelling.
 */
export function sanitizeNextPath(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const value = raw.trim();
	if (!value) return null;

	// One leading slash, and exactly one. `//host` and `/\host` are both off-origin.
	if (!value.startsWith("/")) return null;
	if (value.startsWith("//")) return null;
	if (value.includes("\\")) return null;
	if (hasControlChar(value)) return null;

	// A scheme cannot appear in a path that starts with `/`, but a colon before the first
	// `/` in some future caller's input can — refuse the shape rather than the spelling.
	if (/^\/[^/]*:/.test(value)) return null;

	return value;
}

/**
 * Append a `next` to a path, when there is one worth carrying.
 *
 * Sanitizes on the way *out* as well as on the way in. The destination is composed from
 * app state at every current call site, so this is belt-and-braces — but a link built
 * from a value that turns out to be user-controlled is exactly how an open redirect gets
 * introduced later, and the check costs nothing.
 */
export function withNextPath(path: string, next: string | null | undefined): string {
	const safe = sanitizeNextPath(next);
	return safe ? `${path}?next=${encodeURIComponent(safe)}` : path;
}
