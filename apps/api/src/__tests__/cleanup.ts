// SPDX-License-Identifier: Apache-2.0
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
 * 🚨 **Cascades are not a cleanup plan, and deleting the account is not the end of it.**
 * Twenty-one foreign keys into `users` are `set null` rather than `cascade`, deliberately,
 * because a record has to be able to outlive the account it concerns — a moderation report, a
 * purchase, a Work whose creator deleted themselves. So deleting a fixture user **orphans** its
 * content instead of removing it, and the orphans are invisible precisely because nothing
 * points at them any more.
 *
 * ⚠️ **Measured rather than reasoned about** (2026-09-04): one run of the unit suite against an
 * empty database left **1,036 rows across 36 tables**, of which 107 were users and 160 were
 * Works. Extrapolated over the runs since 2026-08-25 that is the ~32,000 accounts and ~45,000
 * Works a dev database was found holding. An earlier version of this comment asserted that
 * deleting a user "takes their comments and Works with it"; `works.creator_id` and
 * `comments.user_id` are both `set null`, so it never did.
 *
 * ⭐ **Hence the order below: content first, while the rows still point at their owner, then the
 * account.** Reversed, the second half has nothing left to find. The one that bites hardest is
 * `moderation_reports` — 123 rows per run, drained by a cron that mails `abuse@`, which is how
 * 390 real alerts once reached a real inbox.
 */

import { afterAll, beforeAll } from "bun:test";
import { db } from "@anthers/db/client";
import {
	adminAccountEvents,
	adminAccounts,
	adminSessions,
	comments,
	moderationActions,
	moderationReports,
	posts,
	reviews,
	users,
	votes,
	works,
} from "@anthers/db/schema";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";
import { purgeAccountIds, purgeFixtureAccounts, purgeReportsAbout, purgeWorkIds } from "./purge.js";

export { purgeAccountIds, purgeFixtureAccounts, purgeReportsAbout, purgeWorkIds };

/**
 * Register teardown for every account a suite creates, however it creates them.
 *
 * Call it once at the top level of a test file. It takes the highest `users.id` before the
 * suite runs and purges everything above that line afterward, so it does not care whether the
 * accounts arrived through `createAccount`, a direct `db.insert(users)`, or a helper three
 * files away — which is the whole point, because the 42 suites this was written for used all
 * three and no two of them named their fixtures alike.
 *
 * 🚨 **It relies on bun running test FILES sequentially**, which it does: the high-water mark is
 * "anything created since this file started", and that is only equal to "anything this file
 * created" while no other file is running. If bun ever grows parallel file execution, this
 * becomes a suite deleting its neighbors' fixtures and must be replaced with explicit tracking.
 *
 * ⭐ **Deliberate fixtures are safe by construction.** `gauntlet_creator`, `media_fixture`, the
 * `seed_*` accounts and the dev account are all seeded by scripts before any test runs, so they
 * sit below every suite's high-water mark and are never candidates.
 */
