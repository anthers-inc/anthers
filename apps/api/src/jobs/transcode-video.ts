// SPDX-License-Identifier: Apache-2.0
/**
 * Video transcoding job: converts uploaded video to adaptive HLS.
 *
 * Ported from _legacy/backend/content/tasks.py transcode_video()
 *
 * Flow:
 * 1. Probe the source with ffprobe for resolution/duration — read in place, never downloaded
 * 1b. The ingest three-way (wiki 70.06's accepted set): refuse a codec pair the pipeline
 *     cannot deliver (`-c copy` remuxes what the pair's native container does take), accept
 *     a file already in it, and land the remuxed original beside the uploaded one, re-pointing
 *     the Work at it and queueing its scan like any other attach
 * 2. Determine variants based on source height (480p, 720p, 1080p)
 * 3. Transcode the ladder in two passes, uploading and freeing each pass's files the
 *    moment it finishes: the smallest rung alone (the publish-early gate opens on it),
 *    then every taller rung plus the audio-only rendition sharing one decode
 *    (`ffmpegSharedHls`). A one-rung source keeps the rendition in a pass of its own.
 * 4. Generate master playlist
 * 5. Upload the master playlist (the rest is uploaded per step 3)
 * 6. Update TranscodingJob status throughout
 *
 * ⭐ **The tall rungs share one decode, and that is what makes the ladder cheaper**
 * (measured 2026-10-19 on the same real 1080p source as the preset benchmark: 480p 59 s,
 * 720p 98 s, 1080p 138 s and the audio pass 4 s one after another, 299 s total; the
 * smallest rung alone then 720p+1080p+audio from one decode, 241 s — a 19% saving with
 * the first rung still publishing at ~63 s). A single decode feeding every rung including
 * the smallest would save 30%, but all outputs finish together, which forfeits the
 * playable-at-the-first-rung gate that landed the day before; the split keeps that gate.
 *
 * The per-pass upload is a disk constraint, not an ordering preference: the worker's
 * filesystem is ephemeral and small, and the platform replaces a container whose disk
 * fills — silently, with no line the app can log. Holding the whole output beside a
 * whole source is how a burst of uploads bounced this worker every few minutes. The
 * shared pass holds the tall rungs together (~265 MB for a five-minute 1080p source),
 * which is the one residency this design accepts and the price of the shared decode.
 *
 * 🚨 **The source is read in place, every pass minting its own short-lived address**
 * (`storage.readableInput`): a signed ranged-read URL in remote mode, the object's own
 * path locally, and ffprobe and ffmpeg take either. No temp copy of the source exists,
 * so a job's residency is bounded by one variant's segments, briefly — nothing a source
 * file of any size adds to it. Each pass mints fresh rather than sharing one URL minted
 * at job start, because the sign window then covers the longest single read, not the
 * longest job.
 *
 * It takes no poster from the video: its creator chooses the thumbnail, and release waits for it.
 *
 * **One encode per job, enforced in the database.** `transcodeVideo` runs under
 * `withTranscodeLock` — a session-level advisory lock a re-delivered job waits on rather
 * than encoding beside the first handler — and `ensureStillOurs` re-reads the row before
 * every upload and the completion write, so a run that has outlived its own delivery
 * abandons quietly instead of planting a second ladder over the finisher's. The expiry
 * sizing this design assumes is `JOB_OPTIONS[QUEUES.MEDIA]` in `queue.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { FFMPEG_THREADS, ffmpegCommand } from "../lib/ffmpeg.js";
import {
	classifyVideoStreams,
	type DeliverableContainer,
	remuxedContentType,
	remuxedKeyFor,
} from "../lib/video-remux.js";
import { storage } from "../services/storage/index.js";
import { withAdvisoryLock } from "./advisory-lock.js";
import { MAX_TRANSCODE_RESUMES } from "./resume-orphans.js";
import { queueScansForWork } from "./scan-media.js";
import {
	createEtaClamp,
	remainingEncodeSeconds,
	remainingSharedPassSeconds,
} from "./transcode-eta.js";

export interface TranscodeVideoData {
	jobId: number;
}

// ── The one-encode lock ─────────────────────────────────────────────────
//
// 🚨 **One encode per TranscodingJob, enforced in the database rather than the process.**
// pg-boss v12 fails a job whose handler runs past `expireInSeconds` and re-delivers it,
// and nothing kills the abandoned handler or its ffmpeg child — so absent a lock a
// re-delivery encodes the same source a second time, beside the first. That happened:
// `JOB_OPTIONS[QUEUES.MEDIA]` in `queue.ts` carries the 2026-10-11 measurement of one
// long source encoded twice in full. `localConcurrency: 1` cannot be the guard, because
// the expiry path frees the worker's local slot while the orphaned handler is still
// running — the semaphore counts fetch batches, and a re-delivery is a new fetch.
//
// A session-level advisory lock survives every shape of this: a re-delivery waits here
// while the first handler finishes, then re-reads the row and skips what it already
// completed; if the worker process dies, the lock dies with its session and the boot
// recovery re-sends the job. The key is namespaced above serial id space so nothing
// else in the application can collide with it.
export const TRANSCODE_LOCK_KEY_BASE = 9_000_000_000_000;

/**
 * Run `fn` holding the TranscodingJob's advisory lock, waiting while another handler
 * holds it. The waiting mechanics are the shared `withAdvisoryLock` in
 * `./advisory-lock.ts`; the key namespace is this job's own. Takes `pollMs` because a
 * test needs waiting to be fast.
 */
