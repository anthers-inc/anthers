// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account deletion — scheduled, cancellable, and honest about what survives.
 *
 * The largest of the Privacy Policy's promises and the one most directly downstream of Article
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
 *    a change of mind is recoverable. Canceling clears one column.
 * 3. **No hoarding.** The delay is a grace period, **not an archive**. Nothing may
 *    start retaining data *because* a deletion is pending, nothing extends the window,
 *    and when it elapses the wipe runs.
 *
 * The safety lives in that flow rather than in the foreign keys, which is the whole
 * reasoning behind the ruling — a cascade used as a substitute for consent and a
 * cancel window is a constraint doing a product's job.
 *
 * **What deletion actually means, per table.** Privacy Policy sets these out and they are not
 * uniform, because the tables genuinely differ. The legal frame that makes it
 * tractable: erasure is not absolute and runs to *personal data*, not to every
 * artifact, so it is often satisfied by **severing the identity link** rather than
 * destroying content.
 *
 * | What | Outcome | Why |
 * |:--|:--|:--|
 * | profile, sessions, ATProto link, follows, bookmarks, blocks, attention rows | **destroyed** (FK cascade) | purely this person's |
 * | comments, posts | **tombstoned** — author nulled, content stays | a thread full of holes is worse for everyone still in it, and deleting a post takes third parties' comments with it |
 * | reviews | **anonymized** — score stays, author nulled | a bare 1–5 is the least personal thing here, and removing it moves a creator's average through no fault of theirs |
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
 * **Buyers of a withdrawn Work are now told** (2026-08-10). This was the shortfall the
 * deletion work shipped with and then closed: a creator leaving withdraws Works other
 * people paid for, and until the notification path existed those buyers found out by
 * noticing, or not at all. The notice is `essential` — it is about something they paid
 * for — and is keyed per purchase so it is sent exactly once.
 */

