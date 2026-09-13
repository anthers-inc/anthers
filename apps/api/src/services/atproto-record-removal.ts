// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Taking a record off the network when the row that described it has gone.
 *
 * 🚨 **This is the one path that cannot re-read anything, and the asymmetry is the point.**
 * Everywhere else an enqueue is a hint: the job re-reads the row and decides from its current
 * state, which is what makes a duplicate harmless and a late job still correct. A deleted post,
 * project or comment has no row left to read, so the choice is not between a hint and a
 * description — it is between carrying the address and leaving a record on the network for ever,
 * advertising something that no longer exists. This job therefore carries what to do rather than
 * that something moved, and everything it needs has to be captured BEFORE the delete.
 *
 * ⚠️ **Deleting a record that is already gone is a success.** `com.atproto.repo.deleteRecord`
 * is specified to be idempotent, so a retry after a half-finished attempt finishes the job
 * rather than failing it. That is what lets the retry budget be generous, which it should be:
 * an orphaned record is the failure this whole design is shaped around.
 *
 * ⚠️ **It is deliberately not specific to a creator's own records.** A reader's comments,
 * reviews and votes are deleted outright too, and they will strand exactly the same way. One
 * primitive means one delete path, and the delete path is the one that matters.
 */
import { RepoAuthError, rkeyFromAtUri } from "./atproto-repo.js";
import { type NoCreatorWriterReason, writerForCreator } from "./repo-writer.js";

/** What removing one orphaned record did. */
export type RecordRemovalResult =
	/** The record is off the network, or was already. */
	| { status: "removed" }
	/** Nothing could be removed, for a reason retrying will not change. */
	| { status: "skipped"; reason: NoCreatorWriterReason | "unreadable_uri" }
	/** Something worth retrying went wrong. The job wrapper decides what to do about it. */
	| { status: "failed"; error: string };

/**
 * Remove one record from the repository it was written into.
 *
 * ⚠️ **The repository is chosen from the account rather than from the URI.** The address names
 * the repository the record actually went into, and a writer opened for the account is the only
 * credential Anthers holds — so if those two ever disagreed, writing into the one named by a
 * stored string would be the worse of the two mistakes.
 */
export async function removeAtprotoRecord(args: {
	creatorId: number;
	collection: string;
	uri: string;
	fetchImpl?: typeof fetch;
}): Promise<RecordRemovalResult> {
	const rkey = rkeyFromAtUri(args.uri, args.collection);
	// Refused rather than guessed at. A URI this cannot parse is a record somebody has to go and
	// find by hand, and saying so is more useful than a removal that silently removed nothing.
	if (!rkey) return { status: "skipped", reason: "unreadable_uri" };

	const opened = await writerForCreator(args.creatorId, { fetchImpl: args.fetchImpl });
	if (!opened.writer) return { status: "skipped", reason: opened.reason };

	try {
		await opened.writer.deleteRecord(args.collection, rkey);
		return { status: "removed" };
	} catch (err) {
		// 🚨 **A withdrawn grant is named rather than retried.** Trying again cannot succeed until
		// the creator grants permission again, and a retry loop against a revoked grant achieves
		// nothing except hiding the revocation from the person who could fix it. The record stays
		// on the network, which is exactly what `stopPublishingFor` calls stranded.
		if (err instanceof RepoAuthError) return { status: "skipped", reason: "grant_lost" };
		return { status: "failed", error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Ask for an orphaned record to be taken down, soon.
 *
 * 🚨 **Read the address off the row before the row goes, whichever side of the delete this call
 * ends up on.** Everything the job needs lives on the row — which account to open a repository
 * for, and where the record went — and once the row is gone there is no way to recover either.
 * A delete route may capture it with a `SELECT` first or read it back out of the delete's own
 * `RETURNING`; what it may never do is go looking for it afterwards.
 *
 * ⚠️ **Never throws, and that is a real trade rather than a formality.** A creator deleting
 * their own post must not fail because a queue blinked, so a lost enqueue is preferred to a
 * failed delete — but unlike every other queue here, nothing sweeps up afterwards, because the
 * row a sweep would compare against is exactly what has gone. A lost enqueue here is a record
 * that stays on the network. It is logged loudly for that reason.
 */
export async function queueRecordRemoval(args: {
	creatorId: number;
	collection: string;
	uri: string;
}): Promise<void> {
	try {
		const { queue, QUEUES, JOB_OPTIONS } = await import("../jobs/queue.js");
		await queue.send(QUEUES.REMOVE_ATPROTO_RECORD, args, JOB_OPTIONS[QUEUES.REMOVE_ATPROTO_RECORD]);
	} catch (err) {
		console.error(
			`[record-removal] ORPHANED: ${args.uri} could not be queued for removal — ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