export function withTranscodeLock<T>(
	jobId: number,
	fn: () => Promise<T>,
	pollMs?: number,
): Promise<T> {
	return withAdvisoryLock(
		TRANSCODE_LOCK_KEY_BASE + jobId,
		`[transcode-video] job ${jobId}`,
		fn,
		pollMs,
	);
}

/**
 * How long one pass's signed source address stays valid. A pass is one variant's decode,
 * or the probe — minutes at network speed for any source the caps allow; if one outlives
 * the window the job fails at a storage refusal and the queue retries it, which is
 * ordinary and visible rather than a slow decay.
 */
const SOURCE_URL_TTL_SECONDS = 60 * 60;

interface Variant {
	name: string;
	height: number;
	bitrate: string;
	bandwidth: number;
	width: number;
}

/**
 * The ladder a source gets encoded to, in **encoding order — smallest first**.
 *
 * ⭐ The order is the delivery story now (`publish-early`, 2026-10-18): the ladder is
 * encoded rung-cheapest-first and the release gate opens at the first rung, so a
 * creator's video goes playable while the tall rungs still fill in behind it. The
 * master playlist is rewritten as each rung lands, so the player's ABR grows rather
 * than appearing at the end.
 *
 * A source's ladder is capped at its own resolution (a 720p source never gets an
 * invented 1080p rung — upscaling is a lie the player would pay for in bandwidth), and
 * 480p always exists: the floor every player falls to. Widths derive from the source's
 * own aspect ratio, rounded to even.
 */
export function planLadderFor(sourceHeight: number, sourceWidth: number): Variant[] {
	const variants: Variant[] = [];
	if (sourceHeight >= 1080) {
		variants.push({
			name: "1080p",
			height: 1080,
			bitrate: "5000k",
			bandwidth: 5000000,
			width: 1920,
		});
	}
	if (sourceHeight >= 720) {
		variants.push({
			name: "720p",
			height: 720,
			bitrate: "2500k",
			bandwidth: 2500000,
			width: 1280,
		});
	}
	variants.push({
		name: "480p",
		height: 480,
		bitrate: "1000k",
		bandwidth: 1000000,
		width: 854,
	});

	// Correct widths using source aspect ratio
	if (sourceHeight > 0) {
		const aspect = sourceWidth / sourceHeight;
		for (const v of variants) {
			v.width = Math.round((v.height * aspect) / 2) * 2;
		}
	}
	// The rungs were declared tall-first and are encoded small-first now: reverse in
	// place, smallest first, so the first thing a creator's video delivers is the first
	// thing a viewer needs.
	variants.reverse();
	return variants;
}

/** Run ffprobe on a local path or a network address and return parsed JSON metadata */
async function ffprobe(source: string) {
	const proc = Bun.spawn(
		["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", source],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffprobe failed: ${stderr}`);
	}
	const stdout = await new Response(proc.stdout).text();
	return JSON.parse(stdout);
}

/**
 * Pipe ffmpeg's `-progress pipe:1` output into `onTick` as (encoded position, speed).
 *
 * Detached on purpose: the caller awaits the process, and this reader keeps draining what
 * ffmpeg buffered even after the exit resolves. The caller's own reporting flag is what
 * stops those late ticks from writing to the row.
 */
function streamFfmpegProgress(
	stdout: ReadableStream<Uint8Array> | null | undefined,
	onTick?: (outTimeSec: number, speed: number) => void,
) {
	if (!onTick || !stdout) return;
	void (async () => {
		const reader = stdout.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		let speed = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				for (const line of lines) {
					const eq = line.indexOf("=");
					if (eq < 0) continue;
					const key = line.slice(0, eq).trim();
					const val = line.slice(eq + 1).trim();
					if (key === "speed") {
						const s = Number.parseFloat(val); // "1.5x" → 1.5
						if (Number.isFinite(s) && s > 0) speed = s;
					} else if (key === "out_time") {
						const m = val.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
						if (m) {
							const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
							if (Number.isFinite(sec)) onTick(sec, speed);
						}
					}
				}
			}
		} catch {
			// stream closed on process exit
		}
	})();
}

/**
 * Transcode to a single HLS variant. `onTick(outTimeSec, speed)` fires as ffmpeg
 * reports progress (encoded position in seconds + speed as a ×realtime factor),
 * parsed from `-progress pipe:1`. `-nostats` keeps the stderr buffer small so a
 * long encode can't block on it.
 */
async function ffmpegHls(
	inputPath: string,
	outputDir: string,
	height: number,
	bitrate: string,
	name: string,
	onTick?: (outTimeSec: number, speed: number) => void,
) {
	const playlist = join(outputDir, `${name}.m3u8`);
	const segmentPattern = join(outputDir, `${name}_%03d.ts`);

	const proc = Bun.spawn(
		ffmpegCommand(inputPath, [
			"-vf",
			`scale=-2:${height}`,
			"-c:v",
			"libx264",
			// veryfast, not fast: on the benchmark file (a real 1080p source at the job's own
			// bitrates) it runs the tall rungs 2.5–3× faster for PSNR 43.51 → 43.14 and SSIM
			// 0.9836 → 0.9826, visually indistinguishable in matched 1:1 crops; the low rungs
			// are decode-bound and save almost nothing (57 s → 54 s), which is fine — the
			// wall time lives in the tall ones. Parker's verdict, 2026-10-11, after
			// comparing the 720p pair by eye.
			"-preset",
			"veryfast",
			"-b:v",
			bitrate,
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-hls_time",
			"6",
			"-hls_list_size",
			"0",
			"-hls_segment_filename",
			segmentPattern,
			"-f",
			"hls",
			playlist,
			"-progress",
			"pipe:1",
			"-nostats",
			"-y",
		]),
		{ stdout: "pipe", stderr: "pipe" },
	);

	streamFfmpegProgress(proc.stdout as ReadableStream<Uint8Array>, onTick);

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg HLS failed for ${name}: ${stderr.slice(0, 500)}`);
	}
	return playlist;
}

