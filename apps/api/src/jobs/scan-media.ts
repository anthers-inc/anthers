// SPDX-License-Identifier: Apache-2.0
/**
 * Scan one stored object against a detection vendor's known-material corpus.
 *
 * 🚨 **This cannot be a request-path gate, and that is an architectural fact rather than a
 * preference.** `POST /api/content/media-upload/direct` buffers bytes in the handler, but
 * `POST /api/content/media-upload/presign` hands the browser a presigned PUT and **the API
 * never sees the bytes** — and that is the path every real video, audio file and game
 * build takes in production. For that path the object exists in R2 before anything here
 * knows about it, so detection has to be a job keyed on the storage key, run once the key
 * is registered against a Work. the child-safety coverage map, which is deliberately not public § *The ingest inventory* has the full asymmetry.
 *
 * ⚠️ **Failing is the correct outcome when a vendor is unreachable.** The job throws, pg-boss
 * retries it slowly, and the object stays unscanned in the meantime. The alternative —
 * swallowing the error — would write a row saying nothing matched, which is the difference
 * between "we asked and the answer was no" and "we never asked". Under 18 U.S.C. § 2258A(f)
 * there is no duty to search at all, so an unscanned object is not a compliance failure;
 * a *falsely* clean one is a lie in our own records.
 */

import type { works } from "@anthers/db/schema";
import {
	beginScans,
	type ScannableKind,
	scanStoredImage,
	scanStoredVideo,
} from "../services/safety-scan.js";
import { JOB_OPTIONS, QUEUES, queue } from "./queue.js";

/**
 * Queue a scan for each of a Work's objects that has no answer yet, restarting its release
 * clock when anything is owed.
 *
 * 🚨 **Every writer that attaches an object to a Work calls this**, and there are two: the
 * content routes, when a file or a thumbnail arrives, and the video transcode, which attaches
 * the poster thumbnail it generates. The transcode used to write its thumbnail straight onto the
 * Work, so a released video's poster sat in the public bucket unscanned until the hourly
 * `rescan-owed` sweep found it. `beginScans` decides what is owed; the key set is the one the
 * release gate waits on, so it is never computed a second way.
 */
export async function queueScansForWork(work: typeof works.$inferSelect): Promise<void> {
	for (const object of await beginScans(work)) {
		await queue.send(
			QUEUES.SCAN_MEDIA,
			{ storageKey: object.key, workId: work.id, kind: object.kind },
			JOB_OPTIONS[QUEUES.SCAN_MEDIA],
		);
	}
}

export interface ScanMediaData {
	/** The stored object to scan. */
	storageKey: string;
	/** The Work it belongs to, when it belongs to one. Null for profile images. */
	workId?: number | null;
	/**
	 * How the object must be read. Defaults to `image`, which is what every job enqueued
	 * before video coverage existed carries — a payload with no `kind` is an image job from
	 * before this field, and defaulting the other way would decode avatars.
	 */
	kind?: ScannableKind;
}

export async function scanMedia(data: ScanMediaData): Promise<void> {
	const scan = data.kind === "video" ? scanStoredVideo : scanStoredImage;
	const outcome = await scan(data.storageKey, { workId: data.workId ?? null });

	// Logged only when it is not the ordinary answer. A line per clean scan would bury the
	// worker log, and this is a log somebody has to be able to read — the same reasoning
	// the escalation sweep states for staying quiet on a no-op.
	if (outcome.determination !== "clean") {
		// 🚨 The vendor's own classification is deliberately absent from this line. Shield
		// § 6(b)/(c) forbid Match Data reaching generative AI, and a worker log is read by
		// agents. Our determination is ours to print; theirs is not.
		console.log(
			`[scan-media] ${data.storageKey}: ${outcome.determination}${
				outcome.quarantine ? " (quarantined)" : ""
			}`,
		);
	}
}
