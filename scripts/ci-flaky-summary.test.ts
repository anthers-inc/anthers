// SPDX-License-Identifier: Apache-2.0
/**
 * The flake summary's read of a Playwright JSON report: the walker finds flaky tests
 * nested in suites, the count agrees with the reporter's own `stats.flaky`, and a
 * disagreeing shape warns rather than being trusted. Broken on purpose before trusted:
 * remove a test's earlier attempt and the walker must find zero.
 */

import { describe, expect, it } from "bun:test";
import { type JsonReport, summarize } from "./ci-flaky-summary.ts";

interface Attempt {
	status: string;
}

function synthetic(
	specs: { title: string; attempts: Attempt[] }[],
	statsFlaky?: number,
): JsonReport {
	return {
		stats: statsFlaky === undefined ? undefined : { total: specs.length, flaky: statsFlaky },
		suites: [
			{
				title: "a suite",
				file: "tests/a.authed.e2e.ts",
				tests: specs.map(({ title, attempts }) => ({ title, results: attempts })),
			},
		],
	};
}

describe("the ci flake summary", () => {
	it("names the tests that passed on retry, with the count and no disagreement", () => {
		const { lines, flaky } = summarize(
			synthetic([
				{ title: "a flaky test", attempts: [{ status: "failed" }, { status: "passed" }] },
				{ title: "a clean test", attempts: [{ status: "passed" }] },
			]),
		);
		expect(flaky).toBe(1);
		expect(
			lines.some((line) =>
				line.includes("passed on retry — tests/a.authed.e2e.ts :: a flaky test"),
			),
		).toBe(true);
		expect(lines.some((line) => line.includes("flake absorbed by retries: 1"))).toBe(true);
		expect(lines.some((line) => line.startsWith("::warning::"))).toBe(false);
	});

	it("reads zero when no test needed its retry, without a disagreement warning", () => {
		const { lines, flaky } = summarize(
			synthetic([
				{ title: "a clean test", attempts: [{ status: "passed" }] },
				{ title: "another clean test", attempts: [{ status: "passed" }] },
			]),
		);
		expect(flaky).toBe(0);
		expect(lines.some((line) => line.includes("no flake"))).toBe(true);
		expect(lines.some((line) => line.startsWith("::warning::"))).toBe(false);
	});

	it("reads zero on a test that failed and stayed failed — that is the run's red, not a flake", () => {
		const { flaky, lines } = summarize(
			synthetic([
				{ title: "a failed test", attempts: [{ status: "failed" }, { status: "failed" }] },
			]),
		);
		expect(flaky).toBe(0);
		expect(lines.some((line) => line.includes("flake absorbed by retries: 1"))).toBe(false);
	});

	it("warns when the reporter's own stat disagrees with what the walker found", () => {
		const { lines } = summarize(
			synthetic(
				[{ title: "a flaky test", attempts: [{ status: "failed" }, { status: "passed" }] }],
				7,
			),
		);
		expect(lines.some((line) => line.includes("counted 7 flaky, the walker found 1"))).toBe(true);
	});
});
