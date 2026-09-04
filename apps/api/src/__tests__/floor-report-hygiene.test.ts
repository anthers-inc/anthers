// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * No suite manufactures a floor report unless it was asked to.
 *
 * 🚨 **A floor report is a request for a person to stop what they are doing and look.** Filing
 * one from a test that is not about reporting is not a tidiness problem — it puts a demand for
 * immediate human review into a queue whose whole value is that everything in it is real.
 * Parker's rule, 2026-08-26: *"abuse report tests should NEVER be automatic, only on explicit
 * request; all that does is add noise to a reporting process that always needs immediate human
 * review."*
 *
 * ⚠️ **This exists because gating the obvious suites was not enough, and the gap was invisible.**
 * `report-escalation`, `escalation-delivery` and `abuse-reports` are the tests *about* abuse
 * reports, and gating them still left `illegal` and `sexual` reports appearing on every run —
 * from `legal-hold`, `quarantine`, `retention`, `dmca-finality` and `dmca`, none of which is
 * about escalation and four of which had picked a floor reason arbitrarily. A reason is not an
 * inert string: choosing `illegal` over `spam` is choosing to summon somebody.
 *
 * ⭐ **A source check rather than a database check, deliberately.** Asserting "the table is
 * empty after this run" would depend on what else ran, in what order, and on nobody having
 * clicked around their own dev database — a test that fails for reasons that are not its
 * subject. Reading the suite's own source asks the question that actually matters: does
 * anything here file one of these without meaning to?
 *
 * Same family as `scripts/stripe-redirect-guard.test.ts` and `scripts/profile-url-guard.test.ts`:
 * where a design says a thing does not happen, the absence needs a test, because a new one
 * arrives silently.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { FLOOR_MODERATION_REASONS } from "@anthers/shared/moderation";

/**
 * Suites whose subject IS abuse reporting, and which are gated behind `RUN_ABUSE_TESTS=1`.
 *
 * ⚠️ Adding a name here is a decision to let a file file floor reports, so it must come with
 * the gate — the check below verifies that rather than taking the list's word for it.
 */
const GATED = new Set([
	"report-escalation.test.ts",
	"escalation-delivery.test.ts",
	"abuse-reports.test.ts",
]);

/**
 * Files that file a floor report on purpose and clean it up again.
 *
 * `dmca.test.ts` reports a Work as `illegal` because that is the closest reason to a copyright
 * claim, and the point of the test is that a report is not a takedown. It deletes the row in
 * its own teardown, which is the other honest answer to this rule.
 */
const CLEANS_UP = new Set(["dmca.test.ts"]);

const DIR = import.meta.dir;
/** ⚠️ This file quotes the shape it is looking for, so it would report itself. */
const SELF = "floor-report-hygiene.test.ts";
const suites = readdirSync(DIR).filter((f) => f.endsWith(".test.ts") && f !== SELF);

/** `reason: "illegal"` and friends — the shape that files one, not a mention in prose. */
const FILES_A_FLOOR_REPORT = new RegExp(
	`reason:\\s*["'](${FLOOR_MODERATION_REASONS.join("|")})["']`,
);

describe("floor reports are never filed by accident", () => {
	it("finds the suites at all, so a broken glob cannot pass silently", () => {
		expect(suites.length).toBeGreaterThan(20);
	});

	it("no ungated suite files one without cleaning it up", () => {
		const offenders = suites.filter((file) => {
			if (GATED.has(file) || CLEANS_UP.has(file)) return false;
			return FILES_A_FLOOR_REPORT.test(readFileSync(`${DIR}/${file}`, "utf8"));
		});

		expect(
			offenders,
			"these file a report that demands immediate human review. Use a non-floor reason " +
				"if the reason is incidental, clean it up if it is not, or gate the suite behind " +
				"RUN_ABUSE_TESTS=1 if its subject really is abuse reporting.",
		).toEqual([]);
	});

	it("every suite named as gated actually is", () => {
		// 🚨 The list above is a claim, and a claim in a test is worth what the check behind it
		// is worth. A file could be added to GATED and never wired to the flag, which would
		// read as compliance while filing reports on every run.
		for (const file of GATED) {
			const source = readFileSync(`${DIR}/${file}`, "utf8");
			expect(source, `${file} is listed as gated`).toContain("SKIP_ABUSE_TESTS");
			expect(source, `${file} declares the gate but never applies it`).toContain(
				"describe.skipIf(SKIP_ABUSE_TESTS)",
			);
		}
	});
});
