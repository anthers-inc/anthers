// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { syncWorkListing } from "../services/work-listing.js";

export interface SyncWorkListingData {
	workId: number;
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
		// node being unreachable for everybody at once. `not_hosted` is deliberately quiet: it is
		// the majority case and saying anything about it would train whoever reads these to skim.
		if (result.reason !== "not_hosted") {
			console.log(`[sync-work-listing] ${data.workId}: skipped (${result.reason})`);
		}
		return;
	}

	console.log(
		`[sync-work-listing] ${data.workId}: ${result.plan.action}${result.uri ? ` → ${result.uri}` : ""}`,
	);
}
