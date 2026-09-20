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
	abuseReports,
	adminAccountEvents,
	adminAccounts,
	adminSessions,
	comments,
	creatorCredits,
	crfLedger,
	dmcaNotices,
	invoices,
	legalHolds,
	mediaQuarantine,
	moderationActions,
	moderationReports,
	poolDistributions,
	posts,
	purchases,
	reviews,
	rightsRequests,
	stickers,
	users,
	votes,
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
 * cascades its assets, reviews, pages, scans, transcode jobs and share links, but `set null`s
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

		// What they wrote about somebody else's content. Reviews and comments on their OWN Works
		// cascade when the Work goes, but these are the ones left on other people's.
		await db.delete(comments).where(inArray(comments.userId, ids));
		await db.delete(reviews).where(inArray(reviews.userId, ids));
		// `votes.user_id` is `set null` too, for the same reason reviews is: a departing
		// account must not move everyone else's scores. So a fixture's votes outlive the
		// fixture unless they are taken explicitly, which is the shape of every leak this
		// file exists to stop.
		await db.delete(votes).where(inArray(votes.userId, ids));
		await db.delete(rightsRequests).where(inArray(rightsRequests.userId, ids));
		await db
			.delete(workRatingAppeals)
			.where(
				or(inArray(workRatingAppeals.creatorId, ids), inArray(workRatingAppeals.resolvedBy, ids)),
			);

		// Money. A purchase outlives the Work, the creator and the buyer by design, so it is
		// reachable from none of them once they are gone. The CRF ledger's only FK is
		// `purchase_id → purchases ON DELETE SET NULL`, so dropping a purchase without first
		// taking the ledger rows that point at it does not clean them up — it *orphans* them
		// here, which is how this purge's own pass was the largest single source of residue.
		const ownedPurchases = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(or(inArray(purchases.buyerId, ids), inArray(purchases.creatorId, ids)));
		const purchaseIds = ownedPurchases.map((p) => p.id);
		if (purchaseIds.length > 0) {
			await db.delete(crfLedger).where(inArray(crfLedger.purchaseId, purchaseIds));
		}
		await db
			.delete(purchases)
			.where(or(inArray(purchases.buyerId, ids), inArray(purchases.creatorId, ids)));
		await db
			.delete(poolDistributions)
			.where(
				or(inArray(poolDistributions.subscriberId, ids), inArray(poolDistributions.creatorId, ids)),
			);

		// Settlement's records name their people through `set null` columns for the same reason:
		// an invoice and a credit are the books, and the books outlive the account. An invoice's
		// lines go with it.
		await db
			.delete(creatorCredits)
			.where(or(inArray(creatorCredits.creatorId, ids), inArray(creatorCredits.subscriberId, ids)));
		await db.delete(invoices).where(inArray(invoices.userId, ids));

		// A Sticker names its giver and its creator through `set null` columns, for the same reason
		// a distribution does, so it outlives both unless it is taken here.
		await db
			.delete(stickers)
			.where(or(inArray(stickers.giverId, ids), inArray(stickers.creatorId, ids)));

		// Anything still pointing at a Work this account owns, before the Work itself goes.
		if (workIds.length > 0) {
			const workPurchaseIds = (
				await db
					.select({ id: purchases.id })
					.from(purchases)
					.where(inArray(purchases.workId, workIds))
			).map((p) => p.id);
			if (workPurchaseIds.length > 0) {
				await db.delete(crfLedger).where(inArray(crfLedger.purchaseId, workPurchaseIds));
			}
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
 * The same high-water sweep, for the content a suite created — not the accounts.
 *
 * 🚨 **This exists for the suites whose PASSING test orphans a row by design.** A suite
 * that exercises account erasure is asserting "removal is a state, never a delete" — the
 * Work, the purchase, the comment all outlive the account they belonged to, which is the
 * behavior under test. `purgeAccountsCreatedHere` then cannot reach them, because reaching
 * them through the account is the thing the test just proved is impossible. So they leak:
 * 25 Works and the rows that follow them, per run, measured 2026-09-19.
 *
 * The sweep marks the highest `works.id` and `posts.id` at file start and deletes what
 * sits above them at file end — content ids rather than account ids, which is the whole
 * of the difference. Deleting a Work cascades its own assets, scans, transcode jobs and
 * library rows, and any purchase or moderation action that pointed at it goes too: a test
 * fixture's row is owed nothing. High-water marks on `comments` and `reviews` cover a
 * suite that wrote somebody else's thread the same way.
 */
export function purgeContentCreatedHere(): void {
	let worksWater = 0;
	let postsWater = 0;
	let commentsWater = 0;
	let reviewsWater = 0;

	beforeAll(async () => {
		const [w, p, cmt, rv] = await Promise.all([
			db.select({ id: works.id }).from(works).orderBy(desc(works.id)).limit(1),
			db.select({ id: posts.id }).from(posts).orderBy(desc(posts.id)).limit(1),
			db.select({ id: comments.id }).from(comments).orderBy(desc(comments.id)).limit(1),
			db.select({ id: reviews.id }).from(reviews).orderBy(desc(reviews.id)).limit(1),
		]);
		worksWater = w[0]?.id ?? 0;
		postsWater = p[0]?.id ?? 0;
		commentsWater = cmt[0]?.id ?? 0;
		reviewsWater = rv[0]?.id ?? 0;
	});

	afterAll(async () => {
		const [madeWorks, madePosts, madeComments, madeReviews] = await Promise.all([
			db.select({ id: works.id }).from(works).where(gt(works.id, worksWater)),
			db.select({ id: posts.id }).from(posts).where(gt(posts.id, postsWater)),
			db.select({ id: comments.id }).from(comments).where(gt(comments.id, commentsWater)),
			db.select({ id: reviews.id }).from(reviews).where(gt(reviews.id, reviewsWater)),
		]);
		const workIds = madeWorks.map((r) => r.id);
		const postIds = madePosts.map((r) => r.id);
		const commentIds = madeComments.map((r) => r.id);
		const reviewIds = madeReviews.map((r) => r.id);

		// What pointed at the content first, while the pointer still resolves.
		// `moderation_actions`, `moderation_reports`, `votes` and `stickers` each name a
		// subject polymorphically or through a `set null` column, which is the same
		// orphan-by-design shape the accounts purge handles for people.
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
			// A purchase on the Work outlives it by design in production; a fixture's does
			// not. The ledger rows that name those purchases go first — `SET NULL` would
			// strand them, which is the lesson the account half of this file already paid.
			const purchasesHere = await db
				.select({ id: purchases.id })
				.from(purchases)
				.where(inArray(purchases.workId, workIds));
			const purchaseIds = purchasesHere.map((r) => r.id);
			if (purchaseIds.length > 0) {
				await db.delete(crfLedger).where(inArray(crfLedger.purchaseId, purchaseIds));
			}
			await db.delete(purchases).where(inArray(purchases.workId, workIds));
			await db.delete(mediaQuarantine).where(inArray(mediaQuarantine.workId, workIds));
			await db
				.delete(moderationReports)
				.where(
					and(
						eq(moderationReports.subjectType, "work"),
						inArray(moderationReports.subjectId, workIds),
					),
				);
			await db.delete(works).where(inArray(works.id, workIds));
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
	});
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

/**
 * Remove reports filed against particular subjects — comments, Works, reviews.
 *
 * For the case `purgeFixtureAccounts` cannot reach: a report filed by an account the suite does
 * not own, or one whose reporter is already gone. The subject columns are polymorphic and carry
 * no foreign key, so deleting the comment or the Work leaves the report behind.
 */
export async function purgeReportsAbout(
	subjectType: "comment" | "review" | "work" | "post" | "person",
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
