// SPDX-License-Identifier: Apache-2.0
/**
 * The media lane's dispatch: one queue (`QUEUES.MEDIA`, single-file — see its comment)
 * carrying video transcodes and audio processes alike, and this is where a fetched job
 * becomes one of the two.
 *
 * The dispatch reads the row's own `mediaType` rather than a kind field on the job data,
 * so a job's payload stays `{ jobId }` for every type and adding a media type is an entry
 * in `DISPATCH` — the same shape `resume-orphans.ts` argued for when its ternary silently
 * misrouted the third media type. A row whose type maps to nothing is recorded failed with
 * the legible reason rather than thrown: an unprocessable row must not spend the queue's
 * retry budget re-reading itself forever.
 */

import { db } from "@anthers/db";
import { transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { processAudio } from "./process-audio.js";
import { refreshQueuePositions } from "./queue-position.js";
import { transcodeVideo } from "./transcode-video.js";

/** The lane's routing, exported so a test can assert the map's shape directly. */
export const DISPATCH: Record<string, ((jobId: number) => Promise<void>) | undefined> = {
	video: (jobId) => transcodeVideo({ jobId }),
	audio: (jobId) => processAudio({ jobId }),
};

export async function runMediaJob(jobId: number): Promise<void> {
	const [job] = await db
		.select({ mediaType: transcodingJobs.mediaType })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);

	// The claimed row leaves the queue (its position nulls) and the rest renumber —
	// before, not after, so the screen already reads the shift while the work runs.
	// Best-effort: a failed renumber must not cost a job its run; the write happens
	// again at the run's own settle below.
	try {
		await refreshQueuePositions();
	} catch (err) {
		console.error("[media] queue refresh failed (non-fatal):", err);
	}

	const run = DISPATCH[job.mediaType];
	if (!run) {
		const message = `TranscodingJob ${jobId} carries media type "${job.mediaType}", which the media lane does not process`;
		console.error(`[media] ${message}`);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message, updatedAt: new Date() })
			.where(eq(transcodingJobs.id, jobId));
		await refreshQueuePositions();
		return;
	}
	try {
		await run(jobId);
	} finally {
		// Settled — completed, failed or thrown — the row is out of the queue either way,
		// and the rows behind it renumber to say so.
		try {
			await refreshQueuePositions();
		} catch (err) {
			console.error("[media] queue refresh failed (non-fatal):", err);
		}
	}
}