/**
 * The shared pass's filtergraph and output arguments: **one decode, every tall rung and
 * the audio rendition fed from it** (`-filter_complex` split/scale, one HLS muxer each).
 *
 * Pure and exported because the command is the contract a test can read — every branch
 * scales the same decoded frame, so each rung's picture is identical to what its isolated
 * pass produced (verified pixel-identical on all three rungs of the real benchmark source,
 * 2026-10-19). The smallest rung is deliberately absent: it is encoded alone, before this
 * pass, because the release gate opens on it.
 */
export function sharedPassOutputs(
	variants: Variant[],
	outputDir: string,
	hasAudio: boolean,
): string[] {
	const filter = [
		`[0:v]split=${variants.length}${variants.map((_, i) => `[vsrc${i}]`).join("")}`,
		...variants.map((v, i) => `[vsrc${i}]scale=-2:${v.height}[v${i}]`),
		...(hasAudio
			? [
					`[0:a]asplit=${variants.length + 1}${Array.from(
						{ length: variants.length + 1 },
						(_, i) => `[a${i}]`,
					).join("")}`,
				]
			: []),
	].join(";");

	const outputs: string[] = ["-filter_complex", filter];
	for (const [i, v] of variants.entries()) {
		outputs.push(
			"-map",
			`[v${i}]`,
			...(hasAudio ? ["-map", `[a${i}]`] : []),
			// Each output carries its own pin: `-threads` is an output option, so the
			// helper's post-input one covers the first muxer only.
			"-threads",
			String(FFMPEG_THREADS),
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-b:v",
			v.bitrate,
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-hls_time",
			"6",
			"-hls_list_size",
			"0",
			"-hls_segment_filename",
			join(outputDir, `${v.name}_%03d.ts`),
			"-f",
			"hls",
			join(outputDir, `${v.name}.m3u8`),
		);
	}
	if (hasAudio) {
		outputs.push(
			"-map",
			`[a${variants.length}]`,
			"-threads",
			String(FFMPEG_THREADS),
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-hls_time",
			"6",
			"-hls_playlist_type",
			"vod",
			"-hls_segment_filename",
			join(outputDir, "audio-%03d.ts"),
			"-f",
			"hls",
			join(outputDir, AUDIO_RENDITION_PLAYLIST),
		);
	}
	return outputs;
}

/**
 * Run the shared pass: one ffmpeg, one decode, every tall rung and the audio rendition.
 *
 * `-progress` in a multi-output invocation reports one timeline for the whole graph (the
 * outputs consume the same frames), which is exactly what the pass's estimate needs.
 */
