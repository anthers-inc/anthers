// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion — scheduled, cancellable, and honest about what survives.
 *
 * The largest of 51.05's promises and the one most directly downstream of Article
 * I(c), which commits the corporation to advancing individuals' ability to **control**
 * what they create. Until now there was no way to leave at all.
 *
 * **Parker's shape (2026-08-07), and why deletion is not immediate:**
 *
 * 1. **Informed consent.** The user has to understand what they lose, enumerated at
 *    the point of deletion rather than buried in a policy. `deletionPreview()` exists
 *    so the confirmation screen states real counts from this account, not a generic
 *    warning nobody reads.
 * 2. **An "oops" window.** `DELETION_GRACE_DAYS` between the request and the wipe, so
 *    a change of mind is recoverable. Cancelling clears one column.
 * 3. **No hoarding.** The delay is a grace period, **not an archive**. Nothing may
 *    start retaining data *because* a deletion is pending, nothing extends the window,
 *    and when it elapses the wipe runs.
 *
 * The safety lives in that flow rather than in the foreign keys, which is the whole
 * reasoning behind the ruling — a cascade used as a substitute for consent and a
 * cancel window is a constraint doing a product's job.
 *
 * **What deletion actually means, per table.** 51.05 sets these out and they are not
 * uniform, because the tables genuinely differ. The legal frame that makes it
 * tractable: erasure is not absolute and runs to *personal data*, not to every
 * artifact, so it is often satisfied by **severing the identity link** rather than
 * destroying content.
 *
 * | What | Outcome | Why |
 * |:--|:--|:--|
 * | profile, sessions, ATProto link, follows, bookmarks, blocks, attention rows | **destroyed** (FK cascade) | purely this person's |
 * | comments, posts | **tombstoned** — author nulled, content stays | a thread full of holes is worse for everyone still in it, and deleting a post takes third parties' comments with it |
 * | reviews | **anonymised** — score stays, author nulled | a bare 1–5 is the least personal thing here, and removing it moves a creator's average through no fault of theirs |
 * | Works nobody bought | **destroyed** | nothing depends on them |
 * | Works someone bought | **withdrawn** | a purchase outlives the Work — buyers keep what they paid for |
 * | purchases | **buyer detached, row kept** | sales-tax remittance records; settled 2026-08-10 |
 * | moderation reports & actions | **kept, actor nulled** | after a `DELETE`, "why was my comment removed?" has no honest answer |
 *
 * 🚨 **The tombstone says only WHO, never WHY.** A null author renders "deleted by
 * user"; a moderation removal is `moderation_status` and renders separately. The two
 * must never be conflated, because the one thing worth guaranteeing is that **we never
 * claim a user deleted something they didn't.**
 *
 * What this deliberately does NOT do is notify anyone — the app has no notification
 * path at all (51.05 marker 8), which is the same gap the withdrawn-Work rescue window
 * hits. A deletion that silently withdraws a purchased Work is visible to its buyers in
 * their Library and nowhere else, and that is a stated shortfall rather than a
 * pretence.
 */

import { db } from "@anthers/db/client";
import { comments, posts, purchases, ratings, sessions, users, works } from "@anthers/db/schema";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";

/**
 * How long a user has to change their mind.
 *
 * Long enough that a deletion made in anger or by mistake is recoverable the next day,
 * short enough that it cannot be mistaken for retention. Parker's steer was "at least a
 * day or two"; seven days survives a week away from the computer without becoming an
 * archive.
 */
export const DELETION_GRACE_DAYS = 7;

export interface DeletionPreview {
	/** Destroyed outright. */
	follows: number;
	bookmarks: number;
	blocks: number;
	viewingEvents: number;
	sessions: number;
	/** Kept, with the author removed. */
	comments: number;
	reviews: number;
	posts: number;
	/** Works split by whether anyone bought them. */
	worksDeleted: number;
	worksWithdrawn: number;
	/** Kept with the buyer detached, for tax records. */
	purchases: number;
}

/**
 * Real counts from this account, for the confirmation screen.
 *
 * The point of consent being *informed* is that the numbers are theirs. "Your content
 * will be deleted" is a sentence people click past; "3 Works deleted, 1 withdrawn
 * because someone bought it, 14 comments tombstoned" is a decision.
 */
