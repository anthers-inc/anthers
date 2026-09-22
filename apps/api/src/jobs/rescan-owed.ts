// SPDX-License-Identifier: Apache-2.0
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

import { objectsOwedScans, worksOwedScans } from "../services/safety-scan.js";
import { JOB_OPTIONS, QUEUES, queue } from "./queue.js";

/** Re-queue every owed object, in both senses. Returns how many jobs were sent. */
export async function rescanOwed(): Promise<number> {
	let sent = 0;

	for (const work of await worksOwedScans()) {
		for (const object of work.objects) {
			// `kind` travels with the key rather than being re-derived here: a video source
			// re-queued as an image would hash the container bytes, fail, and record the
			// video as permanently unscannable — a sweep undoing the coverage it exists to
			// restore.
			await queue.send(
				QUEUES.SCAN_MEDIA,
				{ storageKey: object.key, workId: work.id, kind: object.kind },
				JOB_OPTIONS[QUEUES.SCAN_MEDIA],
			);
			sent += 1;
		}
	}

	// The Work-less arm: badge art, avatars and every other upload that has no Work. Its
	// selection is the opposite of the one above — the row EXISTS here and is absent up
	// there — so one query cannot serve both and neither may borrow the other's. The
	// subject columns on the row are what lets a match on one of these quarantine rather
	// than log: without them the scanner would know something matched and nothing about
	// whose it was.
	for (const object of await objectsOwedScans()) {
		await queue.send(
			QUEUES.SCAN_MEDIA,
			{
				storageKey: object.storageKey,
				kind: object.kind,
				uploaderId: object.subject.uploaderId ?? null,
				objectKind: object.subject.objectKind ?? null,
			},
			JOB_OPTIONS[QUEUES.SCAN_MEDIA],
		);
		sent += 1;
	}
	return sent;
}
