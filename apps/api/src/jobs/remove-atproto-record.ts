// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Take a record off the network after the row that described it was deleted.
 *
 * 🚨 **Every skip here is logged, which is the opposite of the sibling jobs and is deliberate.**
 * `sync-work-listing` and `sync-creator-record` stay quiet about a creator with no identity and
 * no grant, because those describe most accounts and saying so on every job would train whoever
 * reads the log to skim. Nothing reaches this queue unless a record was known to exist, so
 * "there is no writer" here does not mean "this account never published" — it means a record
 * somebody published is still up and Anthers has just failed to take it down. That is worth a
 * line every single time.
 *
 * ⚠️ **It throws on a retryable failure**, because that is how pg-boss is told to try again, and
 * this is the queue where exhausting the retries is permanent: there is no row left for the
 * reconciling sweep to notice a disagreement about.
 */
import { removeAtprotoRecord } from "../services/atproto-record-removal.js";

export interface RemoveAtprotoRecordData {
	creatorId: number;
	collection: string;
	uri: string;
}

export async function removeAtprotoRecordJob(data: RemoveAtprotoRecordData): Promise<void> {
	const result = await removeAtprotoRecord(data);

	if (result.status === "failed") {
		throw new Error(`${data.uri}: ${result.error}`);
	}

	if (result.status === "skipped") {
		console.warn(`[remove-atproto-record] STRANDED ${data.uri}: ${result.reason}`);
		return;
	}

	console.log(`[remove-atproto-record] removed ${data.uri}`);
}