async function ffmpegSharedHls(
	inputPath: string,
	outputDir: string,
	variants: Variant[],
	hasAudio: boolean,
	onTick?: (outTimeSec: number, speed: number) => void,
): Promise<void> {
	const proc = Bun.spawn(
		ffmpegCommand(inputPath, [
			...sharedPassOutputs(variants, outputDir, hasAudio),
			"-progress",
			"pipe:1",
			"-nostats",
			"-y",
		]),
		{ stdout: "pipe", stderr: "pipe" },
	);
	streamFfmpegProgress(proc.stdout as ReadableStream<Uint8Array>, onTick);

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg shared HLS pass failed: ${stderr.slice(0, 500)}`);
	}
}

/** The filename of a Work's audio-only rendition, within the same HLS directory. */
export const AUDIO_RENDITION_PLAYLIST = "audio.m3u8";

/**
 * The remux: the deliverable pair copied into its native container, `-c copy`, nothing
 * re-encoded — a remux's cost is transfer, which is why it is measured in seconds
 * against the ladder's minutes whatever a file's length is. The maps take the FIRST
 * video stream and the first audio (the pair the classifier demanded) and deliberately
 * leave subtitles and attachments uncarried: the original object keeps those, and the
 * pair's native container is what the player reads. +faststart moves an MP4's index to
 * its head, which is what a browser's first ranged read of the object wants.
 */
async function ffmpegRemux(
	inputPath: string,
	outPath: string,
	container: DeliverableContainer,
): Promise<void> {
	const proc = Bun.spawn(
		ffmpegCommand(inputPath, [
			"-map",
			"0:v:0",
			"-map",
			"0:a:0?",
			"-c",
			"copy",
			...(container === "mp4" ? ["-movflags", "+faststart"] : []),
			"-f",
			container,
			outPath,
			"-y",
		]),
		{ stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`the remux failed: ${stderr.slice(0, 500)}`);
	}
}

/** Transcode an audio-only HLS rendition — the same audio the variants carry, demuxed
 *  into its own playlist. One variant, at the bitrate the muxed ones carry, so a Work
 *  can be listened to as a podcast without paying for video bandwidth it cannot see. */
async function ffmpegAudioHls(inputPath: string, outputDir: string) {
	const playlist = join(outputDir, AUDIO_RENDITION_PLAYLIST);
	const segmentPattern = join(outputDir, "audio-%03d.ts");
	const proc = Bun.spawn(
		ffmpegCommand(inputPath, [
			"-vn",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-hls_time",
			"6",
			"-hls_playlist_type",
			"vod",
			"-hls_segment_filename",
			segmentPattern,
			"-f",
			"hls",
			playlist,
			"-y",
		]),
		{ stdout: "ignore", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg audio-only HLS failed: ${stderr.slice(0, 500)}`);
	}
	return playlist;
}

/**
 * Generate an HLS master playlist.
 *
 * Tags every variant with the `AUDIO` group the rendition below provides. Per RFC 8216
 * a stream-inf naming an audio group plays ITS audio from the named rendition rather
 * than its own muxed stream when a player honors it (every one hls.js drives does),
 * which is what makes the rendition one copy of the audio rather than a second encode.
 */
/**
 * The master playlist's lines; pure, so a test can read the tree a run would deliver.
 * The audio group rides it only when a rendition EXISTS to resolve (`withAudioGroup`) —
 * a group naming a file that isn't there yet is a dangling reference the player
 * refuses — which is why the ladder's progressive rewrites name rungs alone.
 */
export function masterPlaylistLines(
	variants: Variant[],
	hasAudio: boolean,
	withAudioGroup: boolean,
): string[] {
	const lines = ["#EXTM3U"];
	// Only when a rendition actually ships: a source with no audio track is a video
	// nobody can listen to, and an unresolvable media group is a dangling reference.
	if (hasAudio && withAudioGroup) {
		lines.push(
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Spoken",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
		);
	}
	for (const v of variants) {
		lines.push(
			`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height}${
				hasAudio && withAudioGroup ? ',AUDIO="aud"' : ""
			}`,
		);
		lines.push(`${v.name}.m3u8`);
	}
	return lines;
}

async function generateMasterPlaylist(
	outputDir: string,
	variants: Variant[],
	hasAudio: boolean,
	withAudioGroup: boolean,
) {
	await Bun.write(
		join(outputDir, "master.m3u8"),
		`${masterPlaylistLines(variants, hasAudio, withAudioGroup).join("\n")}\n`,
	);
}
async function updateJobProgress(jobId: number, progress: number) {
	await db.update(transcodingJobs).set({ progress }).where(eq(transcodingJobs.id, jobId));
}

/**
 * Whether the job's row has reached a state a still-running handler must stop for —
 * `completed`, or since the creator-cancel work `canceled`. The one fact both the
 * claim-time skip and the supersession re-checks rest on. Exported because a test
 * asserts the fact itself rather than inferring it from a handler's side effects.
 */
export async function isTranscodeSettled(jobId: number): Promise<boolean> {
	const [row] = await db
		.select({ status: transcodingJobs.status })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	return row?.status === "completed" || row?.status === "canceled";
}

export async function transcodeVideo(data: TranscodeVideoData) {
	// The ladder's own wall times, recorded at the completion write (`timings`) — the
	// history the queue's cost estimates read (`queue-position.ts`). `start` is taken
	// before the encode lock, so a re-delivery's wait under another handler's lock is
	// part of the record (`waitMs` includes it); the marks name the stage, and the
	// deltas are what one actual pass cost.
	const marks: Record<string, number> = { start: Date.now() };
	const mark = (name: string) => {
		marks[name] = Date.now();
	};
	// The lock is the whole reason `runTranscode` can trust what it re-reads: while it
	// holds the encode lock no other handler can be past this point, so a row
	// read `completed` really means another handler finished the work.
	return withTranscodeLock(data.jobId, () => runTranscode(data, { marks, mark }));
}

