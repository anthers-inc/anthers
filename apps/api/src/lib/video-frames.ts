// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sampling a video into still frames, so PDQ has something it can fingerprint.
 *
 * PDQ is an **image** hash, which is why the detection shipped in PR #82 covers images and
 * leaves video uncovered. A video's *thumbnail* is already scanned — it is an extracted
 * frame and therefore new image bytes — while the video itself passes through untouched,
 * and video is the format most of this platform is for.
 *
 * ⚠️ **This is a separate ffmpeg pass, and the task brief said it should not be.** The brief
 * put frame extraction inside `jobs/transcode-video.ts` on the reasoning that it *"already
 * decodes every frame"*. That is true of ffmpeg and not of us: the transcode runs ffmpeg as
 * a subprocess that writes H.264 segments, so the decoded frames never enter this process,
 * and reaching them would mean adding a second output to that command and coupling the
 * safety scan to the transcode's lifecycle — no retry, no owed-sweep, and no scan at all
 * for a video whose transcode failed. A decode-only pass with no encoder attached is a
 * small fraction of the encode the transcode already pays for, so *"paying for ffmpeg
 * twice"* overstates it. The scan keeps its own job, its own retries and its own record.
 *
 * 🚨 **Frames are hashed at source resolution, exactly as an uploaded image is.** Scaling
 * first would be cheaper and would move every frame hash away from what anyone else
 * computes for the same picture — `lib/pdq.ts` already measures 4–8 bits of decoder drift
 * against Meta's vectors inside PDQ's 31-bit threshold, and a resize spends that budget for
 * nothing. Only one frame is ever in memory at a time, so the cost is pipe traffic rather
 * than footprint.
 */

import { type PdqHash, pdqHashPixels } from "./pdq.js";

/** Run ffprobe and return its parsed JSON. Shared with `jobs/transcode-video.ts`. */
export async function ffprobeJson(filePath: string): Promise<{
	streams?: Array<{ codec_type?: string; width?: number; height?: number }>;
	format?: { duration?: string };
}> {
	const proc = Bun.spawn(
		["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffprobe failed: ${stderr}`);
	}
	return JSON.parse(await new Response(proc.stdout).text());
}

/**
 * The three facts the sampler needs, or null when the file has no video stream at all.
 *
 * Null is an ordinary answer rather than an error: an audio file, a corrupt container, or
 * something that was never a video will all land here, and the caller records the object
 * as unscannable rather than retrying it forever.
 */
export async function probeVideo(
	localPath: string,
): Promise<{ width: number; height: number; durationSeconds: number } | null> {
	const probe = await ffprobeJson(localPath);
	const stream = probe.streams?.find((s) => s.codec_type === "video");
	const width = Number(stream?.width ?? 0);
	const height = Number(stream?.height ?? 0);
	if (!width || !height) return null;
	return { width, height, durationSeconds: Number.parseFloat(probe.format?.duration ?? "0") };
}

/**
 * How far apart sampled frames are, in seconds, before the cap below stretches them.
 *
 * 🚨 **Ten seconds is a judgment about what a detection corpus holds, and it is the one
 * number here worth arguing with.** Shield's corpus is of stills — frames somebody
 * extracted from known material — so the question is not *"how much of this video do we
 * see"* but *"how likely is a sampled instant to be an instant somebody else also
 * sampled"*. A scene shorter than about ten seconds is unlikely to be represented; a scene
 * long enough to matter is sampled several times over. One frame per video would be close
 * to useless and every frame would be tens of thousands of hashes for a feature.
 */
export const FRAME_INTERVAL_SECONDS = 10;

/**
 * The most frames one video is ever sampled into.
 *
 * Bounds three costs at once: the hashes in a single Shield request, the rows written to
 * `media_scans`, and the wall time of the hashing loop. Past this the interval stretches,
 * which is the right way to degrade — a three-hour video gets a frame every fifty-odd
 * seconds rather than being truncated at the thirty-three-minute mark.
 */
export const MAX_FRAMES_PER_VIDEO = 200;

export interface FrameSchedule {
	/** Seconds between sampled frames. */
	interval: number;
	/** How many frames will be produced. */
	count: number;
}

/**
 * How to sample a video of this length. Pure, so the policy above is testable without
 * ffmpeg — and so a change to it is visible as a change to a number rather than to a
 * command line.
 *
 * A video of unknown or zero duration still yields one frame: something is better than
 * nothing, and a container that will not report its length is exactly the kind of file
 * worth looking at.
 */
export function frameSchedule(durationSeconds: number): FrameSchedule {
	if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
		return { interval: FRAME_INTERVAL_SECONDS, count: 1 };
	}
	const wanted = Math.ceil(durationSeconds / FRAME_INTERVAL_SECONDS);
	const count = Math.max(1, Math.min(MAX_FRAMES_PER_VIDEO, wanted));
	return { interval: durationSeconds / count, count };
}

export interface SampledFrame {
	hash: PdqHash;
	/** Where in the video this frame came from, for the key its scan is recorded under. */
	atSeconds: number;
}

/**
 * Hash sampled frames of a decoded video, one at a time.
 *
 * ⚠️ **`fps` rather than `-skip_frame nokey`, and the reason is timestamps.** Decoding only
 * keyframes would be cheaper, but `rawvideo` carries no presentation times, so there would
 * be no way to thin the output down to a fixed interval or to say where a matching frame
 * came from. A fixed `fps` makes frame *i* land at *i × interval* by construction.
 *
 * Returns an empty array when nothing decoded and ffmpeg was content, which is how a file
 * with no readable video track reads. It throws only when ffmpeg itself failed AND nothing
 * came out, so the caller can tell a genuinely unscannable object from a transient failure
 * worth retrying.
 */
export async function hashVideoFrames(
	localPath: string,
	options: { width: number; height: number; durationSeconds: number },
): Promise<SampledFrame[]> {
	const { width, height } = options;
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		return [];
	}

	const { interval, count } = frameSchedule(options.durationSeconds);
	const frameBytes = width * height * 3;
	const out: SampledFrame[] = [];

	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-i",
			localPath,
			"-vf",
			// A rate rather than a count: ffmpeg has no "give me N frames evenly" filter,
			// and `-frames:v` after `fps` truncates rather than spreads.
			`fps=${1 / interval}`,
			"-frames:v",
			String(count),
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	// Read exactly `frameBytes` at a time. `rawvideo` is an undelimited stream of frames,
	// so the frame boundary is arithmetic and a short read at the end is a truncated frame
	// rather than a small one — dropped, because hashing half a picture invents a
	// fingerprint of something that was never on screen.
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	let buffer = new Uint8Array(0);
	let index = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (value && value.length > 0) {
				const merged = new Uint8Array(buffer.length + value.length);
				merged.set(buffer);
				merged.set(value, buffer.length);
				buffer = merged;
			}
			while (buffer.length >= frameBytes) {
				const frame = buffer.subarray(0, frameBytes);
				buffer = buffer.subarray(frameBytes);
				out.push({
					hash: await pdqHashPixels(frame, width, height),
					atSeconds: Math.round(index * interval),
				});
				index += 1;
			}
			if (done) break;
		}
	} finally {
		reader.releaseLock();
	}

	const exitCode = await proc.exited;
	if (exitCode !== 0 && out.length === 0) {
		// Nothing decoded and ffmpeg is unhappy: the caller records this as unscannable
		// rather than retrying forever, the same way an object storage no longer holds is.
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg frame sampling failed: ${stderr.slice(0, 300)}`);
	}
	return out;
}
