// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Catalog's derived badge, and the Created date's trip to the API and back.
 *
 * Both are here for the same reason: neither can be checked by looking at the screen.
 * A timezone slip renders a perfectly plausible date one day early, and a drifted access
 * rule renders a perfectly plausible badge — the "the failure mode is a plausible value
 * rather than an error" family that has cost this repo a follower count, a card fee and a
 * storage receipt.
 *
 * ⚠️ What this file does NOT prove: that `accessState`'s notion of freeness matches the
 * server's. It cannot — `resolveAccessSync` lives in `apps/api`, which does not depend on
 * this package. That contract is pinned from the other side, in
 * `apps/api/src/__tests__/catalog-badge-contract.test.ts`, against the real resolver.
 * These tests cover the branches the badge adds on top of it: release, delivery, and the
 * locked state.
 */
import { describe, expect, it } from "bun:test";
import { accessState, authoredToIso, isoToAuthoredValue } from "./work-state";

const row = (threshold: number, allow: boolean, price = "0") => ({ threshold, allow, price });

describe("accessState", () => {
	it("is private until released, whatever the access table says", () => {
		expect(accessState({ visibility: "private", seedAccess: [row(0, true)] })).toBe("private");
		// Including the case that would otherwise be the loudest — a Work with no way in
		// is not something to warn about while it is still staging.
		expect(accessState({ visibility: "private", seedAccess: [row(0, false)] })).toBe("private");
	});

	it("names the locked state a released Work falls into by default", () => {
		// `defaultSeedAccess()` on the server is exactly this row, so a creator who releases
		// without opening the Access section lands here.
		expect(
			accessState({ visibility: "released", seedAccess: [row(0, false)], streamEnabled: true }),
		).toBe("locked");
		expect(accessState({ visibility: "released", seedAccess: [], streamEnabled: true })).toBe(
			"locked",
		);
		expect(accessState({ visibility: "released", seedAccess: null, streamEnabled: true })).toBe(
			"locked",
		);
	});

	it("is Public Access only when it also streams", () => {
		expect(
			accessState({ visibility: "released", seedAccess: [row(0, true)], streamEnabled: true }),
		).toBe("public-access");
		// Free, and genuinely not the commons: Public Access is ungated *streaming*, and a
		// download earns nothing from the Time Pool.
		expect(
			accessState({ visibility: "released", seedAccess: [row(0, true)], streamEnabled: false }),
		).toBe("free");
	});

	it("distinguishes a priced baseline from a gate", () => {
		expect(
			accessState({
				visibility: "released",
				seedAccess: [row(0, true, "5.00")],
				streamEnabled: true,
			}),
		).toBe("sale");
		expect(
			accessState({
				visibility: "released",
				seedAccess: [row(0, false), row(2, true)],
				streamEnabled: true,
			}),
		).toBe("gated");
	});

	it("reads a free rung above a locked baseline as gated, not free", () => {
		// The rung is free to whoever clears it; the Work is not free to everyone. Calling
		// this 'public-access' would put gated work in the commons and pay it from the Time
		// Pool twice over.
		expect(
			accessState({
				visibility: "released",
				seedAccess: [row(0, false), row(1, true, "0")],
				streamEnabled: true,
			}),
		).toBe("gated");
	});
});

describe("the Created date round-trips at the precision the creator claimed", () => {
	it("widens each precision to the first instant of its period, in UTC", () => {
		expect(authoredToIso("year", "2015")).toBe("2015-01-01T00:00:00.000Z");
		expect(authoredToIso("month", "2015-06")).toBe("2015-06-01T00:00:00.000Z");
		expect(authoredToIso("day", "2015-06-14")).toBe("2015-06-14T00:00:00.000Z");
	});

	it("survives the trip back at its own precision", () => {
		for (const [precision, value] of [
			["year", "2015"],
			["month", "2015-06"],
			["day", "2015-06-14"],
		] as const) {
			const iso = authoredToIso(precision, value);
			expect(iso).not.toBeNull();
			expect(isoToAuthoredValue(iso, precision)).toBe(value);
		}
	});

	/**
	 * 🚨 The assertion this file exists for.
	 *
	 * `new Date("2015-01-01")` is UTC midnight but `new Date(2015, 0, 1)` is LOCAL midnight,
	 * and the read side formats with `timeZone: "UTC"`. Get it wrong and a work created in
	 * 2015 renders "2014" for everyone west of Greenwich — no error, no failing request,
	 * just a date that is quietly off by one for most of the Americas.
	 */
	it("does not drift when the machine is not on UTC", () => {
		const previously = process.env.TZ;
		try {
			for (const tz of ["America/Denver", "Pacific/Kiritimati", "Asia/Kolkata"]) {
				process.env.TZ = tz;
				expect(authoredToIso("year", "2015")).toBe("2015-01-01T00:00:00.000Z");
				expect(isoToAuthoredValue("2015-01-01T00:00:00.000Z", "year")).toBe("2015");
				expect(isoToAuthoredValue("2015-01-01T00:00:00.000Z", "day")).toBe("2015-01-01");
			}
		} finally {
			process.env.TZ = previously;
		}
	});

	it("narrowing a precision keeps what the wider one asserted", () => {
		// The editor re-cuts the value through the stored instant when the precision select
		// changes, so "June 2015" narrowed to a year must stay 2015 rather than blanking.
		const iso = authoredToIso("month", "2015-06");
		expect(isoToAuthoredValue(iso, "year")).toBe("2015");
	});

	it("treats a missing precision or an unparseable value as nothing asserted", () => {
		expect(authoredToIso(null, "2015")).toBeNull();
		expect(authoredToIso("year", "")).toBeNull();
		expect(authoredToIso("day", "not-a-date")).toBeNull();
		expect(isoToAuthoredValue(null, "year")).toBe("");
		expect(isoToAuthoredValue(undefined, "day")).toBe("");
	});
});