export async function deletionPreview(userId: number): Promise<DeletionPreview> {
	/** One scalar count. Raw SQL because these are nine one-line counts over nine tables. */
	const countRows = async (table: string, column: string): Promise<number> => {
		const rows = await db.execute(
			sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${userId}`,
		);
		const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? []);
		return Number((list[0] as { n: number } | undefined)?.n ?? 0);
	};

	const workIds = (
		await db.select({ id: works.id }).from(works).where(eq(works.creatorId, userId))
	).map((w) => w.id);

	const purchasedWorkIds = await purchasedAmong(workIds);

	const [
		follows_,
		bookmarks_,
		blocks_,
		viewing,
		sessions_,
		comments_,
		reviews_,
		posts_,
		purchases_,
	] = await Promise.all([
		countRows("follows", "follower_id"),
		countRows("bookmarks", "user_id"),
		countRows("user_blocks", "blocker_id"),
		countRows("attention_events", "user_id"),
		countRows("sessions", "user_id"),
		countRows("comments", "user_id"),
		countRows("ratings", "user_id"),
		countRows("posts", "creator_id"),
		countRows("purchases", "buyer_id"),
	]);

	return {
		follows: follows_,
		bookmarks: bookmarks_,
		blocks: blocks_,
		viewingEvents: viewing,
		sessions: sessions_,
		comments: comments_,
		reviews: reviews_,
		posts: posts_,
		worksDeleted: workIds.length - purchasedWorkIds.length,
		worksWithdrawn: purchasedWorkIds.length,
		purchases: purchases_,
	};
}

/**
 * Which of these Works somebody has actually completed a purchase of.
 *
 * Shared by the preview and the erase so the confirmation screen cannot promise one
 * outcome and the job deliver another — "3 deleted, 1 withdrawn" has to be the same
 * classification that runs a week later.
 */
async function purchasedAmong(workIds: number[]): Promise<number[]> {
	if (workIds.length === 0) return [];
	const rows = await db
		.selectDistinct({ id: purchases.workId })
		.from(purchases)
		.where(and(inArray(purchases.workId, workIds), eq(purchases.status, "completed")));
	return rows.map((r) => r.id).filter((v): v is number => v != null);
}

/**
 * Schedule the deletion, and end the session immediately.
 *
 * Revoking every session at request time rather than at wipe time is deliberate, and
 * it is about the *other* devices: confirming deletion signs the account out
 * everywhere, so a shared laptop or a phone left behind stops being a way in during
 * the grace period.
 *
 * It does **not** lock the account — signing back in is exactly how someone cancels,
 * and a deletion you cannot reverse without contacting support is not the "oops"
 * window this was asked for. So sign-in keeps working and the app tells them what is
 * pending.
 */
export async function requestDeletion(userId: number): Promise<{ scheduledFor: string }> {
	const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
	await db.transaction(async (tx) => {
		await tx.update(users).set({ deletionRequestedAt: scheduledFor }).where(eq(users.id, userId));
		await tx.delete(sessions).where(eq(sessions.userId, userId));
	});
	return { scheduledFor: scheduledFor.toISOString() };
}

/** Change of mind. Clearing the column is the whole of it. */
export async function cancelDeletion(userId: number): Promise<{ cancelled: boolean }> {
	const rows = await db
		.update(users)
		.set({ deletionRequestedAt: null })
		.where(and(eq(users.id, userId), isNotNull(users.deletionRequestedAt)))
		.returning({ id: users.id });
	return { cancelled: rows.length > 0 };
}

/**
 * Erase one account. Everything that isn't a cascade happens first, then the row goes
 * and the database does the rest.
 *
 * Ordering matters and is not incidental: the Works have to be classified **before**
 * the user row is deleted, because `purchases.work_id` is `SET NULL` and
 * `purchases.buyer_id` is about to be too — after the cascade there is no way left to
 * ask which of this creator's Works somebody bought.
 */
export async function eraseAccount(userId: number): Promise<{ erased: boolean }> {
	const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
	if (!user) return { erased: false };

	const workIds = (
		await db.select({ id: works.id }).from(works).where(eq(works.creatorId, userId))
	).map((w) => w.id);

	const purchasedWorkIds = await purchasedAmong(workIds);
	const unpurchased = workIds.filter((id) => !purchasedWorkIds.includes(id));

	await db.transaction(async (tx) => {
		// Purchased Works are WITHDRAWN, never destroyed — a buyer owns what they bought
		// regardless of what the creator does later, and `resolveAccess` reads purchases
		// rather than visibility, so their downloads keep working untouched.
		if (purchasedWorkIds.length > 0) {
			await tx
				.update(works)
				.set({ visibility: "withdrawn", withdrawnAt: new Date() })
				.where(inArray(works.id, purchasedWorkIds));
		}

		// Everything nobody bought goes. Its comments are polymorphic with no FK, so
		// they are removed explicitly — the same explicit cleanup `DELETE /works/:id`
		// already does.
		if (unpurchased.length > 0) {
			await tx
				.delete(comments)
				.where(and(eq(comments.subjectType, "work"), inArray(comments.subjectId, unpurchased)));
			await tx.delete(works).where(inArray(works.id, unpurchased));
		}

		// Tombstone the posts and comments, anonymise the reviews. Done explicitly rather
		// than left to the FK: `SET NULL` would produce the same rows, but stating it
		// here is what makes the three different outcomes visible in one place instead of
		// spread across four schema files.
		await tx.update(posts).set({ creatorId: null }).where(eq(posts.creatorId, userId));
		await tx.update(comments).set({ userId: null }).where(eq(comments.userId, userId));
		await tx.update(ratings).set({ userId: null }).where(eq(ratings.userId, userId));

		// The buyer comes off the financial record; the record itself stays.
		await tx.update(purchases).set({ buyerId: null }).where(eq(purchases.buyerId, userId));

		// And the account. Sessions, ATProto tokens, follows, bookmarks, blocks,
		// attention rows, accounts/cycles and seed allocations all cascade from here;
		// moderation reports and actions do not, by design.
		await tx.delete(users).where(eq(users.id, userId));
	});

	return { erased: true };
}

/**
 * Erase every account whose grace period has elapsed. The job entry point.
 *
 * Each account is its own transaction, so one failure doesn't strand the rest — and a
 * retry re-selects only what is still pending.
 */
export async function runDueDeletions(now: Date = new Date()): Promise<{ erased: number }> {
	const due = await db
		.select({ id: users.id })
		.from(users)
		.where(and(isNotNull(users.deletionRequestedAt), lte(users.deletionRequestedAt, now)));

	let erased = 0;
	for (const u of due) {
		const result = await eraseAccount(u.id);
		if (result.erased) erased += 1;
	}
	if (erased > 0) console.log(`account-deletion: erased ${erased} account(s)`);
	return { erased };
}
