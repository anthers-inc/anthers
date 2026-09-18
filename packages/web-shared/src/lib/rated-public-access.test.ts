// SPDX-License-Identifier: Apache-2.0
/**
 * When the Studio tells a creator that a rated Work in Public Access is not seen by everyone.
 *
 * The rule is Parker's, 2026-09-18: only when a Mature or Adult Work is being released into
 * Public Access, and never as part of choosing the rating. So the cases that matter are the
 * ones where it must stay quiet as much as the ones where it speaks.
 */
import { describe, expect, it } from "bun:test";
import { showsRatedPublicAccessNotice } from "./rated-public-access";

const RELEASED_PA = { released: true, publicAccess: true };

describe("showsRatedPublicAccessNotice", () => {
	it("speaks for a Mature or Adult Work released into Public Access", () => {
		expect(showsRatedPublicAccessNotice({ ...RELEASED_PA, maturity: "mature" })).toBe(true);
		expect(showsRatedPublicAccessNotice({ ...RELEASED_PA, maturity: "adult" })).toBe(true);
	});

	it("stays quiet for General, which every reader meets", () => {
		expect(showsRatedPublicAccessNotice({ ...RELEASED_PA, maturity: "general" })).toBe(false);
	});

	it("stays quiet on a rating alone, when the Work is not in Public Access", () => {
		// Choosing a rating is never the trigger — see the module's header for why.
		expect(
			showsRatedPublicAccessNotice({ released: true, publicAccess: false, maturity: "adult" }),
		).toBe(false);
	});

	it("stays quiet until the Work is being released", () => {
		expect(
			showsRatedPublicAccessNotice({ released: false, publicAccess: true, maturity: "mature" }),
		).toBe(false);
	});

	it("stays quiet before a rating is chosen", () => {
		expect(showsRatedPublicAccessNotice({ ...RELEASED_PA, maturity: null })).toBe(false);
		expect(showsRatedPublicAccessNotice({ ...RELEASED_PA, maturity: "unrated" })).toBe(false);
	});

	it("speaks for a rung this build does not know, which will restrict at least as much", () => {
		expect(showsRatedPublicAccessNotice({ ...RELEASED_PA, maturity: "a-future-rung" })).toBe(true);
	});
});
