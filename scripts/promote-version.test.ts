// SPDX-License-Identifier: Apache-2.0
/**
 * `promote-version.ts` must produce the right next calver string — the deploy job
 * composes a git tag from it and the footer renders it, so a wrong bump ships a
 * tag nobody can find the release notes for.
 *
 * The bump rules under test:
 * - Same month: patch increments.
 * - Month rollover: month rolls, patch resets to 0.
 * - Year rollover: year rolls, patch resets to 0.
 * - A constant that lags real time (release in March after a January one) rolls
 *   forward rather than erroring, and never counts backward.
 *
 * `bumpPlan` is under test too: the target is computed from the *committed* constant,
 * because a resumed promote's working tree already carries the interrupted session's
 * bump, and computing from that instead of HEAD double-bumps on every resume.
 */
import { describe, expect, it } from "bun:test";
import { bumpPlan, nextVersion } from "./promote-version";

const inMonth = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe("nextVersion", () => {
	it("increments the patch within the same month", () => {
		expect(nextVersion("2026.10.0", inMonth("2026-10-05"))).toBe("2026.10.1");
		expect(nextVersion("2026.10.4", inMonth("2026-10-31"))).toBe("2026.10.5");
	});

	it("rolls the month and resets the patch on a new month", () => {
		expect(nextVersion("2026.10.3", inMonth("2026-11-01"))).toBe("2026.11.0");
	});

	it("rolls the year and resets the patch on a new year", () => {
		expect(nextVersion("2026.12.2", inMonth("2027-01-04"))).toBe("2027.1.0");
	});

	it("rolls forward when the constant lags real time", () => {
		// A January release promoted again in March must land on March.0, not error
		// and not count backward into February.
		expect(nextVersion("2026.1.5", inMonth("2026-03-15"))).toBe("2026.3.0");
	});

	it("refuses a constant that is not calver", () => {
		expect(() => nextVersion("1.0.0", inMonth("2026-10-05"))).toThrow();
		expect(() => nextVersion("v2026.10.0", inMonth("2026-10-05"))).toThrow();
		expect(() => nextVersion("2026.10", inMonth("2026-10-05"))).toThrow();
	});

	it("does not skip patch numbers on a same-month re-promote", () => {
		// A re-promote of the same month keeps counting rather than skipping, so a
		// pulled release never strands a number the release notes can never account for.
		expect(nextVersion("2026.10.2", inMonth("2026-10-05"))).toBe("2026.10.3");
	});
});

describe("bumpPlan", () => {
	it("writes the next patch from the committed constant on a clean tree", () => {
		expect(bumpPlan("2026.10.21", "2026.10.21")).toEqual({
			action: "write",
			target: "2026.10.22",
		});
	});

	it("is a no-op on a resumed promote, where the tree already carries the bump", () => {
		// The interrupted session's bump sits uncommitted in the tree; computing the
		// target from that constant instead of HEAD's is the double-bump this plan exists
		// to prevent. HEAD's committed constant is the only baseline a promote computes
		// from.
		expect(bumpPlan("2026.10.21", "2026.10.22")).toEqual({
			action: "no-op",
			target: "2026.10.22",
		});
	});

	it("refuses a tree whose constant matches neither HEAD nor the computed target", () => {
		// The shape a past double-bump left behind: committed .21, a stray .23 in the
		// tree, and a promote that computes .22. Nothing this flow wrote put .23 there,
		// so publishing it is refusing no one's plan; the script's failure names the
		// way out (restore, or pin deliberately).
		expect(bumpPlan("2026.10.21", "2026.10.23")).toEqual({
			action: "refuse",
			target: "2026.10.22",
			committed: "2026.10.21",
			working: "2026.10.23",
		});
	});

	it("lets a pin replace the computed target and write over a stray constant", () => {
		// --version is the deliberate override: the pinned number wins, and a tree
		// carrying a stray constant is rewritten to it rather than refused.
		expect(bumpPlan("2026.10.21", "2026.10.23", "2026.10.22")).toEqual({
			action: "write",
			target: "2026.10.22",
		});
	});

	it("computes the target from the committed constant even when it lags the tree", () => {
		// A month rollover is the same converging shape: the committed constant decides
		// nextVersion's output, and the interrupted session's bump in the tree matches
		// that target and is accepted, not re-bumped.
		expect(bumpPlan("2026.10.3", "2026.11.0", undefined, inMonth("2026-11-01"))).toEqual({
			action: "no-op",
			target: "2026.11.0",
		});
	});
});
