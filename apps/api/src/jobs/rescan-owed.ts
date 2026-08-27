// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-ask the detection vendor about the objects whose scan never came back.
 *
 * ⭐ **This is what keeps "the scan is still owed" from being a figure of speech.** Two
 * mechanisms hand work to it, and neither can finish the job alone. `scan-media` throws when
 * the vendor is unreachable and pg-boss retries it five times over twenty-five minutes, after
 * which the job is gone and nothing has been recorded. Release gives way after two minutes so
 * that a vendor outage does not stop everyone on Anthers from publishing. Between them, an
 * image uploaded during an outage would be released, never scanned, and never asked about
 * again — a gate that closes only when it did not need to.
 *
 * ⚠️ **It re-sends rather than recording anything.** `media_scans` still gets its row from
 * the one writer that produces one, so a re-ask that finds a match quarantines exactly as a
 * first-time scan would. All this decides is *which* objects to ask about, and it decides that
 * by looking for the absence of an answer rather than for the presence of a failure — the
 * failure may have happened in a worker process that no longer exists.
 */

import { worksOwedScans } from "../services/safety-scan.js";
import { JOB_OPTIONS, QUEUES, queue } from "./queue.js";

/** Re-queue every owed object. Returns how many jobs were sent. */
export async function rescanOwed(): Promise<number> {
	const owed = await worksOwedScans();
	let sent = 0;
	for (const work of owed) {
		for (const storageKey of work.keys) {
			await queue.send(
				QUEUES.SCAN_MEDIA,
				{ storageKey, workId: work.id },
				JOB_OPTIONS[QUEUES.SCAN_MEDIA],
			);
			sent += 1;
		}
	}
	return sent;
}
