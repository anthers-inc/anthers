// SPDX-License-Identifier: Apache-2.0
/**
 * The reduced-motion read, tested through the matcher it depends on rather than through a
 * browser.
 *
 * ⭐ **The interesting case is the absent API, not the matching query.** A host without
 * `matchMedia` must answer `false` (animate normally) rather than throw, because the whole
 * client renders through these primitives and a missing browser feature must not take the
 * page down. Injecting the matcher is what lets both branches be proven without a DOM.
 */

import { describe, expect, it } from "bun:test";
import { prefersReducedMotion, REDUCED_MOTION_QUERY, readReducedMotion } from "./motion";

const matcher = (matches: boolean) => (query: string) =>
	({
		matches: query === REDUCED_MOTION_QUERY ? matches : false,
	}) as MediaQueryList;

describe("readReducedMotion", () => {
	it("follows the media query", () => {
		expect(readReducedMotion(matcher(true))).toBe(true);
		expect(readReducedMotion(matcher(false))).toBe(false);
	});

	it("answers false when the host has no matcher", () => {
		expect(readReducedMotion(undefined)).toBe(false);
	});
});

describe("prefersReducedMotion", () => {
	it("answers false when there is no window", () => {
		// This suite runs without a DOM, which is exactly the host shape the guard exists
		// for: an absent window must not be read as a request for less motion.
		expect(prefersReducedMotion()).toBe(false);
	});
});
