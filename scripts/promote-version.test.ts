// SPDX-License-Identifier: Apache-2.0
/**
 * `promote-version.ts` must produce the right next calver string — the deploy job
 * composes a git tag from it and the footer renders it, so a wrong bump ships a
 * tag nobody can find the changelist for.
 *
 * The bump rules under test:
 * - Same month: patch increments.
 * - Month rollover: month rolls, patch resets to 0.
 * - Year rollover: year rolls, patch resets to 0.
 * - A constant that lags real time (release in March after a January one) rolls
 *   forward rather than erroring, and never counts backward.
 */
import { describe, expect, it } from "bun:test";
import { nextVersion } from "./promote-version";

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
		// pulled release never strands a number a changelist can never account for.
		expect(nextVersion("2026.10.2", inMonth("2026-10-05"))).toBe("2026.10.3");
	});
});
