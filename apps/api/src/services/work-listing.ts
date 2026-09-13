// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Keeping a Work's public listing on the network in step with the Work.
 *
 * `atproto-repo.ts` decides what should happen to a listing and carries it out against any
 * repository; this module is what connects that to an actual Work, an actual creator, and the
 * column that remembers where the record went. It is the only writer of `works.atproto_uri`.
 *
 * 🚨 **It re-reads the Work rather than being told what changed, and that is the design.**
 * Publishability is decided by four things — released, withdrawn, taken down, quarantined —
 * written by four different services, and a version of this that took "what happened" as an
 * argument would need every one of those call sites to describe the transition correctly and
 * for ever. Reading the current state makes every call idempotent: running it twice is
 * harmless, running it late still converges, and a caller that fires it for the wrong reason
 * costs nothing. **The enqueue is a hint that something moved, never a description of what.**
 *
 * 🚨 **A listing that outlives the thing it advertises is the failure this is shaped around.**
 * A record is public the moment it lands and deleting it afterwards broadcasts only the
 * deletion, so the delete path matters more than the create path: a Work that stops being
 * publicly listed must have its record REMOVED rather than merely skipped. That decision is
 * `planWorkRecord`'s and is tested without a network; what this adds is making sure the
 * decision is actually reached whenever the Work moves.
 *
 * ⚠️ **A creator with no repository Anthers may write into is the ordinary case.** Nothing is
 * written, nothing is logged as a problem, and nothing about publishing changes for them.
 * Anthers turns nobody away for lacking a handle and asks nobody for a network permission in
 * order to publish, and this module is one of the places that could quietly make either a
 * requirement if it treated their absence as a failure.
 */
import { db } from "@anthers/db";
import { users, works } from "@anthers/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { recordGrantedScope, revokeAtprotoGrant } from "./atproto-client.js";
import {
	RepoAuthError,
	rkeyFromAtUri,
	syncWorkRecord,
	WORK_COLLECTION,
	type WorkRecordPlan,
} from "./atproto-repo.js";
import { publishedCreatorRecords, removePublishedCreatorRecord } from "./creator-record-listing.js";
import { type NoCreatorWriterReason, writerForCreator } from "./repo-writer.js";

/** What syncing one Work's listing did. */
export type ListingSyncResult =
	/** The record was created, replaced, deleted, or correctly left alone. */
	| { status: "synced"; plan: WorkRecordPlan; uri: string | null }
	/** No listing is possible or needed, for a reason that is nobody's fault. */
	| { status: "skipped"; reason: NoCreatorWriterReason | "no_work" | "no_creator" }
	/** Something worth retrying went wrong. The job wrapper decides what to do about it. */
	| { status: "failed"; error: string };

/** Where a Work's public page lives, which the record points at. */
function baseUrl(): string {
	return process.env.FRONTEND_URL?.trim() || "https://anthers.org";
}

/**
 * Bring one Work's listing into line with the Work.
 *
 * ⚠️ **The row is read inside this call rather than passed in**, for the reason in the module
 * note: a stale snapshot is exactly how a withdrawn Work keeps its listing. The caller supplies
 * an id and nothing else.
 */
