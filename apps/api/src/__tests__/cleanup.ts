// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Taking back what a suite put in the database.
 *
 * 🚨 **The standing rule** (Parker, 2026-08-26): *"we need to start being more cautious about
 * things we add to the database for testing, both by adding fewer things (if ever) and by
 * cleaning up anything we add immediately upon completion of the test, success or failure."*
 *
 * ⚠️ **"Success or failure" is the load-bearing half, and it decides where teardown goes.** It
 * belongs in `afterAll`, which bun runs whatever the tests did. It does **not** belong in a
 * final `it("removes the fixture")`, which is how `report-escalation.test.ts` used to do it —
 * that reads as tidy and is a test of nothing, it sorts among the real tests as though it were
 * one, and a suite that bails early never reaches it.
 *
 * ⭐ **Cascades are not a cleanup plan here, and that is the trap this module exists for.**
 * Deleting a fixture user takes their comments and Works with it, so it *looks* like enough —
 * but `moderation_reports.reporter_id` is `set null` rather than `cascade`, deliberately,
 * because a moderation record has to outlive the account it concerns. So the reports stay, and
 * every run leaves more. That is how 894 of them accumulated in a dev database by 2026-08-26,
 * about 400 carrying a floor reason, until a worker with a real mail key posted them all to
 * `abuse@`. **Ask what does NOT cascade, rather than assuming the account is the root.**
 */

import { db } from "@anthers/db/client";
import { moderationReports, users } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";

/**
 * Remove fixture accounts and everything of theirs that would otherwise survive them.
 *
 * Order matters: the reports are found *through* the users, so they have to go first. Once the
 * accounts are deleted the `reporter_id` is null and there is nothing left to select on —
 * which is precisely why the litter was invisible.
 *
 * Filing is the widest net available: in a suite whose reporters are all fixtures, "reports
 * these accounts filed" covers every subject type without the caller having to remember which
 * comments, Works and people it reported along the way.
 */
export async function purgeFixtureAccounts(usernames: string[]): Promise<void> {
	if (usernames.length === 0) return;

	const accounts = await db
		.select({ id: users.id })
		.from(users)
		.where(inArray(users.username, usernames));
	const ids = accounts.map((a) => a.id);

	if (ids.length > 0) {
		// What they filed.
		await db.delete(moderationReports).where(inArray(moderationReports.reporterId, ids));
		// And what was filed about them — a person report's subject is an account id, and it
		// has no foreign key at all (the subject is polymorphic), so nothing takes it away.
		// ⚠️ Both spellings. A report about an account is stored as `person` in one place and
		// `user` in another, and a cleanup that knew only one left the other behind — which is
		// how `account-export.test.ts` kept littering after every other suite was tidy.
		await db
			.delete(moderationReports)
			.where(
				and(
					inArray(moderationReports.subjectType, ["person", "user"]),
					inArray(moderationReports.subjectId, ids),
				),
			);
	}

	await db.delete(users).where(inArray(users.username, usernames));
}

/**
 * Remove reports filed against particular subjects — comments, Works, ratings.
 *
 * For the case `purgeFixtureAccounts` cannot reach: a report filed by an account the suite does
 * not own, or one whose reporter is already gone. The subject columns are polymorphic and carry
 * no foreign key, so deleting the comment or the Work leaves the report behind.
 */
export async function purgeReportsAbout(
	subjectType: "comment" | "rating" | "work" | "post" | "person",
	subjectIds: number[],
): Promise<void> {
	const ids = subjectIds.filter((id) => Number.isInteger(id));
	if (ids.length === 0) return;
	await db
		.delete(moderationReports)
		.where(
			and(
				eq(moderationReports.subjectType, subjectType),
				inArray(moderationReports.subjectId, ids),
			),
		);
}
