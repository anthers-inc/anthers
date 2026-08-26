// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Scan one stored object against a detection vendor's known-material corpus.
 *
 * 🚨 **This cannot be a request-path gate, and that is an architectural fact rather than a
 * preference.** `POST /api/content/media-upload/direct` buffers bytes in the handler, but
 * `POST /api/content/media-upload/presign` hands the browser a presigned PUT and **the API
 * never sees the bytes** — and that is the path every real video, audio file and game
 * build takes in production. For that path the object exists in R2 before anything here
 * knows about it, so detection has to be a job keyed on the storage key, run once the key
 * is registered against a Work. Wiki 40.12 § *The ingest inventory* has the full asymmetry.
 *
 * ⚠️ **Failing is the correct outcome when a vendor is unreachable.** The job throws, pg-boss
 * retries it slowly, and the object stays unscanned in the meantime. The alternative —
 * swallowing the error — would write a row saying nothing matched, which is the difference
 * between "we asked and the answer was no" and "we never asked". Under 18 U.S.C. § 2258A(f)
 * there is no duty to search at all, so an unscanned object is not a compliance failure;
 * a *falsely* clean one is a lie in our own records.
 */

import { scanStoredImage } from "../services/safety-scan.js";

export interface ScanMediaData {
	/** The stored object to scan. */
	storageKey: string;
	/** The Work it belongs to, when it belongs to one. Null for profile images. */
	workId?: number | null;
}

export async function scanMedia(data: ScanMediaData): Promise<void> {
	const outcome = await scanStoredImage(data.storageKey, { workId: data.workId ?? null });

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
