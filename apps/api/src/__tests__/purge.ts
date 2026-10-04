// SPDX-License-Identifier: Apache-2.0
/**
 * The database-only purge functions, split from `cleanup.ts` because they must load under
 * Node as well as Bun.
 *
 * 🚨 **Playwright's workers run under Node, and an e2e spec that imports `cleanup.ts` dies at
 * worker boot** — `cleanup.ts` registers its high-water sweeps with `beforeAll`/`afterAll`
 * from `bun:test`, which Node cannot load (`bun:` is not a protocol the default ESM loader
 * supports). Found 2026-10-04 on PR #351: `browser-media` failed identically on two runs
 * with "Only URLs with a scheme in: file, data, and node are supported by the default ESM
 * loader. Received protocol 'bun:'" — four errors, one per worker, before a single spec
 * ran, because two authed specs imported `purgeAccountIds` from `cleanup.ts`.
 *
 * These four functions are pure database work — no test-framework imports, nothing that
 * hooks a suite's lifecycle — so they are safe for any runtime that can reach Postgres.
 * `cleanup.ts` re-exports them unchanged, so the dozens of `bun:test` suites that import
 * from `cleanup` are untouched; an e2e spec that needs teardown imports from HERE, and a
 * spec that imports from `cleanup.ts` is the defect this file exists to make visible by
 * type alone — the guard that keeps the split honest is in `e2e-cleanup-imports` (see
 * `apps/web/tests`).
 *
 * The doc comments below moved with their functions from `cleanup.ts`, which carries the
 * standing rule and the ordering argument in its header.
 */

import { db } from "@anthers/db/client";
import {
	abuseReports,
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
import { and, eq, inArray, or } from "drizzle-orm";

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
export async function purgeFixtureAccounts(names: string[]): Promise<void> {
	if (names.length === 0) return;
	// Callers pass the short NAME they gave `createAccount`; the row is keyed on the issued
	// handle `<name>.<suffix>`, whose first label is that name (handle names are one label,
	// so this never collides with a longer name sharing a prefix).
	const wanted = new Set(names);
	const accounts = await db.select({ id: users.id, handle: users.atprotoHandle }).from(users);
	await purgeAccountIds(
		accounts.filter((a) => wanted.has(a.handle.split(".")[0])).map((a) => a.id),
	);
}

/**
 * The same purge, addressed by id.
 *
 * ⚠️ **Handles are normalized, and the name a suite typed is not always the name that was
 * issued** — `localHandleName` rewrites a name the server would refuse and renames an
 * underscore to a dash. Callers that know the user id (which is every caller of
 * `createAccount`, since it returns one) purge by id and sidestep the whole question.
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
 * Delete Works by id, with the rows that would otherwise orphan pointing at them.
 *
 * A Work's own variants (`assets`, `media_scans`, `transcoding_jobs`, `library_items`,
 * `work_pages`, share links) cascade. What does not is the dependency-order pass every
 * other sweep in this file already follows: a purchase (outlives the Work in production,
 * not in a fixture), the ledger rows that name it (`SET NULL` would strand them), the
 * quarantine finding, and a moderation report whose subject is the Work.
 *
 * Exported for `work-fixtures.ts`, whose `insertWork` is how most Works arrive in a test
 * at all — a sweep keyed on the account that made the content cannot reach those, which
 * is the finding this exists to answer.
 */
export async function purgeWorkIds(workIds: number[]): Promise<void> {
	if (workIds.length === 0) return;
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
			and(eq(moderationReports.subjectType, "work"), inArray(moderationReports.subjectId, workIds)),
		);
	await db.delete(works).where(inArray(works.id, workIds));
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