import { db } from "@anthers/db/client";
import {
	atprotoSessions,
	comments,
	posts,
	purchases,
	ratings,
	sessions,
	users,
	works,
} from "@anthers/db/schema";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { revokeAtprotoGrant } from "./atproto-client.js";
import { isUnderHold } from "./legal-hold.js";
import { addUserImages, collectWorkMedia, sweepCollected } from "./media-purge.js";
import { notifyMany } from "./notifications.js";

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
export async function cancelDeletion(userId: number): Promise<{ canceled: boolean }> {
	const rows = await db
		.update(users)
		.set({ deletionRequestedAt: null })
		.where(and(eq(users.id, userId), isNotNull(users.deletionRequestedAt)))
		.returning({ id: users.id });
	return { canceled: rows.length > 0 };
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
	// 🚨 The hold check is FIRST, before anything is read or swept, because every line
	// below this destroys something. A filed CyberTipline report is itself a one-year
	// preservation request under 18 U.S.C. § 2258A(h), and destroying records under a
	// hold is a federal crime under § 1519 — so the collision between this function and
	// that obligation is not a policy question, it is this `if`.
	//
	// **Deferred rather than canceled.** `deletionRequestedAt` is deliberately left
	// alone, so the daily sweep re-selects this account and erases it the day the hold
	// lifts. A user who asked to be forgotten is still owed that; what they are not
	// owed is destruction of evidence in the meantime, and the privacy policy has to
	// say so rather than promise a deletion this can silently refuse.
	if (await isUnderHold("user", userId)) {
		console.warn(`account-deletion: user ${userId} is under a legal hold — deletion deferred`);
		return { erased: false };
	}

	const [user] = await db
		.select({
			id: users.id,
			avatar: users.avatar,
			headerImage: users.headerImage,
			// Read here because it is about to cascade away, and a DID we no longer hold is a
			// grant we can never find to revoke.
			atprotoDid: users.atprotoDid,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) return { erased: false };

	// 🚨 **Revoke the ATProto grant BEFORE the account goes, and after the hold check.**
	// Erasure deleted the `atproto_sessions` row by cascade and stopped until 2026-08-29, so
	// somebody who asked to be forgotten was left with a live OAuth authorization on their
	// Bluesky account pointing at an Anthers that no longer held anything — and with the row
	// gone, nothing on our side could find it to try again. That is precisely the outcome
	// `unlinkAtprotoFromUser` orders its two steps to avoid, and it matters more here: an
	// unlink is somebody tidying a connection they can see and redo, while an erasure is
	// somebody being promised there are no loose ends.
	//
	// ⚠️ **Best-effort and non-fatal**, which is what `revokeAtprotoGrant` guarantees. A
	// revocation that fails must never leave an account undeleted — a third party's outage is
	// not a reason to refuse somebody their erasure.
	//
	// It sits *after* the hold guard on purpose. A held account returns above with
	// `erased: false` and stays intact, so revoking first would break the identity link of an
	// account that is still very much alive.
	//
	// ⭐ **The other two ATProto tables were checked and need nothing, which is worth stating
	// so it is not re-derived.** `atproto_oauth_state` holds an in-flight authorization keyed
	// by an opaque `key`, with the linking user id inside its jsonb `appState` — a row still
	// in flight at erasure resolves to a user who is gone, the callback refuses it, and the
	// TTL sweep takes the row. `pending_signups` carries a DID but no user id at all: a row
	// holding this DID is a *different*, unfinished signup rather than anything of this
	// account's, and `clearPendingSignup` already revokes the session behind one when it is
	// abandoned. Neither is a live grant we would otherwise lose track of, which is the test.
	if (user.atprotoDid) await revokeAtprotoGrant(user.atprotoDid);

	const workIds = (
		await db.select({ id: works.id }).from(works).where(eq(works.creatorId, userId))
	).map((w) => w.id);

	const purchasedWorkIds = await purchasedAmong(workIds);
	const unpurchased = workIds.filter((id) => !purchasedWorkIds.includes(id));

	// Enumerated BEFORE the wipe, for the same reason the buyer list is: this reads
	// `works`, `assets` and `transcoding_jobs`, and the transaction is about to delete
	// them — run it after and it finds nothing and silently sweeps nothing, which is
	// exactly the failure this closes (until 2026-08-12 account deletion made no
	// object-storage calls at all, so a deleted profile's avatar stayed publicly
	// downloadable forever).
	//
	// 🚨 ONLY the unpurchased Works. A purchased one is *withdrawn*, not destroyed —
	// the buyer still downloads it, and `resolveAccess` reads purchases rather than
	// visibility, so sweeping its media would break an entitlement we promise survives
	// the creator leaving.
	const mediaToSweep = addUserImages(await collectWorkMedia(unpurchased), user);

	// Collected BEFORE the wipe: `purchases.buyer_id` survives, but the Work rows and
	// the join back to them are about to change under us, and a buyer we failed to
	// enumerate is a buyer who never learns their purchase was withdrawn.
	const buyersToTell =
		purchasedWorkIds.length > 0
			? (
					await db
						.select({
							purchaseId: purchases.id,
							buyerId: purchases.buyerId,
							workTitle: purchases.workTitle,
						})
						.from(purchases)
						.where(
							and(inArray(purchases.workId, purchasedWorkIds), eq(purchases.status, "completed")),
						)
				).filter(
					(r): r is { purchaseId: number; buyerId: number; workTitle: string } =>
						// A buyer who deleted their own account first has nobody to notify.
						r.buyerId != null && r.workTitle != null,
				)
			: [];

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

		// Tombstone the posts and comments, anonymize the reviews. Done explicitly rather
		// than left to the FK: `SET NULL` would produce the same rows, but stating it
		// here is what makes the three different outcomes visible in one place instead of
		// spread across four schema files.
		await tx.update(posts).set({ creatorId: null }).where(eq(posts.creatorId, userId));
		await tx.update(comments).set({ userId: null }).where(eq(comments.userId, userId));
		await tx.update(ratings).set({ userId: null }).where(eq(ratings.userId, userId));

		// The buyer comes off the financial record; the record itself stays.
		await tx.update(purchases).set({ buyerId: null }).where(eq(purchases.buyerId, userId));

		// 🚨 The ATProto session goes by DID as well as by cascade, and the second delete is
		// not redundant. `atproto_sessions` is keyed by DID because the SDK's session store is
		// addressed by the token subject and knows nothing about Anthers accounts — so the row
		// is written at the OAuth callback, *before* there is an account, and `user_id` is
		// nullable and reconciled afterwards. A row whose reconciliation never happened
		// carries this person's live tokens and cascades from nothing at all.
		if (user.atprotoDid) {
			await tx.delete(atprotoSessions).where(eq(atprotoSessions.did, user.atprotoDid));
		}

		// And the account. Sessions, ATProto tokens, follows, bookmarks, blocks,
		// attention rows, accounts/cycles and seed allocations all cascade from here;
		// moderation reports and actions do not, by design.
		await tx.delete(users).where(eq(users.id, userId));
	});

	// Told AFTER the transaction commits, never inside it. A notification is an
	// unsendable-back side effect: emailing "your purchase was withdrawn" and then
	// rolling the withdrawal back would be a lie we cannot retract. Doing it after
	// means a crash here loses the notice rather than inventing one, and losing it is
	// the failure worth preferring.
	if (buyersToTell.length > 0) {
		await notifyMany(
			buyersToTell.map((b) => ({
				userId: b.buyerId,
				category: "essential" as const,
				kind: "work_withdrawn_creator_left",
				title: `“${b.workTitle}” has been withdrawn`,
				body: "The creator closed their Anthers account. You still own this and it stays in your library — but it is no longer publicly available, so download a copy if you want one you keep.",
				linkPath: "/library",
				// Per purchase, so two people who bought the same Work each get told, and
				// neither gets told twice.
				dedupeKey: `work-withdrawn:${b.purchaseId}`,
			})),
		);
	}

	// Swept AFTER the transaction commits, and deliberately not inside it: destroying a
	// creator's media for a deletion that then rolled back is unrecoverable, while a crash
	// between commit and sweep merely strands objects a later pass can find. Same trade the
	// notification above makes, for the same reason — prefer losing the side effect to
	// performing one the database never agreed to.
	await sweepCollected(mediaToSweep);

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
