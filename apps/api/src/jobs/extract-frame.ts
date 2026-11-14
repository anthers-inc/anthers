// SPDX-License-Identifier: Apache-2.0
/**
 * Take one frame out of a video Work's stored original and make it the thumbnail.
 *
 * **The act is queued because the decode does not belong in a request.** It used to run
 * inside the api component's handler, which made the creator's click wait on the whole
 * ffprobe + ffmpeg pass and ran the extraction's two threads on the api's single core. The
 * worker is the box ffmpeg's pin was sized for (`FFMPEG_THREADS` against two real dedicated
 * cores), so the route now only validates ownership, writes the ask and answers.
 *
 * The row in `work_thumbnail_frames` is the ask and its state; the creator's page polls it.
 * A failure is written there as the sentence the page shows, because a job that dies has no
 * response left to fail in.
 */

import { db } from "@anthers/db/client";
import { works, workThumbnailFrames } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { ffmpegCommand } from "../lib/ffmpeg.js";
import { probeVideo } from "../lib/video-frames.js";
import { storage } from "../services/storage/index.js";
import { queueScansForWork } from "./scan-media.js";

export interface ExtractFrameData {
	/** The `work_thumbnail_frames` row, re-read here so a duplicate delivery converges. */
	jobId: number;
}

/** A single-frame extraction reads only up to the paused moment and encodes one frame —
 *  seconds, not minutes. The timeout exists so a wedged reader (an unreachable storage
 *  address) fails the job instead of holding the worker. */
export const FRAME_EXTRACT_TIMEOUT_MS = 20_000;

/** What the creator is told when the take failed for a reason the job cannot name. */
const GENERIC_FAILURE = "Taking the frame didn't work. Upload an image instead.";

export async function extractFrame(data: ExtractFrameData): Promise<void> {
	const [job] = await db
		.select()
		.from(workThumbnailFrames)
		.where(eq(workThumbnailFrames.id, data.jobId))
		.limit(1);
	// A row that is gone (its Work was deleted) or already landed has nothing left to do.
	if (!job || job.status === "completed") return;

	await db
		.update(workThumbnailFrames)
		.set({ status: "processing", errorMessage: "", updatedAt: new Date() })
		.where(eq(workThumbnailFrames.id, job.id));

	let refusal: string | null = null;
	try {
		refusal = await extract(job.workId, job.atSeconds);
	} catch (error) {
		console.error(`[extract-frame] job ${job.id} failed:`, error);
		refusal = GENERIC_FAILURE;
	}

	await db
		.update(workThumbnailFrames)
		.set({
			status: refusal === null ? "completed" : "failed",
			errorMessage: refusal ?? "",
			updatedAt: new Date(),
		})
		.where(eq(workThumbnailFrames.id, job.id));
}

/**
 * The extraction itself: probe only where the clamp needs it, decode one frame, store it as
 * an uploaded thumbnail would be.
 *
 * Returns the sentence to show the creator on failure, or null when the frame landed.
 */
async function extract(workId: number, atSeconds: number): Promise<string | null> {
	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	if (!work) return "This Work is no longer here.";
	if (work.type !== "video" || !work.sourceKey) {
		return "This Work has no video to take a frame from.";
	}

	// The extraction reads the stored original in place — a fresh signed address;
	// `SOURCE_URL_TTL_SECONDS` in `routes/content.ts` carries the reasoning.
	const input = await storage.readableInput(work.sourceKey);
	let at = atSeconds;
	// The stored duration the transcode wrote stands for the file's length, at
	// whole-second precision. **Inside that duration, no probe runs**: the creator's
	// player bounds `at` to its own playback, so a mid-video moment is inside the file by
	// construction, and asking ffprobe over the stored original (two-plus ranged reads
	// this job waits behind) buys nothing. The probe still runs — with the exact duration
	// and fps the last-frame clamp needs — when the row carries no duration yet, and when
	// the asked moment reaches the stored rounding's last half second, where the
	// difference between the stored and exact bounds is what the clamp exists to hold.
	const storedDuration = work.durationSeconds ?? 0;
	if (!(storedDuration > 1) || atSeconds > storedDuration - 0.5) {
		// Read the duration straight from the stored original, so a paused moment past the
		// end (or a client claiming one) still lands inside the file — and past the last
		// DECODED frame, not merely inside the container: an input seek asks for frames
		// from the moment onward, so a moment past the last frame's own timestamp (an
		// ended video's pause is exactly its duration) yields nothing. One frame earlier
		// is the last displayable picture the file holds.
		const probe = await probeVideo(input);
		if (!probe) return "This file has no readable video to take a frame from.";
		const lastFrame =
			probe.durationSeconds - (probe.framesPerSecond > 0 ? 1 / probe.framesPerSecond : 0.5);
		at = Math.max(0, Math.min(at, Math.max(lastFrame, 0)));
	}

	// One frame into the pipe: input seeking (`-ss` before `-i`) stops ffmpeg reading past
	// the moment, and `image2pipe` keeps the JPEG on stdout rather than on the worker's
	// disk. `ffmpegCommand` pins the threads the plan is sized to (`lib/ffmpeg.ts`).
	const proc = Bun.spawn(
		ffmpegCommand(
			input,
			["-frames:v", "1", "-q:v", "2", "-f", "image2pipe", "-c:v", "mjpeg", "-"],
			["-v", "error", "-ss", at.toFixed(3)],
		),
		{ stdout: "pipe", stderr: "pipe", stdin: "ignore" },
	);
	const withTimeout = Promise.resolve(new Response(proc.stdout).arrayBuffer());
	let jpeg: ArrayBuffer;
	try {
		jpeg = await Promise.race([
			withTimeout,
			new Promise<never>((_, reject) =>
				setTimeout(() => {
					proc.kill();
					reject(new Error("extraction timed out"));
				}, FRAME_EXTRACT_TIMEOUT_MS).unref(),
			),
		]);
	} finally {
		await proc.exited;
	}
	if (jpeg.byteLength === 0) {
		return "No frame came out of that moment — try pausing somewhere a picture is showing.";
	}

	const uuid = crypto.randomUUID().replace(/-/g, "");
	const key = `creators/${work.creatorId}/thumbnails/${work.id}/${uuid}.jpg`;
	await storage.upload(key, Buffer.from(jpeg), "image/jpeg", "public");

	const url = await storage.getUrl(key);
	const [updated] = await db
		.update(works)
		// The extracted frame is a full image, so it is its own framing source.
		.set({ thumbnail: url, thumbnailSource: url, thumbnailCrop: null, updatedAt: new Date() })
		.where(eq(works.id, work.id))
		.returning();
	// New image bytes on the Work, even though they derive from a cleaned source.
	await queueScansForWork(updated);
	return null;
}