export async function syncWorkListing(
	workId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<ListingSyncResult> {
	const [work] = await db
		.select({
			id: works.id,
			creatorId: works.creatorId,
			type: works.type,
			title: works.title,
			description: works.description,
			slug: works.slug,
			publicId: works.publicId,
			releasedAt: works.releasedAt,
			visibility: works.visibility,
			takedownStatus: works.takedownStatus,
			quarantineStatus: works.quarantineStatus,
			// Needed by `unpublishableReason` through `AccessibleWork`. Selected rather than cast
			// past: the compiler checking this shape is what stops a missing column from becoming
			// a record that silently lies about the Work.
			maturity: works.maturity,
			streamEnabled: works.streamEnabled,
			downloadEnabled: works.downloadEnabled,
			seedAccess: works.seedAccess,
			atprotoUri: works.atprotoUri,
		})
		.from(works)
		.where(eq(works.id, workId))
		.limit(1);
	if (!work) return { status: "skipped", reason: "no_work" };

	// A Work whose creator deleted their account was withdrawn rather than destroyed, so its
	// buyers keep it — and there is no repository to write into. The withdrawal already means
	// no listing should exist; a record left behind is cleaned up by whichever sync ran while
	// the creator was still there.
	if (work.creatorId === null) return { status: "skipped", reason: "no_creator" };

	const opened = await writerForCreator(work.creatorId, opts);
	if (!opened.writer) return { status: "skipped", reason: opened.reason };

	try {
		const outcome = await syncWorkRecord(opened.writer, work, {
			baseUrl: baseUrl(),
			existingUri: work.atprotoUri,
		});

		// ⚠️ **Written only when it changed, and cleared with an explicit null.** The column is
		// unique, so writing the same URI back is harmless but pointless; what matters is that a
		// delete clears it, because a stale URI would make the next sync try to replace a record
		// that is gone and create an orphan.
		if (outcome.uri !== work.atprotoUri) {
			await db.update(works).set({ atprotoUri: outcome.uri }).where(eq(works.id, workId));
		}
		return { status: "synced", plan: outcome.plan, uri: outcome.uri };
	} catch (err) {
		// 🚨 **A withdrawn permission is not a failure to retry, and the stored URI still stays.**
		// The creator took the grant back, so trying again cannot succeed until they give it
		// again — but the record they already have is still on the network, and the column is the
		// only thing that remembers where. Clearing it would strand that record permanently;
		// keeping it means the first sync after a re-grant can still take the listing down.
		if (err instanceof RepoAuthError) {
			await recordGrantedScope(err.did, null);
			console.warn(`[work-listing] ${workId}: the creator's grant was refused — ${err.message}`);
			return { status: "skipped", reason: "grant_lost" };
		}

		// 🚨 The stored URI is deliberately left as it was. If the write failed we do not know
		// what landed, and forgetting where a record might be is how a duplicate listing gets
		// created on the retry.
		const error = err instanceof Error ? err.message : String(err);
		console.error(`[work-listing] ${workId}: ${error}`);
		return { status: "failed", error };
	}
}

/**
 * Ask for a Work's listing to be brought back into line, soon.
 *
 * ⭐ **Call this whenever a Work's publishability MIGHT have moved, without working out
 * whether it did.** The job re-reads and decides, so a spurious enqueue costs one database
 * read and a duplicate costs nothing — which is deliberately cheaper than asking every call
 * site to reason about transitions it does not otherwise care about. Under-calling is the
 * expensive mistake here, not over-calling.
 *
 * ⚠️ **Never throws.** Every caller is in the middle of something a creator or an operator
 * asked for — releasing, withdrawing, taking down, quarantining — and none of those may fail
 * because a queue was briefly unavailable. A listing that missed its enqueue is caught by the
 * reconciling sweep; a release that failed because of one is a creator's afternoon.
 */
export async function queueWorkListingSync(workId: number): Promise<void> {
	try {
		const { queue, QUEUES, JOB_OPTIONS } = await import("../jobs/queue.js");
		await queue.send(QUEUES.SYNC_WORK_LISTING, { workId }, JOB_OPTIONS[QUEUES.SYNC_WORK_LISTING]);
	} catch (err) {
		console.error(
			`[work-listing] could not enqueue a sync for ${workId}: ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Ask for every one of a creator's Works to be reconsidered.
 *
 * ⭐ **What a creator granting permission should look like is their catalog appearing**, not
 * their next release appearing and the rest of their work staying invisible until they happen
 * to edit it. Each Work still decides for itself: the ones that should not be listed are the
 * ones `planWorkRecord` answers `none` for, and nothing here second-guesses that.
 *
 * Returns how many were queued, which is a count of Works rather than of records — most of
 * them will turn out to need nothing.
 */
export async function queueAllListingsFor(creatorId: number): Promise<number> {
	const rows = await db.select({ id: works.id }).from(works).where(eq(works.creatorId, creatorId));
	for (const row of rows) await queueWorkListingSync(row.id);
	return rows.length;
}

/** What stopping a creator's publishing managed to do. */
export interface StopPublishingResult {
	/** Records taken off the network — Work listings, posts and projects together. */
	removed: number;
	/** Records that could not be removed, and are therefore still out there. */
	stranded: number;
	/** Whether the permission was given back. False whenever anything was stranded. */
	revoked: boolean;
}

/**
 * Take everything Anthers has published for a creator off the network and give their permission
 * back.
 *
 * 🚨 **The records come down BEFORE the grant goes back, and the order is the whole point.**
 * Deleting a record requires the permission being handed in, so revoking first would strand
 * every record permanently — advertising Works to a network Anthers can no longer reach, with
 * no way for the creator to correct it short of finding their own tooling. This is the same
 * shape as the revoke-before-delete rule on local rows, arrived at from the opposite side: do
 * the thing that needs the credential while the credential is still good.
 *
 * 🚨 **ALL THREE record types, not just Works.** Withdrawing the permission is a creator saying
 * "stop writing on my behalf", and answering it by taking their Work listings down while their
 * posts and projects stay up would honor the letter of the request and none of its point. This
 * is the one place that has to know the full set, which is why it is worth the extra query even
 * for the majority of creators who have none.
 *
 * ⚠️ **Anything stranded cancels the revocation.** Keeping a permission the creator asked to
 * withdraw is the lesser harm, because it is the only state from which a retry can finish the
 * job. The caller is told, and asking again is what fixes it.
 *
 * ⚠️ **Only records Anthers knows about can be removed.** The `atproto_uri` columns are the
 * entire memory of where records went; one written by something else, or one whose column was
 * lost, is not reachable from here and is not counted.
 */
export async function stopPublishingFor(creatorId: number): Promise<StopPublishingResult> {
	const [listed, creatorRecords] = await Promise.all([
		db
			.select({ id: works.id, uri: works.atprotoUri })
			.from(works)
			.where(and(eq(works.creatorId, creatorId), isNotNull(works.atprotoUri))),
		publishedCreatorRecords(creatorId),
	]);

	let removed = 0;
	let stranded = 0;
	const total = listed.length + creatorRecords.length;

	if (total > 0) {
		const opened = await writerForCreator(creatorId);
		if (!opened.writer) {
			// No writer means no way to reach the records. They stay where they are, and saying so
			// is more useful than a revocation that would make it permanent.
			console.warn(`[work-listing] cannot stop publishing for ${creatorId}: ${opened.reason}`);
			return { removed: 0, stranded: total, revoked: false };
		}

		for (const work of listed) {
			const rkey = work.uri ? rkeyFromAtUri(work.uri, WORK_COLLECTION) : null;
			if (!rkey) {
				// An unreadable URI is counted as stranded rather than skipped: something is on the
				// network that this column was meant to be able to find.
				stranded += 1;
				continue;
			}
			try {
				await opened.writer.deleteRecord(WORK_COLLECTION, rkey);
				await db.update(works).set({ atprotoUri: null }).where(eq(works.id, work.id));
				removed += 1;
			} catch (err) {
				stranded += 1;
				console.error(
					`[work-listing] could not remove the listing for ${work.id}: ` +
						`${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// The same writer, deliberately: these records live in the same repository, and opening a
		// second one would double the work for no gain and give the two halves separate ways to fail.
		for (const record of creatorRecords) {
			if (await removePublishedCreatorRecord(opened.writer, record)) removed += 1;
			else stranded += 1;
		}
	}

	if (stranded > 0) return { removed, stranded, revoked: false };

	const [row] = await db
		.select({ did: users.atprotoDid })
		.from(users)
		.where(eq(users.id, creatorId))
		.limit(1);
	if (row?.did) {
		await revokeAtprotoGrant(row.did);
		await recordGrantedScope(row.did, null);
	}
	return { removed, stranded: 0, revoked: true };
}
