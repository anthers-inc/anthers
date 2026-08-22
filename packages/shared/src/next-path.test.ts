// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `sanitizeNextPath` is the only thing standing between a URL parameter and a redirect,
 * so it is tested the way an access rule is: the refusals matter more than the passes.
 *
 * ⚠️ The hazard is *not* hypothetical-looking. `?next=` travels the whole signup detour
 * now (`/subscribe` → `/welcome`), which means a link someone is sent — "sign up here to
 * read this" — carries the destination they land on at the end of it, right after typing
 * a code from their inbox. That is the moment an off-origin redirect is worth the most.
 */
import { describe, expect, test } from "bun:test";
import { sanitizeNextPath, withNextPath } from "./next-path";

describe("sanitizeNextPath keeps real in-app destinations", () => {
	test.each([
		"/posts/a-game-123",
		"/works/an-album-4",
		"/alice",
		"/discover?tag=game",
		"/posts/x#comments",
		"/",
	])("%s survives", (path) => {
		expect(sanitizeNextPath(path)).toBe(path);
	});

	test("it trims, because a URL parameter can arrive padded", () => {
		expect(sanitizeNextPath("  /posts/x  ")).toBe("/posts/x");
	});
});

describe("sanitizeNextPath refuses anything that could leave the origin", () => {
	test.each([
		// The classic open-redirect payload: protocol-relative, and it looks like a path.
		["//evil.example", "protocol-relative"],
		["//evil.example/login", "protocol-relative with a path"],
		// Browsers normalise a backslash to `/`, so this reaches the same place as `//`
		// while passing a naive check for a doubled slash.
		["/\\evil.example", "backslash normalised to a slash"],
		["\\\\evil.example", "UNC-looking"],
		["https://evil.example", "absolute URL"],
		["http://evil.example", "absolute URL"],
		// React Router would treat this as a relative path rather than run it — but that
		// is a property of today's router, and `location.assign` is one refactor away.
		["javascript:alert(1)", "script scheme"],
		["data:text/html,<script>", "data scheme"],
		["mailto:a@b.example", "other scheme"],
		// Not absolute: a relative path resolves against wherever the user happens to be,
		// which is not a destination anyone chose.
		["posts/x", "relative"],
		["../admin", "traversal"],
		["", "empty"],
		["   ", "whitespace only"],
	])("%s is refused (%s)", (raw) => {
		expect(sanitizeNextPath(raw)).toBeNull();
	});

	test("a smuggled newline is refused", () => {
		expect(sanitizeNextPath("/posts/x\nSet-Cookie: a=b")).toBeNull();
	});

	test("null and undefined are simply absent", () => {
		expect(sanitizeNextPath(null)).toBeNull();
		expect(sanitizeNextPath(undefined)).toBeNull();
	});
});

describe("withNextPath", () => {
	test("carries a safe destination, encoded", () => {
		expect(withNextPath("/welcome", "/posts/a-b-1")).toBe("/welcome?next=%2Fposts%2Fa-b-1");
	});

	test("encodes a destination that carries its own query", () => {
		// The whole `next` is one parameter value; leaving its `?`/`&` bare would let the
		// destination's query merge into the carrier's.
		expect(withNextPath("/welcome", "/discover?tag=game&sort=new")).toBe(
			"/welcome?next=%2Fdiscover%3Ftag%3Dgame%26sort%3Dnew",
		);
	});

	test("drops an unsafe destination rather than passing it along", () => {
		expect(withNextPath("/welcome", "//evil.example")).toBe("/welcome");
		expect(withNextPath("/welcome", "https://evil.example")).toBe("/welcome");
	});

	test("returns the path untouched when there is nothing to carry", () => {
		expect(withNextPath("/welcome", null)).toBe("/welcome");
		expect(withNextPath("/welcome", "")).toBe("/welcome");
	});
});
