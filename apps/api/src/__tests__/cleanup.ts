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
	abuseReports,
	comments,
	dmcaNotices,
	legalHolds,
	mediaQuarantine,
	moderationActions,
	moderationReports,
	poolDistributions,
	posts,
	purchases,
	ratings,
	rightsRequests,
	users,
	workRatingAppeals,
	works,
} from "@anthers/db/schema";
import { and, desc, eq, gt, inArray, or } from "drizzle-orm";

/**
 * Remove fixture accounts and everything of theirs that would otherwise survive them.
 *
 * 🚨 **Order is the whole correctness argument.** Every table below reaches its owner through a
 * `set null` column, so each row is findable only while the account still exists. Delete the
 * users first and the rest becomes unreachable litter with no owner to select on — which is
 * exactly why the litter was invisible for the weeks it accumulated.
 *
 * Works go before the account and after the rows that point *at* Works, because deleting a Work
 * cascades its assets, ratings, pages, scans, transcode jobs and share links, but `set null`s
 * the purchases and quarantine findings that have to outlive it.
 */
export async function purgeFixtureAccounts(usernames: string[]): Promise<void> {
	if (usernames.length === 0) return;
	const accounts = await db
		.select({ id: users.id })
		.from(users)
		.where(inArray(users.username, usernames));
	await purgeAccountIds(accounts.map((a) => a.id));
}

/**
 * The same purge, addressed by id.
 *
 * ⚠️ **An account with no username is still an account.** `users.username` is null between the
 * moment a signup's emailed code is verified and the moment onboarding claims a handle, so a
 * name-keyed purge silently skips every fixture left mid-ceremony. Ids do not have that gap.
 */
export async function purgeAccountIds(ids: number[]): Promise<void> {
	if (ids.length > 0) {
		const ownedWorks = await db
			.select({ id: works.id })
			.from(works)
			.where(inArray(works.creatorId, ids));
		const workIds = ownedWorks.map((w) => w.id);

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
		await db.delete(moderationReports).where(inArray(moderationReports.resolvedBy, ids));

		// The operator-side records. Each names an actor rather than belonging to one, which is
		// why every column here is nullable and none of them cascade.
		await db.delete(moderationActions).where(inArray(moderationActions.actorId, ids));
		await db.delete(legalHolds).where(inArray(legalHolds.placedBy, ids));
		await db.delete(dmcaNotices).where(inArray(dmcaNotices.actorId, ids));
		await db
			.delete(abuseReports)
			.where(or(inArray(abuseReports.reporterId, ids), inArray(abuseReports.resolvedBy, ids)));
		await db
			.delete(mediaQuarantine)
			.where(
				or(
					inArray(mediaQuarantine.uploaderId, ids),
					inArray(mediaQuarantine.placedBy, ids),
					inArray(mediaQuarantine.clearedBy, ids),
				),
			);

		// What they wrote about somebody else's content. Ratings and comments on their OWN Works
		// cascade when the Work goes, but these are the ones left on other people's.
		await db.delete(comments).where(inArray(comments.userId, ids));
		await db.delete(ratings).where(inArray(ratings.userId, ids));
		await db.delete(rightsRequests).where(inArray(rightsRequests.userId, ids));
		await db
			.delete(workRatingAppeals)
			.where(
				or(inArray(workRatingAppeals.creatorId, ids), inArray(workRatingAppeals.resolvedBy, ids)),
			);

		// Money. A purchase outlives the Work, the creator and the buyer by design, so it is
		// reachable from none of them once they are gone.
		await db
			.delete(purchases)
			.where(or(inArray(purchases.buyerId, ids), inArray(purchases.creatorId, ids)));
		await db
			.delete(poolDistributions)
			.where(
				or(inArray(poolDistributions.subscriberId, ids), inArray(poolDistributions.creatorId, ids)),
			);

		// Anything still pointing at a Work this account owns, before the Work itself goes.
		if (workIds.length > 0) {
			await db.delete(purchases).where(inArray(purchases.workId, workIds));
			await db.delete(mediaQuarantine).where(inArray(mediaQuarantine.workId, workIds));
			await db.delete(dmcaNotices).where(inArray(dmcaNotices.workId, workIds));
			await db.delete(abuseReports).where(inArray(abuseReports.workId, workIds));
		}

		// The content itself. Projects cascade from the account; these two do not.
		await db.delete(works).where(inArray(works.creatorId, ids));
		await db.delete(posts).where(inArray(posts.creatorId, ids));

		await db.delete(users).where(inArray(users.id, ids));
	}
}

/**
 * Register teardown for every account a suite creates, however it creates them.
 *
 * Call it once at the top level of a test file. It takes the highest `users.id` before the
 * suite runs and purges everything above that line afterward, so it does not care whether the
 * accounts arrived through `POST /auth/sign-up`, a direct `db.insert(users)`, or a helper three
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

	beforeAll(async () => {
		const [row] = await db.select({ id: users.id }).from(users).orderBy(desc(users.id)).limit(1);
		highWater = row?.id ?? 0;
	});

	// In `afterAll` rather than a closing `it`, so a suite that bails early still cleans up.
	afterAll(async () => {
		const created = await db.select({ id: users.id }).from(users).where(gt(users.id, highWater));
		await purgeAccountIds(created.map((r) => r.id));
	});
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