export function purgeAccountsCreatedHere(): void {
	let highWater = 0;
	let worksWater = 0;
	let postsWater = 0;
	let commentsWater = 0;
	let reviewsWater = 0;

	beforeAll(async () => {
		const [row, w, p, cmt, rv] = await Promise.all([
			db.select({ id: users.id }).from(users).orderBy(desc(users.id)).limit(1),
			db.select({ id: works.id }).from(works).orderBy(desc(works.id)).limit(1),
			db.select({ id: posts.id }).from(posts).orderBy(desc(posts.id)).limit(1),
			db.select({ id: comments.id }).from(comments).orderBy(desc(comments.id)).limit(1),
			db.select({ id: reviews.id }).from(reviews).orderBy(desc(reviews.id)).limit(1),
		]);
		highWater = row[0]?.id ?? 0;
		worksWater = w[0]?.id ?? 0;
		postsWater = p[0]?.id ?? 0;
		commentsWater = cmt[0]?.id ?? 0;
		reviewsWater = rv[0]?.id ?? 0;
	});

	// In `afterAll` rather than a closing `it`, so a suite that bails early still cleans up.
	//
	// The content sweep rides the same marks and files in the same place, because the
	// reason it exists is the accounts one cannot see it: a suite that exercises account
	// erasure is asserting that removal is a state and never a delete, so the Work, the
	// purchase, and the comment all outlive the account they belonged to — by design —
	// and a purge keyed on `users` cannot find them. Found the hard way: the suites
	// insert through the POST /api/content/works route or the shared fixture, and the
	// content sits above the works water mark while its creator row is already gone.
	afterAll(async () => {
		const [created, madeWorks, madePosts, madeComments, madeReviews] = await Promise.all([
			db.select({ id: users.id }).from(users).where(gt(users.id, highWater)),
			db.select({ id: works.id }).from(works).where(gt(works.id, worksWater)),
			db.select({ id: posts.id }).from(posts).where(gt(posts.id, postsWater)),
			db.select({ id: comments.id }).from(comments).where(gt(comments.id, commentsWater)),
			db.select({ id: reviews.id }).from(reviews).where(gt(reviews.id, reviewsWater)),
		]);
		await purgeContentByIds(
			madeWorks.map((r) => r.id),
			madePosts.map((r) => r.id),
			madeComments.map((r) => r.id),
			madeReviews.map((r) => r.id),
		);
		await purgeAccountIds(created.map((r) => r.id));
	});
}

/**
 * The content half of the sweep, factored out of `purgeAccountsCreatedHere` because it
 * has to exist as a thing on its own: a suite asserts orphaning as a *behavior*, and the
 * rows that behavior leaves cannot be discovered from the account that made them.
 *
 * Deleting in dependency order because each of the pointing tables carries `set null` or
 * no FK at all on its subject, and the subject is what is going away — the same shape the
 * account half handles for people.
 */
async function purgeContentByIds(
	workIds: number[],
	postIds: number[],
	commentIds: number[],
	reviewIds: number[],
): Promise<void> {
	if (commentIds.length > 0) {
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "comment"),
					inArray(moderationActions.subjectId, commentIds),
				),
			);
		await db
			.delete(votes)
			.where(and(eq(votes.subjectType, "comment"), inArray(votes.subjectId, commentIds)));
		await db.delete(comments).where(inArray(comments.id, commentIds));
	}
	if (reviewIds.length > 0) {
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "rating"),
					inArray(moderationActions.subjectId, reviewIds),
				),
			);
		await db.delete(reviews).where(inArray(reviews.id, reviewIds));
	}
	if (workIds.length > 0) {
		await purgeWorkIds(workIds);
	}
	if (postIds.length > 0) {
		await db
			.delete(moderationReports)
			.where(
				and(
					eq(moderationReports.subjectType, "post"),
					inArray(moderationReports.subjectId, postIds),
				),
			);
		await db.delete(posts).where(inArray(posts.id, postIds));
	}
}

/**
 * Take back every admin account a suite created, on success or failure.
 *
 * The same high-water shape as `purgeAccountsCreatedHere`, for the same reason: a suite that makes an
 * admin account through `createAdminFixture` has no list of what it made. Every column that names an
 * operator is `set null`, so the records an admin account acted on survive it, which is what they
 * are for; the account's own sessions and the record of changes to it go with it.
 */
export function purgeAdminAccountsCreatedHere(): void {
	let highWater = 0;

	beforeAll(async () => {
		const [row] = await db
			.select({ id: adminAccounts.id })
			.from(adminAccounts)
			.orderBy(desc(adminAccounts.id))
			.limit(1);
		highWater = row?.id ?? 0;
	});

	afterAll(async () => {
		const created = await db
			.select({ id: adminAccounts.id })
			.from(adminAccounts)
			.where(gt(adminAccounts.id, highWater));
		const ids = created.map((r) => r.id);
		if (ids.length === 0) return;
		await db
			.delete(adminAccountEvents)
			.where(
				or(inArray(adminAccountEvents.accountId, ids), inArray(adminAccountEvents.actorId, ids)),
			);
		await db.delete(adminSessions).where(inArray(adminSessions.accountId, ids));
		await db.delete(adminAccounts).where(inArray(adminAccounts.id, ids));
	});
}
