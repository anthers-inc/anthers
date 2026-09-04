// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterAll, describe, expect, it } from "bun:test";
import app from "../index";
import { isReservedUsername } from "../reserved-usernames";
import { purgeAccountsCreatedHere, purgeFixtureAccounts } from "./cleanup";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;

// csrfProtection turns away any mutation without an allowed Origin before the
// route ever runs, so sign-up is only reachable from one — as it is from a real
// browser.
const ORIGIN = "http://localhost:3000";

/** Every account this suite mints, so `afterAll` can take them all back. */
const created: string[] = [];

function signUp(username: string) {
	created.push(username);
	return testFetch(
		new Request("http://localhost/api/auth/sign-up", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({
				acceptTerms: true,
				username,
				email: `${crypto.randomUUID().slice(0, 8)}@example.com`,
				password: "securepass123",
			}),
		}),
	);
}

// In `afterAll` rather than a closing `it`, so a suite that bails early still cleans up.
afterAll(async () => {
	await purgeFixtureAccounts(created);
});

describe("isReservedUsername", () => {
	it("reserves names the infrastructure answers to, or that invite impersonation", () => {
		expect(isReservedUsername("api")).toBe(true);
		expect(isReservedUsername("health")).toBe(true);
		expect(isReservedUsername("admin")).toBe(true);
		expect(isReservedUsername("official")).toBe(true);
	});

	it("🚨 leaves every root route claimable, because a handle cannot collide with a page", () => {
		// The whole payoff of `/@name`. These were all reserved until 2026-09-03 for one
		// reason — the router answered at `/about` before it answered at `/:username` — and
		// that reason is gone. If this fails, a route blacklist has grown back.
		for (const name of ["about", "faq", "wiki", "login", "settings", "subscribe", "roadmap"]) {
			expect(isReservedUsername(name)).toBe(false);
		}
	});

	it("leaves locale tags claimable too, for the same reason", () => {
		// A path-prefixed localization scheme would claim `/es/…`, which no longer competes
		// with `/@es`. Held back until the prefix landed; ordinary names now.
		for (const tag of ["es", "pt-BR", "zh-Hans"]) {
			expect(isReservedUsername(tag)).toBe(false);
		}
	});

	it("matches case-insensitively, because React Router does", () => {
		// `/@Admin` reaches the same profile as `/@admin`, so reserving one reserves both.
		expect(isReservedUsername("Admin")).toBe(true);
		expect(isReservedUsername("ADMIN")).toBe(true);
	});

	it("ignores surrounding whitespace", () => {
		expect(isReservedUsername("  admin  ")).toBe(true);
	});

	it("leaves ordinary names alone", () => {
		// Including near-misses: substrings and superstrings of a reserved name must not be
		// swept up with it.
		for (const name of ["parker", "adm", "adminning", "admin-me", "api2"]) {
			expect(isReservedUsername(name)).toBe(false);
		}
	});
});

describe("the official-account prefix", () => {
	/**
	 * 🚨 `anthers-{person}` marks an account as the organization speaking rather than a
	 * person who helps out. A signal anybody can mint is worse than no signal, because it
	 * borrows the credibility of the real ones — so the names that imitate the convention
	 * are held, one separator at a time rather than as a set.
	 */
	it("holds every name that imitates an official handle", () => {
		expect(isReservedUsername("anthers-support")).toBe(true);
		expect(isReservedUsername("anthers-security")).toBe(true);
		expect(isReservedUsername("anthers-billing")).toBe(true);
		// The underscore reads exactly as official as the hyphen, and the username
		// charset allows both — so holding only one would be holding neither.
		expect(isReservedUsername("anthers_support")).toBe(true);
		// Case-insensitively, like every other rule here.
		expect(isReservedUsername("Anthers-Support")).toBe(true);
		expect(isReservedUsername("  anthers-help  ")).toBe(true);
	});

	it("still lets an issued handle through, or the prefix would block its own accounts", () => {
		// The list is checked before the prefix rule for exactly this reason. If this
		// ever fails, the person it names cannot re-create their own account.
		expect(isReservedUsername("anthers-parker")).toBe(false);
		expect(isReservedUsername("ANTHERS-PARKER")).toBe(false);
	});

	it("leaves a community name alone, which is the deliberate limit of the rule", () => {
		// The run-on form is NOT held. Blocking every name beginning with the word would
		// cost real people real handles to close a gap that does not match the shape it
		// is imitating — see the note on STAFF_PREFIXES. `antherssupport` is the known
		// residue, asserted here so widening the rule is a deliberate edit to a test
		// rather than a silent change of mind.
		expect(isReservedUsername("anthersfan")).toBe(false);
		expect(isReservedUsername("anthersenjoyer")).toBe(false);
		expect(isReservedUsername("antherssupport")).toBe(false);
	});
});

describe("POST /api/auth/sign-up — reserved usernames", () => {
	it("rejects a name that invites impersonation, with a readable message", async () => {
		const res = await signUp("admin");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "That username is reserved" });
	});

	it("rejects a reserved name regardless of case", async () => {
		expect((await signUp("Admin")).status).toBe(400);
	});

	it("🚨 accepts a name that is also a page, which the route prefix is what makes safe", async () => {
		// End to end rather than only against `isReservedUsername`: this is the behavior the
		// whole change exists to produce, and a schema-level `refine` could refuse it while
		// the helper says otherwise.
		expect((await signUp("about")).status).toBe(201);
	});

	it("still accepts an ordinary username", async () => {
		const res = await signUp(`reserved_test_${crypto.randomUUID().slice(0, 8)}`);
		expect(res.status).toBe(201);
	});
});
