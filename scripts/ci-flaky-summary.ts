// SPDX-License-Identifier: Apache-2.0
/**
 * Count the flake the CI run's retries absorbed, per spec, from Playwright's JSON report.
 *
 * CI's `retries: 2` is the harness's answer to a flaky spec, but it double-mutes: the run
 * shows green, and the fact that a spec failed before passing disappears unless somebody
 * parses the report. This is that parse, run as the step after each browser job's test
 * step: every test that failed and then passed on a retry — the ledger's own definition
 * of a transient red — is printed as a `::notice` naming the file and the title, with
 * the row written to `$GITHUB_STEP_SUMMARY` when the run defines one. Nothing here gates
 * or fails the job: a run whose report is missing prints that fact and exits green, because
 * a run that never got to a report is already red on its own account.
 *
 * Usage: `bun run scripts/ci-flaky-summary.ts <report.json>` — the path is the JSON
 * reporter's output file. Unit-testable with a synthetic report object; the shape read
 * here is the reporter's own (`stats.flaky`, tests' `results[]` with a final passed
 * attempt), asserted by the test rather than trusted.
 */

import { appendFileSync, readFileSync } from "node:fs";

interface JsonReportTest {
	title?: string;
	file?: string;
	path?: string;
	location?: { file?: string };
	results?: { status?: string }[];
}
export interface JsonReportSuite {
	title?: string;
	file?: string;
	suites?: JsonReportSuite[];
	tests?: JsonReportTest[];
}
export interface JsonReport {
	stats?: { flaky?: number; total?: number };
	suites?: JsonReportSuite[];
}

/** A test that failed at least once and passed on a later attempt — the ledger's flake. */
function isFlaky(test: JsonReportTest): boolean {
	const results = test.results ?? [];
	return results.length > 1 && results[results.length - 1]?.status === "passed";
}

function walk(suite: JsonReportSuite, out: { file: string; title: string }[]): void {
	for (const child of suite.suites ?? []) walk(child, out);
	// A terminal suite's file: the reporter puts `file` on the leaf suite the tests hang
	// from, and a nested `location.file` or `path` on the test itself when it does not.
	for (const test of suite.tests ?? []) {
		if (!isFlaky(test)) continue;
		const file = suite.file ?? test.location?.file ?? test.path ?? suite.title ?? "unfiled";
		out.push({ file, title: test.title ?? "(no title)" });
	}
}

function flakyStats(report: JsonReport): {
	stats: JsonReport["stats"];
	tests: { file: string; title: string }[];
} {
	const tests: { file: string; title: string }[] = [];
	for (const suite of report.suites ?? []) walk(suite, tests);
	return { stats: report.stats, tests };
}

export function summarize(report: JsonReport): { lines: string[]; flaky: number } {
	const { stats, tests } = flakyStats(report);
	const reported = stats?.flaky;
	// The walker is the source of the names; the reporter's own stats.flaky is the
	// cross-check. A disagreement between them is a report shape the script does not
	// understand — say so rather than quietly trusting the walker.
	const lines: string[] = [];
	if (typeof reported === "number" && reported !== tests.length) {
		lines.push(
			`::warning::the report's stats counted ${reported} flaky, the walker found ${tests.length} — report shape drifted; do not trust either count until checked`,
		);
	}
	if (tests.length > 0) {
		for (const { file, title } of tests) {
			lines.push(`::notice::flake: passed on retry — ${file} :: ${title}`);
		}
		lines.push(`::notice::flake absorbed by retries: ${tests.length} test(s) this run`);
	} else {
		lines.push("::notice::no flake: every failed attempt's retry re-failed (or none failed)");
	}
	if (typeof stats?.total === "number") {
		lines.push(`::notice::run size: ${stats.total} test(s), ${reported ?? tests.length} flaky`);
	}
	return { lines, flaky: tests.length };
}

function main(): number {
	const path = process.argv[2];
	if (!path) {
		console.error("usage: bun run scripts/ci-flaky-summary.ts <playwright JSON report>");
		return 64;
	}
	let report: JsonReport;
	try {
		report = JSON.parse(readFileSync(path, "utf8")) as JsonReport;
	} catch {
		// No report means the suite never produced one (it died before finishing, or the
		// job is red at a step above the tests) — already visible from the run itself.
		console.log(`→ no JSON report at ${path}; the flake count is unavailable for this run`);
		return 0;
	}
	const { lines, flaky } = summarize(report);
	for (const line of lines) console.log(line);
	const summaryFile = process.env.GITHUB_STEP_SUMMARY;
	if (summaryFile) {
		try {
			const { tests } = flakyStats(report);
			const rows = tests
				.map(({ file, title }) => `| \`${file}\` | ${title.replace(/\|/g, "\\|")} |`)
				.join("\n");
			appendFileSync(
				summaryFile,
				`## Flake absorbed by retries\n\n${tests.length} test(s) passed on retry.\n\n| File | Test |\n| --- | --- |\n${rows}\n\n`,
			);
		} catch {
			// The step summary is a nicety; the ::notice lines above carry the finding either way.
		}
	}
	console.log(`→ flaky this run: ${flaky}`);
	return 0;
}

if (import.meta.main) {
	process.exit(main());
}
