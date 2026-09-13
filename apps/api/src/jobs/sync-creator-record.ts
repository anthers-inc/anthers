// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bring the record describing a creator's post or project into line with the row.
 *
 * 🚨 **A job rather than part of the request, and the reason is which failure is acceptable.**
 * Writing a record is a call to another server. Doing it inside the publish request would make
 * publishing a post fail when that server is down — coupling a creator's writing to a network
 * they may not care about, to accomplish something that is additive to what they asked for. The
 * post goes live; the record catches up.
 *
 * ⚠️ **The job carries a kind and an id, on purpose.** The service re-reads the row and decides
 * from its current state, so this is a hint that something moved rather than a description of
 * what — which means a duplicate job is harmless, a late job still converges, and a job enqueued
 * for the wrong reason costs one read.
 *
 * ⚠️ **It throws on a retryable failure**, because that is how pg-boss is told to try again. A
 * skipped row — no hosted identity, no grant, no row at all — is not a failure and must not be
 * retried; it is the ordinary case and returns quietly.
 */
import type {
	CreatorRecordKind,
	CreatorRecordSyncResult,
} from "../services/creator-record-listing.js";
import { syncPostRecord, syncProjectRecord } from "../services/creator-record-listing.js";
import { isOrdinary } from "../services/repo-writer.js";

export interface SyncCreatorRecordData {
	kind: CreatorRecordKind;
	id: number;
}

/** The skip reasons nobody needs to read about. `no_row` and `no_creator` are not among them. */
function isQuiet(
	reason: Extract<CreatorRecordSyncResult<unknown>, { status: "skipped" }>["reason"],
): boolean {
	return reason !== "no_row" && reason !== "no_creator" && isOrdinary(reason);
}

export async function syncCreatorRecordJob(data: SyncCreatorRecordData): Promise<void> {
	const result =
		data.kind === "post" ? await syncPostRecord(data.id) : await syncProjectRecord(data.id);

	if (result.status === "failed") {
		// Thrown so the queue retries. The stored URI was deliberately left alone by the service,
		// so a retry re-reads and re-decides rather than compounding a half-finished write.
		throw new Error(`${data.kind} ${data.id}: ${result.error}`);
	}

	if (result.status === "skipped") {
		// ⭐ Logged at all only because a sweep reading these is how somebody would notice a node
		// being unreachable for everybody at once. The ordinary reasons — no identity, no grant —
		// are deliberately quiet: between them they are the majority of accounts, and saying
		// anything about them would train whoever reads these to skim.
		if (!isQuiet(result.reason)) {
			console.log(`[sync-creator-record] ${data.kind} ${data.id}: skipped (${result.reason})`);
		}
		return;
	}

	console.log(
		`[sync-creator-record] ${data.kind} ${data.id}: ${result.plan.action}` +
			`${result.uri ? ` → ${result.uri}` : ""}`,
	);
}