async function runTranscode(
	data: TranscodeVideoData,
	timing: { marks: Record<string, number>; mark: (name: string) => void },
) {
	const { jobId } = data;

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	// Idempotency: a late pg-boss retry of a job already finished (e.g. by the
	// worker startup-resume path) is a no-op. Holding the encode lock makes this
	// check authoritative rather than advisory: a re-delivery that waited on the
	// lock lands here only after the handler that held it returned.
	if (job.status === "completed") {
		console.log(`[transcode-video] job ${jobId} already completed; skipping`);
		return;
	}
	// 🚨 A canceled row is final the same way: the creator stopped it, and a stale
	// redelivery must not resume what they stopped — the claim-time guard the
	// cancel route relies on to make cancellation survive redelivery.
	if (job.status === "canceled") {
		console.log(`[transcode-video] job ${jobId} canceled; skipping`);
		return;
	}
	// 🚨 A row the boot sweep finally failed — its crash-resume ceiling spent — must NOT
	// be resurrected by a stale redelivery. Re-running the file that took the worker
	// down restores the crash loop the ceiling exists to stop, now that expiry is sized
	// in hours: the redelivery that would have done it is exactly "pg-boss redelivery
	// re-runs failed rows". A failed row BELOW the bound stays re-runnable on purpose:
	// that is a handler refusal from a possibly-transient cause still inside its job's
	// own retry budget, where re-running is the queue's ordinary self-healing.
	if (job.status === "failed" && job.resumeCount >= MAX_TRANSCODE_RESUMES) {
		console.log(`[transcode-video] job ${jobId} failed past its resume bound; skipping`);
		return;
	}

	// Mark as processing. The estimate is cleared too, so a job run again after a crash does not
	// show the previous run's figure until its own first reading. The benign-interruption
	// flag is spent here as well: a run reaching the row has consumed the excuse its
	// previous stop left, so whatever kills THIS run says for itself.
	await db
		.update(transcodingJobs)
		.set({
			status: "processing",
			progress: 0,
			etaSeconds: null,
			interruptedGracefully: false,
			updatedAt: new Date(),
		})
		.where(eq(transcodingJobs.id, jobId));

	const [item] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!item) throw new Error(`Content item ${job.workId} not found`);

	let storageKey = item.sourceKey ?? "";
	if (!storageKey) throw new Error("No source file on content item");

	// The storage prefix is built before the encode loop because the uploads now happen
	// throughout the job, one variant at a time (creator-first layout — see media-upload
	// route). Every run of the job gets its own prefix, so a retry never merges with a
	// partial prior attempt.
	const storagePrefix = `creators/${item.creatorId}/videos/hls/${randomUUID().replace(/-/g, "")}`;

	/**
	 * ⭐ **The re-check a handler that has outlived its own delivery owes the row.** A
	 * handler can lose the race to its expiry — or to a lock session dropped beneath it —
	 * while still encoding, and nothing kills it: if it then uploads and completes on its
	 * own schedule it uploads a second, unreferenced ladder and overwrites the manifest a
	 * finishing handler wrote. So before every upload and before the completion write, the
	 * row is re-read, and a run that finds the job already completed stops quietly —
	 * nothing uploaded, nothing written to the row, no failure recorded. Held under the
	 * encode lock this is hard to reach, since a re-delivery waits for the lock; hard to
	 * reach is not unreachable (a dropped connection releases a session lock without
	 * stopping the process), and the cost of reaching it silently was measured on
	 * 2026-10-11: one wasted full ladder. ⚠️ What is NOT checked is mid-variant: an
	 * encode already running finishes its current variant before the next check, because
	 * interrupting ffmpeg cleanly would need a cancel plumbed through every spawn — the
	 * waste is bounded by one variant and the lock makes the case rare.
	 */
	let superseded = false;
	const ensureStillOurs = async (): Promise<boolean> => {
		if (superseded) return false;
		if (await isTranscodeSettled(jobId)) {
			superseded = true;
			console.log(
				`[transcode-video] job ${jobId} completed by another handler; abandoning this run before touching storage or the row`,
			);
			return false;
		}
		return true;
	};

	let outputDir: string | null = null;

	try {
		// The job's temp directory is created before anything reads the source: the
		// three-way below may put a remuxed copy here, and the `finally` sweep frees
		// whatever is in it whether the run reached the ladder or not.
		outputDir = join(tmpdir(), `hls_${randomUUID()}`);
		await mkdir(outputDir, { recursive: true });

		// 1. Probe the source — read in place, no temp copy. A fresh address per pass;
		// the TTL constant above carries the reasoning.
		const probe = await ffprobe(
			await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
		);
		timing.mark("probeEnd");
		const videoStream = probe.streams?.find(
			(s: { codec_type: string }) => s.codec_type === "video",
		);
		if (!videoStream) throw new Error("No video stream found in file");

		const duration = Number.parseFloat(probe.format?.duration ?? "0");
		const sourceHeight = Number.parseInt(videoStream.height ?? "0", 10);
		const sourceWidth = Number.parseInt(videoStream.width ?? "0", 10);

		// Update the content item's duration
		if (duration > 0) {
			await db
				.update(works)
				.set({ durationSeconds: Math.round(duration) })
				.where(eq(works.id, item.id));
		}

		await updateJobProgress(jobId, 10);

		// 1b. The ingest three-way — accept, remux, refuse — the ruling that makes OBS's
		// default MKV capture a Work that plays rather than one that never did. A copy is
		// honest work: no encode runs, the ladder's math is unchanged (a remux changes no
		// stream, so this probe's duration and heights stay the answer), and the remuxed
		// original lands beside the uploaded one in the same directory.
		const verdict = classifyVideoStreams(probe, storageKey);
		if (verdict.refusal) {
			// A refusal is terminal and does not rethrow: the row carries the creator-facing
			// message, the handler RETURNS, pg-boss completes this queue job, and no retry
			// re-runs a decision that cannot change. The boot sweep re-sends only
			// pending/processing rows, so a row failed here is done deciding.
			await db
				.update(transcodingJobs)
				.set({ status: "failed", updatedAt: new Date(), errorMessage: verdict.refusal })
				.where(eq(transcodingJobs.id, jobId));
			console.log(
				`[transcode-video] job ${jobId}: the source's codec pair is outside the accepted set; refused`,
			);
			return;
		}

		if (!verdict.alreadyPlayable && verdict.container) {
			const remuxedKey = remuxedKeyFor(storageKey, verdict.container);
			const remuxedPath = join(outputDir, `remux.${verdict.container}`);
			await ffmpegRemux(
				await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
				remuxedPath,
				verdict.container,
			);
			// One whole object on the temp disk — the residency the ladder's per-variant
			// uploads exist to bound is one variant at a time, and a remux's answer is the
			// same shape: uploaded the moment its copy finishes, freed the moment the
			// upload's answer is in.
			await storage.upload(
				remuxedKey,
				Buffer.from(await Bun.file(remuxedPath).arrayBuffer()),
				remuxedContentType(verdict.container),
				"private",
			);
			// The `finally` sweep frees the directory regardless; no error path of a rm on
			// a file that the sweep will get to anyway is worth reporting instead of the
			// work that follows.
			await rm(remuxedPath).catch(() => {});

			// The re-point is the Work's write a zombie handler must never make, so the
			// supersession check stands before it, as it does before every upload.
			if (!(await ensureStillOurs())) return;
			// The remuxed MP4 takes over the Work's source, and the creator's uploaded
			// original moves onto the pointer column that keeps it enumerated and metered
			// (`works.source_original_key` — see the schema comment); replace and remove
			// sweeps read it so the original leaves when the Work's media does.
			await db
				.update(works)
				.set({
					sourceKey: remuxedKey,
					sourceOriginalKey: storageKey,
				})
				.where(eq(works.id, item.id));
			// A remuxed source is a NEW object on the Work — owed its scan like any attach,
			// and the release gate waits on exactly this queue's answer.
			await queueScansForWork({ ...item, sourceKey: remuxedKey });

			// The ladder reads the remuxed original from here on.
			storageKey = remuxedKey;
			await updateJobProgress(jobId, 15);
		}

		// 2. Determine variants based on source resolution — smallest first (the release
		// gate opens at the first rung; see the loop below and `planLadderFor`).
		const variants = planLadderFor(sourceHeight, sourceWidth);

		// Whether the source carries an audio track, from the same probe the variants
		// came from: the rendition (below) and the master's audio group are written
		// only when a stream exists to demux.
		const hasAudio = probe.streams?.some((s: { codec_type: string }) => s.codec_type === "audio");

		// 3. Transcode the ladder in its two passes.

		/**
		 * Upload every file a finished pass left in `dir`, deleting each the moment its
		 * upload lands, so the directory never holds more than the pass about to run.
		 * The ephemeral disk is small and the platform replaces a container whose disk
		 * fills, silently; uploading per pass rather than once at the end of the job is
		 * what keeps the output's residency bounded by one pass instead of the whole
		 * ladder.
		 */
		const uploadAndFree = async (dir: string): Promise<void> => {
			// The supersession check rides the upload, because the upload is exactly what
			// a zombie must not do: a run whose job another handler completed re-reads the
			// row first and uploads nothing.
			if (!(await ensureStillOurs())) return;
			for (const filename of await readdir(dir)) {
				const contentType = filename.endsWith(".m3u8")
					? "application/vnd.apple.mpegurl"
					: "video/mp2t";
				// Content is processed in the library before it's attached to any post, so its
				// access isn't known yet (and one item can be posted with different access).
				// EVERYTHING is private — playlists included. A public playlist had a working
				// CDN URL that bypassed the access-checked endpoint entirely, which is the whole
				// point of that endpoint; it fetches playlists signed now, so nothing needs the
				// public bootstrap that used to justify it.
				await storage.upload(
					`${storagePrefix}/${filename}`,
					await readFile(join(dir, filename)),
					contentType,
					"private",
				);
				// Not swallowed, unlike the `finally` sweep: a file that survives its own
				// upload is exactly the leak this restructure exists to bound.
				await rm(join(dir, filename));
			}
		};

		// The ladder spans the 10→80 range; ffmpeg's -progress drives a smooth
		// sub-percentage and a live estimate of what is left (`transcode-eta.ts`).
		const spanStart = 10;
		const spanEnd = 80;
		const perRung = (spanEnd - spanStart) / variants.length;
		const heights = variants.map((v) => v.height);
		const clampEta = createEtaClamp();
		let lastWrite: Promise<unknown> = Promise.resolve();

		/**
		 * One pass's progress writer. `span` is the share of 10→80 this pass owns.
		 *
		 * ⚠️ **The reporting flag is flipped before the pass's post-encode writes**, because
		 * a tick arriving after its ffmpeg has exited is stale by definition and must queue
		 * NOTHING. The reader in `streamFfmpegProgress` is detached and keeps draining the
		 * dead process's buffered stdout after the await resolves, so without the flip its
		 * late ticks re-enqueue writes with no one waiting on them — landing through the
		 * estimate-clear and completion writes, where a final row reading a mid-ladder
		 * progress and a stale estimate is the bug the real 2026-10-11 job 15 carried. One
		 * shared flag across passes cannot do this: a stale tick draining during the next
		 * pass would still read the flag as true, which is the window this closes.
		 */
		const reportTicks = (
			base: number,
			span: number,
			etaFor: (outSec: number, speed: number) => number | null,
		) => {
			let lastPct = -1;
			let lastWriteMs = 0;
			let reporting = true;
			return {
				tick: (outSec: number, speed: number) => {
					if (duration <= 0 || !reporting || superseded) return;
					const frac = Math.min(1, outSec / duration);
					const pct = Math.min(spanEnd - 1, Math.round(base + frac * span));
					const eta = clampEta(etaFor(outSec, speed));
					const now = Date.now();
					if (pct !== lastPct && now - lastWriteMs >= 1000) {
						lastPct = pct;
						lastWriteMs = now;
						// Fire-and-forget so the progress stream isn't blocked on the DB write.
						lastWrite = db
							.update(transcodingJobs)
							.set({ progress: pct, etaSeconds: eta })
							.where(eq(transcodingJobs.id, jobId))
							.execute()
							.catch(() => {});
					}
				},
				stop: () => {
					reporting = false;
				},
			};
		};

		// A run that lost its delivery between passes leaves the ladder here; its last
		// check was the previous pass's upload.
		if (superseded) return;

		const [first, ...shared] = variants;

		// ── Pass 1: the publish-early rung, alone ────────────────────────────────
		// The release gate opens on this rung's upload, so it must never wait behind a
		// taller encode — which is exactly what one decode feeding every rung would make
		// it do.
		const firstTicks = reportTicks(spanStart, perRung, (outSec, speed) =>
			remainingEncodeSeconds(heights, 0, outSec, duration, speed),
		);
		timing.mark(`v${first.height}Start`);
		await ffmpegHls(
			await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
			outputDir,
			first.height,
			first.bitrate,
			first.name,
			firstTicks.tick,
		);
		firstTicks.stop();
		timing.mark(`v${first.height}End`);
		await updateJobProgress(jobId, Math.round(spanStart + perRung));
		await uploadAndFree(outputDir);

		/**
		 * ⭐ The master is written as the ladder grows, not once at the end: after this
		 * rung's upload, a playlist naming it is uploaded at the tree's master key — the
		 * tree PLAYS from the first rung. The tall rungs join on a later rewrite, and the
		 * audio group (with the rendition it names) joins only on the final one, once the
		 * rendition actually exists; a group naming a file that isn't there yet is a
		 * dangling reference the player refuses.
		 */
		await generateMasterPlaylist(outputDir, [first], hasAudio, false);
		if (!(await ensureStillOurs())) return;
		const masterKey = `${storagePrefix}/master.m3u8`;
		await storage.upload(
			masterKey,
			await readFile(join(outputDir, "master.m3u8")),
			"application/vnd.apple.mpegurl",
			"private",
		);
		await rm(join(outputDir, "master.m3u8")).catch(() => {});
		// The moment this Work first played — the record the release gate reads.
		// Every upload's supersession check has passed by here, so this write is the
		// finisher's as much as any other.
		const firstManifestUrl = await storage.getUrl(masterKey);
		await db
			.update(transcodingJobs)
			.set({ playableAt: new Date(), hlsManifestUrl: firstManifestUrl })
			.where(eq(transcodingJobs.id, jobId));

		if (superseded) return;

		// ── Pass 2: one decode for every tall rung and the rendition ─────────────
		// The audio-only rendition rides this pass when one exists, so a video can be
		// listened to as a podcast without its picture and without a second decode.
		let audioShared = false;
		if (shared.length > 0) {
			const sharedTicks = reportTicks(
				spanStart + perRung,
				spanEnd - spanStart - perRung,
				(outSec, speed) => remainingSharedPassSeconds(outSec, duration, speed),
			);
			timing.mark("sharedStart");
			for (const v of shared) timing.mark(`v${v.height}Start`);
			await ffmpegSharedHls(
				await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
				outputDir,
				shared,
				hasAudio,
				sharedTicks.tick,
			);
			sharedTicks.stop();
			for (const v of shared) timing.mark(`v${v.height}End`);
			if (hasAudio) {
				timing.mark("audioStart");
				timing.mark("audioEnd");
			}
			audioShared = hasAudio;
			timing.mark("sharedEnd");
			await updateJobProgress(jobId, spanEnd);
			await uploadAndFree(outputDir);
		} else if (hasAudio) {
			// A one-rung source has no tall rung to share the rendition's pass with; its
			// decode is audio alone (`-vn`), which is a few seconds and not a video decode.
			timing.mark("audioStart");
			await ffmpegAudioHls(
				await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
				outputDir,
			);
			timing.mark("audioEnd");
			await uploadAndFree(outputDir);
		}

		// 4. The master's final rewrite, WITH the audio group — the rendition exists
		// under it now; pass 1's rewrite named the first rung alone.
		await generateMasterPlaylist(outputDir, variants, hasAudio, hasAudio);
		// Re-check before the estimate-clear and the 80 write: this run has now seen
		// every upload's check, but the row is what the whole tail below is written on.
		if (!(await ensureStillOurs())) return;
		// ⚠️ **The estimate covers the encoding alone, so it is cleared here.** Uploading the
		// segments takes a time nothing measures, and the last estimate the
		// encode wrote, usually a second or two, would otherwise stand for as long as they take.
		// A write the last pass queued is let land first, or it could write its figure
		// over the clear. Every tick whose pass has ended was already stopped at the
		// queueing step, so nothing enqueued after this line exists.
		await lastWrite;
		// The ladder's own measured shape, one number per pass plus the whole — the
		// record the queue's cost estimates read from, so history replaces the
		// constants as jobs complete (`queue-position.ts`).
		//
		// ⚠️ **There are no per-rung figures for the shared pass, and inventing them would
		// be the lie to avoid**: its outputs finish together, so each shares one wall time.
		// The isolated rung keeps its own key; the pass records what it covered.
		const { marks } = timing;
		const timings: Record<string, number | number[] | boolean> = {
			[`h${first.height}Ms`]: Math.round(
				marks[`v${first.height}End`] - marks[`v${first.height}Start`],
			),
			...(shared.length > 0
				? {
						sharedPassMs: Math.round(marks.sharedEnd - marks.sharedStart),
						sharedHeights: shared.map((v) => v.height),
					}
				: {}),
			...(hasAudio && audioShared ? { audioSharedPass: true } : {}),
			...(hasAudio && !audioShared
				? { audioPassMs: Math.round(marks.audioEnd - marks.audioStart) }
				: {}),
			// The source's own length, beside the costs — the queue's pricing reads RATE
			// medians (cost per second of source), and the rate needs the denominator.
			durationSeconds: Math.round(duration),
			waitMs: Math.round(marks[`v${first.height}Start`] - marks.start),
			totalMs: Math.round(Date.now() - marks.start),
		};
		await db
			.update(transcodingJobs)
			.set({ progress: 80, etaSeconds: null, timings })
			.where(eq(transcodingJobs.id, jobId));

		// 5. The master, uploaded last — after every variant and rendition file it names
		// is already in storage, which is the order a player expecting a playable tree
		// sees. What was uploaded is whatever `uploadAndFree` carried during the job.
		await uploadAndFree(outputDir);
		await updateJobProgress(jobId, 90);

		// 6. Complete. No poster is taken from the video: its creator chooses the thumbnail,
		// uploaded or picked from a frame in the Studio, because a still taken on their behalf
		// could be any moment of a Mature or Adult video and a thumbnail is shown to everybody.
		// Release refuses a video without one (`thumbnail_missing`).
		const manifestUrl = await storage.getUrl(`${storagePrefix}/master.m3u8`);
		// The completion write is the supersession check's whole reason to exist — this is
		// the write a zombie run used to make, planting its manifest over the finisher's.
		if (!(await ensureStillOurs())) return;
		await db
			.update(transcodingJobs)
			.set({
				status: "completed",
				// When it finished, which is what "recently finished" on the Dashboard reads.
				updatedAt: new Date(),
				progress: 100,
				etaSeconds: null,
				hlsManifestUrl: manifestUrl,
			})
			.where(eq(transcodingJobs.id, jobId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({
				status: "failed",
				updatedAt: new Date(),
				errorMessage: message.slice(0, 1000),
			})
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		// Clean up temp files (only files under tmpdir) — no source copy exists to
		// clean, since every pass reads the source in place.
		if (outputDir) {
			try {
				await rm(outputDir, { recursive: true });
			} catch {}
		}
	}
}
