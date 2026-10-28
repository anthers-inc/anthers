// SPDX-License-Identifier: Apache-2.0
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
 * | profile, sessions, ATProto link, follows, saved items, blocks, attention rows | **destroyed** (FK cascade) | purely this person's |
 * | comments, posts | **tombstoned** — author nulled, content stays | a thread full of holes is worse for everyone still in it, and deleting a post takes third parties' comments with it |
 * | reviews | **destroyed** — verdict and text | a review is this person's written opinion, and an anonymous one nobody wrote any more is not honest to keep counting (Parker, 2026-09-13) |
 * | Works nobody kept | **destroyed** | nothing depends on them |
 * | Works somebody kept — saved, or bought (a purchase saves itself) | **withdrawn** | a save or a purchase outlives the Work |
 * | purchases | **buyer detached, row kept** | sales-tax remittance records; settled 2026-08-10 |
 * | moderation reports & actions | **kept, actor nulled** | after a `DELETE`, "why was my comment removed?" has no honest answer |
 * | a handle Anthers issued | **emptied on the node** | the records and the address are Anthers'; the DID is in a public directory nothing deletes from |
 *
 * 🚨 **Hosting made this a promise about three places rather than two** (2026-09-08). Before
 * the handle door, everything personal lived in one database and one object store and this
 * function covered both. An account issued a handle has a second account on the identity
 * server carrying the same address, plus a repository — so the job grew a third step, and
 * without it the wipe would run while a live account with that person's address went on
 * existing on a machine Anthers operates. `releaseHostedIdentities` is that step, and
 * `services/hosted-accounts.ts` carries what it can and cannot reach.
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
	reviews,
	userSessions,
	users,
	works,
} from "@anthers/db/schema";
import { and, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { revokeAtprotoGrant } from "./atproto-client.js";
import { clearSavedBillingAddress } from "./billing.js";
import { unlinkAccount } from "./discord.js";
import { escapeHtml, sendOperationalAlert } from "./email.js";
import { hostedHandlesFor, isHostedIdentity, releaseHostedIdentities } from "./hosted-accounts.js";
import { isUnderHold } from "./legal-hold.js";
import { addUserImages, collectWorkMedia, sweepCollected } from "./media-purge.js";
import { notifyMany } from "./notifications.js";
import { hasPreservedVersion } from "./preservation.js";
import { queueWorkListingSync, takeDownCreatorRecords } from "./work-listing.js";

/**
 * How long a user has to change their mind.
 *
 * Long enough that a deletion made in anger or by mistake is recoverable the next day,
 * short enough that it cannot be mistaken for retention. Parker's steer was "at least a
 * day or two"; seven days survives a week away from the computer without becoming an
 * archive.
 */
export const DELETION_GRACE_DAYS = 7;

/**
 * How long an AT Protocol export stands as "you have a copy" for the deletion gate.
 *
 * Seven days matches the grace period: an export taken when the person started thinking about
 * leaving is still the copy they had in hand when they confirmed. Older than that and the
 * question is worth asking again, because a space can have changed since.
 */
export const EXPORT_FRESH_DAYS = 7;

/** Whether an export timestamp is recent enough to let a deletion through without a bypass. */
export function isFreshExport(exportedAt: Date | null, now: Date = new Date()): boolean {
	if (!exportedAt) return false;
	return now.getTime() - exportedAt.getTime() <= EXPORT_FRESH_DAYS * 24 * 60 * 60 * 1000;
}

export interface DeletionPreview {
	/** Destroyed outright — including reviews, which carry the person's written verdict and
	 * are destroyed with it rather than tombstoned (the table at the top of this file). */
	follows: number;
	/** Saved Works, Projects and posts — the Library, destroyed with the account. */
	savedItems: number;
	blocks: number;
	viewingEvents: number;
	sessions: number;
	reviews: number;
	/** Kept, with the author removed. */
	comments: number;
	posts: number;
	/** Works split by whether anybody kept them — saved to a Library, or bought. */
	worksDeleted: number;
	worksWithdrawn: number;
	/** Kept with the buyer detached, for tax records. */
	purchases: number;
	/**
	 * Handles Anthers issued to this account, which are emptied rather than destroyed.
	 *
	 * 🚨 **Named rather than counted, because this is the one outcome somebody might want to
	 * avoid by doing something else first.** Every other line here describes something only
	 * Anthers holds; an identity can be moved to another server and kept, and a person who
	 * finds that out afterwards has lost something they could have taken with them.
	 */
	hostedHandles: string[];
	/**
	 * The last AT Protocol bundle, and whether it is recent enough to stand as the copy.
	 *
	 * 🚨 **This is the difference between a deletion that is recoverable elsewhere and one
	 * that is not.** The bundle carries the public repository and every space; deleting
	 * without one destroys the actor store and leaves the DID in the directory with nothing
	 * behind it. The gate refuses without a fresh bundle or an explicit bypass.
	 */
	exportedAt: string | null;
	hasRecentExport: boolean;
	/** Registered spaces, which deletion destroys with the identity. */
	spaces: number;
}

/**
 * Real counts from this account, for the confirmation screen.
 *
 * The point of consent being *informed* is that the numbers are theirs. "Your content
 * will be deleted" is a sentence people click past; "3 Works deleted, 1 withdrawn
 * because somebody saved it, 14 comments tombstoned" is a decision.
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

	const keptWorkIds = await keptAmong(workIds);

	const [
		follows_,
		savedItems_,
		blocks_,
		viewing,
		sessions_,
		comments_,
		reviews_,
		posts_,
		purchases_,
		handles,
		spaces_,
		exportRow,
	] = await Promise.all([
		countRows("follows", "follower_id"),
		countRows("user_library_items", "user_id"),
		countRows("user_blocks", "blocker_id"),
		countRows("attention_events", "user_id"),
		countRows("user_sessions", "user_id"),
		countRows("comments", "user_id"),
		countRows("reviews", "user_id"),
		countRows("posts", "creator_id"),
		countRows("purchases", "buyer_id"),
		hostedHandlesFor(userId),
		countRows("user_spaces", "user_id"),
		db
			.select({ atprotoExportedAt: users.atprotoExportedAt })
			.from(users)
			.where(eq(users.id, userId))
			.limit(1),
	]);

	const exportedAt = exportRow[0]?.atprotoExportedAt ?? null;

	return {
		follows: follows_,
		savedItems: savedItems_,
		blocks: blocks_,
		viewingEvents: viewing,
		sessions: sessions_,
		comments: comments_,
		reviews: reviews_,
		posts: posts_,
		worksDeleted: workIds.length - keptWorkIds.length,
		worksWithdrawn: keptWorkIds.length,
		purchases: purchases_,
		hostedHandles: handles,
		spaces: spaces_,
		exportedAt: exportedAt ? exportedAt.toISOString() : null,
		hasRecentExport: isFreshExport(exportedAt),
	};
}

/**
 * Which of these Works Anthers keeps — the ones with a preserved version.
 *
 * 🚨 **The question is preservation, not the purchase count** (Parker, 2026-10-25). A purchase
 * saves itself to the Library and a save is what sets the flag, so every sold Work is in
 * here; so is a free Work somebody saved, which this path used to destroy. The derivation is
 * `hasPreservedVersion` in `services/preservation.ts`, shared with the withdrawn-Work sweep,
 * so account deletion cannot keep a Work the sweep would purge or purge one the sweep keeps.
 *
 * Shared by the preview and the erase so the confirmation screen cannot promise one outcome
 * and the job deliver another — "3 deleted, 1 withdrawn" has to be the same classification
 * that runs a week later.
 */
async function keptAmong(workIds: number[]): Promise<number[]> {
	if (workIds.length === 0) return [];
	const rows = await db
		.select({ id: works.id })
		.from(works)
		.where(and(inArray(works.id, workIds), hasPreservedVersion));
	return rows.map((r) => r.id);
}

export type DeletionRequestResult =
	| { ok: true; scheduledFor: string }
	| { ok: false; reason: "export_required"; exportedAt: string | null };

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
 *
 * 🚨 **A fresh bundle or an explicit bypass, and neither is inferred.** The bundle carries
 * the public repository and every space; a raw delete destroys the actor store and leaves the
 * DID in the directory with nothing behind it. The refusal names the timestamp so the screen
 * can say how old the copy is rather than only that there is none.
 */
export async function requestDeletion(
	userId: number,
	opts: { bypassExport?: boolean } = {},
): Promise<DeletionRequestResult> {
	const [row] = await db
		.select({ atprotoExportedAt: users.atprotoExportedAt })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const exportedAt = row?.atprotoExportedAt ?? null;
	if (!opts.bypassExport && !isFreshExport(exportedAt)) {
		return {
			ok: false,
			reason: "export_required",
			exportedAt: exportedAt ? exportedAt.toISOString() : null,
		};
	}

	const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
	await db.transaction(async (tx) => {
		await tx.update(users).set({ deletionRequestedAt: scheduledFor }).where(eq(users.id, userId));
		await tx.delete(userSessions).where(eq(userSessions.userId, userId));
	});
	return { ok: true, scheduledFor: scheduledFor.toISOString() };
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
export async function eraseAccount(
	userId: number,
): Promise<{ erased: boolean; strandedRecords?: number }> {
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

	// The Discord link and its roles leave before the row does. They are the only thing about
	// this account that lives outside this database, and deleting the row first would strand
	// them with nothing left to identify the member. Erasure never waits on Discord: the
	// service swallows a failed removal and the link is gone either way.
	await unlinkAccount(userId, { revokeMembershipRole: true });

	const [user] = await db
		.select({
			id: users.id,
			avatar: users.avatar,
			bannerImage: users.bannerImage,
			// Read here because it is about to cascade away, and a DID we no longer hold is a
			// grant we can never find to revoke.
			atprotoDid: users.atprotoDid,
		})
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	if (!user) return { erased: false };

	// Asked before the identity server is reached, because releasing a hosted identity takes the
	// row this reads — after it, a hosted DID would look like one held somewhere else.
	const heldElsewhere = user.atprotoDid !== null && !(await isHostedIdentity(user.atprotoDid));

	// 🚨 **The identity server is reached BEFORE anything is destroyed, and this step can stop
	// the whole erasure.** `hosted_accounts.user_id` is `set null` rather than `cascade`, so
	// after the wipe nothing joins a person to the identities Anthers issued them — the same
	// ordering hazard as the Works classification below, and with a worse failure, because the
	// thing that would be stranded is a live account holding their address on a machine Anthers
	// operates.
	//
	// ⚠️ **Deferring is right here and would be wrong one paragraph down.** The grant revoke is
	// best-effort because a third party's outage must not refuse somebody their erasure. This
	// is not a third party. An unreachable node is Anthers failing to finish its own job, and
	// the answer is the one the legal hold already uses: leave `deletionRequestedAt` set, so
	// the daily sweep re-selects this account and tries again, and destroy nothing meanwhile.
	//
	// A credential the hub cannot open is the opposite case and must not defer — retrying never
	// opens it, and blocking an erasure forever on an unusable key is worse than finishing and
	// saying loudly that a shell was left behind.
	const released = await releaseHostedIdentities(userId);
	if (released.status === "deferred") {
		console.warn(
			`account-deletion: user ${userId} holds an Anthers-issued identity the node did not ` +
				`release — deletion deferred (${released.reason})`,
		);
		return { erased: false };
	}
	if (released.status === "stranded") {
		console.error(
			`account-deletion: user ${userId} is being erased with an Anthers-issued identity ` +
				`LEFT ON THE NODE — the hub cannot open it and only the node's admin password can ` +
				`now reach it (${released.reason})`,
		);
	}

	// 🚨 **Revoke the ATProto grant BEFORE the account goes, and after the hold check.**
	// Erasure deleted the `atproto_sessions` row by cascade and stopped until 2026-08-29, so
	// somebody who asked to be forgotten was left with a live OAuth authorization on their
	// Bluesky account pointing at an Anthers that no longer held anything — and with the row
	// gone, nothing on our side could find it to try again. An erasure is somebody being
	// promised there are no loose ends, so the revocation has to happen while the row still
	// says where to send it.
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
	//
	// 🚨 **A creator's records come down first, while that grant can still remove them.** For an
	// identity held somewhere else, the Work listings, posts and projects Anthers wrote live in a
	// repository Anthers does not operate, and the grant being revoked on the next line is the
	// only thing that can delete them. Revoking first would leave somebody who asked to be
	// forgotten advertised on the network for good. A hosted identity needs nothing here: its
	// repository, and every record in it, went with `releaseHostedIdentities` above.
	//
	// ⚠️ **A record that cannot be reached does not stop the erasure**, unlike `stopPublishingFor`,
	// which keeps the grant so a retry can finish. A third party's outage is not a reason to
	// refuse somebody their erasure, so what could not be removed is reported to the operators by
	// address — there is nobody else left to tell — and the erasure goes on.
	let strandedRecords = 0;
	if (heldElsewhere) {
		const takedown = await takeDownCreatorRecords(userId);
		strandedRecords = takedown.strandedUris.length;
		if (strandedRecords > 0) {
			console.error(
				`account-deletion: user ${userId} erased with ${strandedRecords} record(s) still on ` +
					"the network, which Anthers could not remove",
			);
			await sendOperationalAlert({
				subject: `An erased account left ${strandedRecords} record(s) on the network`,
				html:
					"<p>An account was erased and these records Anthers published on its behalf could " +
					"not be removed. The erasure went ahead; the grant that could have removed them has " +
					"now been revoked.</p><ul>" +
					takedown.strandedUris.map((uri) => `<li>${escapeHtml(uri)}</li>`).join("") +
					"</ul>",
			});
		}
	}
	if (user.atprotoDid) await revokeAtprotoGrant(user.atprotoDid);

	// 🚨 **The saved billing address is cleared from Stripe BEFORE the wipe**, because the
	// wipe is what erases the `stripe_customers` row that knows which customer to clear —
	// after it, the promise "deleting your account clears the saved address from Stripe"
	// would be unkeepable by anybody. The policy line (Privacy Policy, *What we collect*)
	// commits Anthers to exactly this, so a Stripe failure DEFERS the deletion the same
	// way `releaseHostedIdentities` defers on the node: the sweep re-selects the account
	// tomorrow and tries again. "None" is the ordinary buyer who saved nothing — the
	// clear is a no-op for them, which is the point of the one-Customer posture.
	const cleared = await clearSavedBillingAddress(userId);
	if (cleared === "failed") {
		console.warn(
			`account-deletion: Stripe would not clear user ${userId}'s saved billing address — deletion deferred`,
		);
		return { erased: false };
	}

	const workIds = (
		await db.select({ id: works.id }).from(works).where(eq(works.creatorId, userId))
	).map((w) => w.id);

	const keptWorkIds = await keptAmong(workIds);
	const unkept = workIds.filter((id) => !keptWorkIds.includes(id));

	// Enumerated BEFORE the wipe, for the same reason the buyer list is: this reads
	// `works`, `work_assets` and `work_transcoding_jobs`, and the transaction is about to delete
	// them — run it after and it finds nothing and silently sweeps nothing, which is
	// exactly the failure this closes (until 2026-08-12 account deletion made no
	// object-storage calls at all, so a deleted profile's avatar stayed publicly
	// downloadable forever).
	//
	// 🚨 ONLY the unkept Works. A kept one is *withdrawn*, not destroyed — a buyer still
	// downloads it and a saver still opens it, and `resolveAccess` reads purchases rather
	// than visibility, so sweeping its media would break an entitlement we promise
	// survives the creator leaving.
	const mediaToSweep = addUserImages(await collectWorkMedia(unkept), user);

	// Collected BEFORE the wipe: `purchases.buyer_id` survives, but the Work rows and
	// the join back to them are about to change under us, and a buyer we failed to
	// enumerate is a buyer who never learns their purchase was withdrawn. A Work kept
	// only by savers contributes nothing here — there is no purchase to find and nobody
	// to tell.
	const buyersToTell =
		keptWorkIds.length > 0
			? (
					await db
						.select({
							purchaseId: purchases.id,
							buyerId: purchases.buyerId,
							workTitle: purchases.workTitle,
						})
						.from(purchases)
						.where(and(inArray(purchases.workId, keptWorkIds), eq(purchases.status, "completed")))
				).filter(
					(r): r is { purchaseId: number; buyerId: number; workTitle: string } =>
						// A buyer who deleted their own account first has nobody to notify.
						r.buyerId != null && r.workTitle != null,
				)
			: [];

	await db.transaction(async (tx) => {
		// Kept Works are WITHDRAWN, never destroyed — a Work somebody saved or bought
		// outlives its creator, and `resolveAccess` reads purchases rather than
		// visibility, so a buyer's downloads keep working untouched.
		if (keptWorkIds.length > 0) {
			await tx
				.update(works)
				.set({ visibility: "withdrawn", withdrawnAt: new Date() })
				.where(inArray(works.id, keptWorkIds));
			// ⚠️ **Enqueued while the credential still exists**, which is the whole reason it is
			// here rather than left to the sweep. `releaseHostedIdentities` has already run by
			// the time this transaction commits, so the repository these listings live in is
			// about to become unreachable — the sync has to happen now or the records stay up
			// with nothing able to remove them.
			for (const workId of keptWorkIds) void queueWorkListingSync(workId);
		}

		// Everything nobody kept goes. Its comments are polymorphic with no FK, so
		// they are removed explicitly — the same explicit cleanup `DELETE /works/:id`
		// already does.
		if (unkept.length > 0) {
			await tx
				.delete(comments)
				.where(and(eq(comments.subjectType, "work"), inArray(comments.subjectId, unkept)));
			await tx.delete(works).where(inArray(works.id, unkept));
		}

		// Tombstone the posts and comments, delete the reviews. Done explicitly rather than
		// left to the FKs, which would produce the same rows: stating it here is what makes the
		// different outcomes visible in one place instead of spread across four schema files.
		await tx.update(posts).set({ creatorId: null }).where(eq(posts.creatorId, userId));
		await tx.update(comments).set({ userId: null }).where(eq(comments.userId, userId));
		await tx.delete(reviews).where(eq(reviews.userId, userId));

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

		// And the account. Sessions, ATProto tokens, follows, saved items, blocks,
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
				body: "The creator closed their Anthers account. You still own this and it stays in your library — Anthers keeps it available, so there is nothing you need to do.",
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

	return { erased: true, strandedRecords };
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
