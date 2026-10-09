// SPDX-License-Identifier: Apache-2.0
/**
 * The Catalog's derived badge.
 *
 * ⚠️ What this file does NOT prove: that `accessState`'s notion of freeness matches the
 * server's. It cannot — `resolveAccessSync` lives in `apps/api`, which does not depend on
 * this package. That contract is pinned from the other side, in
 * `apps/api/src/__tests__/catalog-badge-contract.test.ts`, against the real resolver.
 * These tests cover the branches the badge adds on top of it: release, delivery, and the
 * locked state.
 */
import { describe, expect, it } from "bun:test";
import { accessState } from "./work-state";

const row = (threshold: number, allow: boolean, price = "0") => ({ threshold, allow, price });

describe("accessState", () => {
	it("is private until released, whatever the access table says", () => {
		expect(accessState({ visibility: "private", access: [row(0, true)] })).toBe("private");
		// Including the case that would otherwise be the loudest — a Work with no way in
		// is not something to warn about while it is still staging.
		expect(accessState({ visibility: "private", access: [row(0, false)] })).toBe("private");
	});

	it("names the locked state a released Work falls into by default", () => {
		// `defaultSeedAccess()` on the server is exactly this row, so a creator who releases
		// without opening the Access section lands here.
		expect(
			accessState({ visibility: "released", access: [row(0, false)], streamEnabled: true }),
		).toBe("locked");
		expect(accessState({ visibility: "released", access: [], streamEnabled: true })).toBe("locked");
		expect(accessState({ visibility: "released", access: null, streamEnabled: true })).toBe(
			"locked",
		);
	});

	it("is Public Access only when it also streams", () => {
		expect(
			accessState({ visibility: "released", access: [row(0, true)], streamEnabled: true }),
		).toBe("public-access");
		// Free, and genuinely not the commons: Public Access is ungated *streaming*, and a
		// download earns nothing from the Time Pool.
		expect(
			accessState({ visibility: "released", access: [row(0, true)], streamEnabled: false }),
		).toBe("free");
	});

	it("distinguishes a priced baseline from a gate", () => {
		expect(
			accessState({
				visibility: "released",
				access: [row(0, true, "5.00")],
				streamEnabled: true,
			}),
		).toBe("sale");
		expect(
			accessState({
				visibility: "released",
				access: [row(0, false), row(2, true)],
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
				access: [row(0, false), row(1, true, "0")],
				streamEnabled: true,
			}),
		).toBe("gated");
	});

	it("reads a goods Work's open baseline as a sale, free or priced, streamed or not", () => {
		// The shirts the store launched with: baseline open at $0 — which for a shirt is
		// "the public may see the page", never "this shirt costs nothing" (the goods-works
		// rule: the store's own prices are the price). The categorization error the rule
		// retired is a shirt wearing "Free download".
		expect(
			accessState({
				visibility: "released",
				access: [row(0, true), row(3, false)],
				streamEnabled: false,
				type: "physical",
			}),
		).toBe("sale");
		expect(
			accessState({
				visibility: "released",
				access: [row(0, true)],
				streamEnabled: false,
				type: "service",
			}),
		).toBe("sale");
		// Badge rows above a goods baseline still read as a gate.
		expect(
			accessState({
				visibility: "released",
				access: [row(0, false), row(3, true)],
				streamEnabled: false,
				type: "physical",
			}),
		).toBe("gated");
	});
});
