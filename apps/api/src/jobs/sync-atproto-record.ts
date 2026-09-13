// SPDX-License-Identifier: Apache-2.0
/**
 * Bring the record for one row into line with the row — a creator's post or project, or a
 * reader's comment, review, vote or follow.
 *
 * 🚨 **A job rather than part of the request, and the reason is which failure is acceptable.**
 * Writing a record is a call to another server. Doing it inside the request would make posting a
 * comment or publishing a post fail when that server is down — coupling what somebody did on
 * Anthers to a network they may not care about, to accomplish something additive to what they
 * asked for. The comment posts; the record catches up.
 *
 * ⚠️ **The job carries a kind and an id, on purpose.** The service re-reads the row and decides
 * from its current state, so this is a hint that something moved rather than a description of
 * what — which means a duplicate job is harmless, a late job still converges, and a job enqueued
 * for the wrong reason costs one read.
 *
 * ⚠️ **It throws on a retryable failure**, because that is how pg-boss is told to try again. A
 * skip is not a failure and must not be retried.
 */

import { syncPostRecord, syncProjectRecord } from "../services/creator-record-listing.js";
import {
	syncCommentRecord,
	syncFollowRecord,
	syncReviewRecord,
	syncVoteRecord,
} from "../services/reader-record-listing.js";
import type { RecordSyncKind, RecordSyncResult } from "../services/record-sync.js";
import { isOrdinary } from "../services/repo-writer.js";

export interface SyncAtprotoRecordData {
	kind: RecordSyncKind;
	id: number;
}

type AnyResult = RecordSyncResult<unknown, string>;

/** Which service reads each kind's row. */
const SYNCERS: Record<RecordSyncKind, (id: number) => Promise<AnyResult>> = {
	post: syncPostRecord,
	project: syncProjectRecord,
	comment: syncCommentRecord,
	review: syncReviewRecord,
	vote: syncVoteRecord,
	follow: syncFollowRecord,
};

/**
 * Whether an outcome is worth a line in the worker log.
 *
 * ⭐ **Quiet about the ordinary, and the ordinary is most of it.** A plan that writes nothing —
 * a draft, a kept record, a schema not yet published — and an account with no identity or no
 * grant describe the great majority of syncs, and a vote is cast far more often than a Work is
 * released. Logging them would bury the lines that mean something: a write, a removal, and the
 * skips that say a server or a credential is broken.
 */
function isWorthSaying(result: AnyResult): boolean {
	if (result.status === "synced") {
		return result.plan.action !== "none" && result.plan.action !== "keep";
	}
	if (result.status === "skipped") {
		// ⚠️ **A row that is gone by the time its sync runs is quiet too.** Deleting a row is what
		// produces this, and a delete that needs a record taken down carries its own removal job —
		// so there is nothing left for the sync to do or to report. It is also most of what a local
		// worker sees: every end-to-end run enqueues syncs through the real API against the dev
		// database and then resets its fixtures, and the next `make dev` drains all of them.
		if (result.reason === "no_row") return false;
		return result.reason === "no_owner" || !isOrdinary(result.reason);
	}
	return true;
}

export async function syncAtprotoRecordJob(data: SyncAtprotoRecordData): Promise<void> {
	const sync = SYNCERS[data.kind];
	// A kind this build does not know is a job written by a newer or older one. Throwing would
	// retry it into the ground; saying so and dropping it is the only useful answer.
	if (!sync) {
		console.error(`[sync-atproto-record] unknown kind ${String(data.kind)} for ${data.id}`);
		return;
	}

	const result = await sync(data.id);

	if (result.status === "failed") {
		// Thrown so the queue retries. The stored URI was deliberately left alone by the service,
		// so a retry re-reads and re-decides rather than compounding a half-finished write.
		throw new Error(`${data.kind} ${data.id}: ${result.error}`);
	}
	if (!isWorthSaying(result)) return;

	if (result.status === "skipped") {
		console.log(`[sync-atproto-record] ${data.kind} ${data.id}: skipped (${result.reason})`);
		return;
	}
	const detail = result.plan.action === "invalid" ? ` (${result.plan.problem})` : "";
	console.log(
		`[sync-atproto-record] ${data.kind} ${data.id}: ${result.plan.action}${detail}` +
			`${result.uri ? ` → ${result.uri}` : ""}`,
	);
}
