// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import app from "../index";
import { isReservedUsername } from "../reserved-usernames";

const testFetch = app.fetch;

// csrfProtection turns away any mutation without an allowed Origin before the
// route ever runs, so sign-up is only reachable from one — as it is from a real
// browser.
const ORIGIN = "http://localhost:3000";

function signUp(username: string) {
	return testFetch(
		new Request("http://localhost/api/auth/sign-up", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				username,
				email: `${crypto.randomUUID().slice(0, 8)}@example.com`,
				password: "securepass123",
			}),
		}),
	);
}

describe("isReservedUsername", () => {
	it("reserves route names the router answers to first", () => {
		// Each of these is registered ahead of /:username in apps/web/src/App.tsx.
		for (const name of ["about", "faq", "wiki", "login", "settings", "subscribe"]) {
			expect(isReservedUsername(name)).toBe(true);
		}
	});

	it("reserves names the ingress peels off before the SPA", () => {
		expect(isReservedUsername("api")).toBe(true);
		expect(isReservedUsername("health")).toBe(true);
	});

	it("reserves locale tags a path-prefix scheme would claim", () => {
		expect(isReservedUsername("es")).toBe(true);
		expect(isReservedUsername("pt-BR")).toBe(true);
		expect(isReservedUsername("zh-Hans")).toBe(true);
	});

	it("matches case-insensitively, because React Router does", () => {
		// /About renders the About page just as /about does, so "About" would be
		// stranded at an unreachable URL exactly like "about".
		expect(isReservedUsername("About")).toBe(true);
		expect(isReservedUsername("ABOUT")).toBe(true);
		expect(isReservedUsername("pt-br")).toBe(true);
		expect(isReservedUsername("PT-BR")).toBe(true);
	});

	it("ignores surrounding whitespace", () => {
		expect(isReservedUsername("  about  ")).toBe(true);
	});

	it("leaves ordinary names alone", () => {
		// Including near-misses: substrings and superstrings of reserved names must
		// not be swept up, and three-letter words that are ISO 639-2 codes are
		// deliberately NOT reserved.
		for (const name of ["parker", "abou", "aboutme", "about-me", "art", "new", "sun", "api2"]) {
			expect(isReservedUsername(name)).toBe(false);
		}
	});
});

describe("drift guard against the web router", () => {
	// reserved-usernames.ts carries a "KEEP IN SYNC with App.tsx" comment, which is
	// only a hope. This makes it a check: add a root-level route without reserving
	// its name and this fails, rather than silently stranding whoever holds it.
	it("reserves every root-level path registered in apps/web/src/App.tsx", () => {
		const appTsx = readFileSync(`${import.meta.dir}/../../../web/src/App.tsx`, "utf8");

		const rootSegments = [...appTsx.matchAll(/path="\/([^"]*)"/g)]
			.map((match) => match[1].split("/")[0])
			// Drop the catch-alls and the bare "/" root — neither can be a username.
			.filter((segment) => segment !== "" && segment !== "*" && !segment.startsWith(":"));

		// Guard the guard: a parse that silently found nothing must not pass.
		expect(rootSegments.length).toBeGreaterThan(10);

		const unreserved = [...new Set(rootSegments)].filter((name) => !isReservedUsername(name));
		expect(unreserved).toEqual([]);
	});
});

describe("POST /api/auth/sign-up — reserved usernames", () => {
	it("rejects a reserved route name with a readable message", async () => {
		const res = await signUp("about");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "That username is reserved" });
	});

	it("rejects a reserved name regardless of case", async () => {
		expect((await signUp("About")).status).toBe(400);
	});

	it("rejects a reserved locale tag", async () => {
		expect((await signUp("pt-BR")).status).toBe(400);
	});

	it("still accepts an ordinary username", async () => {
		const res = await signUp(`reserved_test_${crypto.randomUUID().slice(0, 8)}`);
		expect(res.status).toBe(201);
	});
});
