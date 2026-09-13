// SPDX-License-Identifier: Apache-2.0
/**
 * Bring a Work's public listing on the network into line with the Work.
 *
 * 🚨 **A job rather than part of the request, and the reason is which failure is acceptable.**
 * Writing a record is a call to another server. Doing it inside the release request would make
 * releasing a Work fail when that server is down — coupling a creator's publishing to a network
 * they may not care about, to accomplish something that is additive to what they asked for. The
 * release succeeds; the listing catches up.
 *
 * ⚠️ **The job carries an id and nothing else, on purpose.** `syncWorkListing` re-reads the Work
 * and decides from its current state, so this is a hint that something moved rather than a
 * description of what — which means a duplicate job is harmless, a late job still converges, and
 * a job enqueued for the wrong reason costs one read.
 *
 * ⚠️ **It throws on a retryable failure**, because that is how pg-boss is told to try again. A
 * skipped Work — no hosted identity, no creator — is not a failure and must not be retried; it
 * is the ordinary case and returns quietly.
 */
import { isOrdinary } from "../services/repo-writer.js";
import type { ListingSyncResult } from "../services/work-listing.js";
import { syncWorkListing } from "../services/work-listing.js";

export interface SyncWorkListingData {
	workId: number;
}

/**
 * The skip reasons nobody needs to read about. `no_creator` is not among them.
 *
 * ⚠️ **`no_work` is**: a Work deleted before its sync ran has nothing left to sync, and the delete
 * path is what takes a listing down. It is also most of what a local worker sees — every
 * end-to-end run enqueues syncs through the real API against the dev database and then resets
 * its fixtures, and the next `make dev` drains all of them.
 */
function isQuiet(reason: Extract<ListingSyncResult, { status: "skipped" }>["reason"]): boolean {
	return reason === "no_work" || (reason !== "no_creator" && isOrdinary(reason));
}

export async function syncWorkListingJob(data: SyncWorkListingData): Promise<void> {
	const result = await syncWorkListing(data.workId);

	if (result.status === "failed") {
		// Thrown so the queue retries. The stored URI was deliberately left alone by the service,
		// so a retry re-reads and re-decides rather than compounding a half-finished write.
		throw new Error(`work ${data.workId}: ${result.error}`);
	}

	if (result.status === "skipped") {
		// ⭐ Logged at all only because a sweep reading these is how somebody would notice the
		// node being unreachable for everybody at once. The ordinary reasons — no identity, no
		// grant — are deliberately quiet: between them they are the majority of accounts, and
		// saying anything about them would train whoever reads these to skim.
		if (!isQuiet(result.reason)) {
			console.log(`[sync-work-listing] ${data.workId}: skipped (${result.reason})`);
		}
		return;
	}

	console.log(
		`[sync-work-listing] ${data.workId}: ${result.plan.action}${result.uri ? ` → ${result.uri}` : ""}`,
	);
}
