// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every suite that creates an account takes it back again.
 *
 * 🚨 **The rule was stated, agreed, and then quietly ignored by 42 of the 55 suites that create
 * accounts** — not through carelessness but because nothing could tell. A leaked account breaks
 * no test, slows nothing measurably, and is invisible unless somebody counts rows in a database
 * nobody looks at. By 2026-09-04 that was **31,806 accounts and ~45,000 Works** in the dev
 * database, and the only reason it surfaced at all was an unrelated question about 321 rows.
 *
 * ⚠️ **It is not merely untidy.** `moderation_reports` does not cascade from the account that
 * filed it, and a cron drains that table to `abuse@` — which is how 390 real alerts once reached
 * a real inbox from test fixtures. Litter in this database has already summoned a human being.
 *
 * ⭐ **A source scan rather than a row count, deliberately.** Asserting "the tables are empty
 * after this run" depends on what else ran, in what order, and on nobody having clicked around
 * their own dev database — a test that fails for reasons that are not its subject. Reading the
 * suites' own source asks the question that actually matters: does anything here create an
 * account it never removes?
 *
 * Same family as `scripts/stripe-redirect-guard.test.ts`, `scripts/profile-url-guard.test.ts`
 * and `floor-report-hygiene.test.ts`: where a design says a thing does not happen, the absence
 * needs a test, because a new one arrives silently.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

const HERE = import.meta.dir;

/**
 * How a suite makes an account, in all three spellings that exist here.
 *
 * `POST /auth/sign-up` is the common one; a direct `db.insert(users)` shows up as a `username:`
 * field in an object literal; and several suites reach for a local helper that does one or the
 * other. Matching the *field* rather than the call is what catches the third case — it was
 * `distribute-pool.test.ts`, the single biggest leak at 38 accounts a run, and a scan looking
 * only for `sign-up` and `createUser` missed it completely.
 */
const CREATES_ACCOUNTS = /username:|sign-up/;

/** Either form of taking them back: the registrar, or an explicit named purge. */
const CLEANS_UP = /purgeAccountsCreatedHere|purgeFixtureAccounts|purgeAccountIds/;

/**
 * This file, which has to quote both patterns to test for them.
 *
 * Excluded explicitly rather than left to chance: the regexes above contain a `username:` and a
 * `purgeAccountsCreatedHere`, so this file reads as both a creator and a cleaner and would pass
 * for the wrong reason. A guard that exempts itself by coincidence stops doing so the moment
 * somebody rewords a pattern.
 */
const SELF = "fixture-hygiene.test.ts";

function testFiles(): string[] {
	return readdirSync(HERE).filter((f) => f.endsWith(".test.ts") && f !== SELF);
}

describe("fixture hygiene", () => {
	it("scans a plausible number of suites, so a broken read cannot pass silently", () => {
		// Without this every assertion below is satisfied by an empty file list.
		expect(testFiles().length).toBeGreaterThan(50);
	});

	it("finds the suites that create accounts, so the rule cannot rot into checking nothing", () => {
		const creators = testFiles().filter((f) =>
			CREATES_ACCOUNTS.test(readFileSync(`${HERE}/${f}`, "utf8")),
		);
		expect(creators.length).toBeGreaterThan(40);
	});

	it("🚨 removes every account it creates", () => {
		const leaking = testFiles().filter((f) => {
			const src = readFileSync(`${HERE}/${f}`, "utf8");
			return CREATES_ACCOUNTS.test(src) && !CLEANS_UP.test(src);
		});
		expect(
			leaking,
			"a suite that creates accounts must call purgeAccountsCreatedHere() at its top level; see cleanup.ts",
		).toEqual([]);
	});
});
