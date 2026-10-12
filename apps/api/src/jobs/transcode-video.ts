// SPDX-License-Identifier: Apache-2.0
/**
 * Video transcoding job: converts uploaded video to adaptive HLS.
 *
 * Ported from _legacy/backend/content/tasks.py transcode_video()
 *
 * Flow:
 * 1. Probe the source with ffprobe for resolution/duration — read in place, never downloaded
 * 2. Determine variants based on source height (480p, 720p, 1080p)
 * 3. Transcode each variant to HLS via ffmpeg, uploading and freeing each one's
 *    files before the next variant starts; 3b transcodes the audio-only rendition the same way
 * 4. Generate master playlist
 * 5. Upload the master playlist (the rest is uploaded per step 3)
 * 6. Update TranscodingJob status throughout
 *
 * The per-variant upload is a disk constraint, not an ordering preference: the worker's
 * filesystem is ephemeral and small, and the platform replaces a container whose disk
 * fills — silently, with no line the app can log. Holding the whole output beside a
 * whole source is how a burst of uploads bounced this worker every few minutes.
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
 * sizing this design assumes is `JOB_OPTIONS[TRANSCODE_VIDEO]` in `queue.ts`.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { ffmpegCommand } from "../lib/ffmpeg.js";
import { storage } from "../services/storage/index.js";
import { createEtaClamp, remainingEncodeSeconds } from "./transcode-eta.js";
import { MAX_TRANSCODE_RESUMES } from "./resume-orphans.js";

export interface TranscodeVideoData {
	jobId: number;
}

// ── The one-encode lock ─────────────────────────────────────────────────
//
// 🚨 **One encode per TranscodingJob, enforced in the database rather than the process.**
// pg-boss v12 fails a job whose handler runs past `expireInSeconds` and re-delivers it,
// and nothing kills the abandoned handler or its ffmpeg child — so absent a lock a
// re-delivery encodes the same source a second time, beside the first. That happened:
// `JOB_OPTIONS[TRANSCODE_VIDEO]` in `queue.ts` carries the 2026-10-11 measurement of one
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

// How long between lock attempts while another handler holds the job. Waiting releases
// the pooled connection between attempts — only the asking occupies a connection.
const LOCK_POLL_MS = 10_000;

/**
 * Run `fn` holding the TranscodingJob's advisory lock, waiting while another handler
 * holds it. Takes `pollMs` because a test needs waiting to be fast.
 */
export async function withTranscodeLock<T>(
	jobId: number,
	fn: () => Promise<T>,
	pollMs: number = LOCK_POLL_MS,
): Promise<T> {
	const key = TRANSCODE_LOCK_KEY_BASE + jobId;
	let loggedWait = false;
	while (true) {
		// The lock lives on the session, so acquire and hold use one reserved connection;
		// the unlock must ride the same session or it is a no-op. The key is cast to
		// `bigint` explicitly — pg_try_advisory_lock has int and bigint overloads, and an
		// untyped parameter must not have its overload chosen by accident.
		const session = await client.reserve();
		const [row] = await session`select pg_try_advisory_lock(${key}::bigint) as acquired`;
		if (row.acquired) {
			try {
				return await fn();
			} finally {
				await session`select pg_advisory_unlock(${key}::bigint)`;
				session.release();
			}
		}
		session.release();
		if (!loggedWait) {
			loggedWait = true;
			console.log(`[transcode-video] job ${jobId}: another handler holds the encode lock; waiting`);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
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

	// Stream ffmpeg's -progress output (key=value blocks) for live position + speed.
	if (onTick && proc.stdout) {
		void (async () => {
			const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
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

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg HLS failed for ${name}: ${stderr.slice(0, 500)}`);
	}
	return playlist;
}

/** The filename of a Work's audio-only rendition, within the same HLS directory. */
export const AUDIO_RENDITION_PLAYLIST = "audio.m3u8";

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
async function generateMasterPlaylist(outputDir: string, variants: Variant[], hasAudio: boolean) {
	const lines = ["#EXTM3U"];
	// Only when a rendition actually ships: a source with no audio track is a video
	// nobody can listen to, and an unresolvable media group is a dangling reference.
	if (hasAudio) {
		lines.push(
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Spoken",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
		);
	}
	for (const v of variants) {
		lines.push(
			`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height}${
				hasAudio ? ',AUDIO="aud"' : ""
			}`,
		);
		lines.push(`${v.name}.m3u8`);
	}
	await Bun.write(join(outputDir, "master.m3u8"), `${lines.join("\n")}\n`);
}

async function updateJobProgress(jobId: number, progress: number) {
	await db.update(transcodingJobs).set({ progress }).where(eq(transcodingJobs.id, jobId));
}

/**
 * Whether the job's row has already reached `completed` — the one fact both the
 * claim-time skip and the supersession re-checks rest on. Exported because a test
 * asserts the fact itself rather than inferring it from a handler's side effects.
 */
export async function isTranscodeCompleted(jobId: number): Promise<boolean> {
	const [row] = await db
		.select({ status: transcodingJobs.status })
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	return row?.status === "completed";
}

export async function transcodeVideo(data: TranscodeVideoData) {
	// The lock is the whole reason `runTranscode` can trust what it re-reads: while it
	// holds `pg_try_advisory_lock` no other handler can be past this point, so a row
	// read `completed` really means another handler finished the work.
	return withTranscodeLock(data.jobId, () => runTranscode(data));
}

async function runTranscode(data: TranscodeVideoData) {
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

	const storageKey = item.sourceKey ?? "";
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
		if (await isTranscodeCompleted(jobId)) {
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
		// 1. Probe the source — read in place, no temp copy. A fresh address per pass;
		// the TTL constant above carries the reasoning.
		const probe = await ffprobe(
			await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
		);
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

		// 2. Determine variants based on source resolution
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

		// 3. Transcode each variant
		outputDir = join(tmpdir(), `hls_${randomUUID()}`);
		await mkdir(outputDir, { recursive: true });

		/**
		 * Upload every file a finished encode left in `dir`, deleting each the moment its
		 * upload lands, so the directory never holds more than the variant still encoding
		 * is about to write. The ephemeral disk is small and the platform replaces a
		 * container whose disk fills, silently; uploading per variant rather than once at
		 * the end of the job is what keeps the output's residency bounded by one variant
		 * instead of by all of them.
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

		// Variants span the 10→80 range; within each, ffmpeg's -progress drives a
		// smooth sub-percentage and a live estimate of what is left (`transcode-eta.ts`).
		const spanStart = 10;
		const spanEnd = 80;
		const perVariant = (spanEnd - spanStart) / variants.length;
		const heights = variants.map((v) => v.height);
		const clampEta = createEtaClamp();
		let lastWrite: Promise<unknown> = Promise.resolve();
		for (let i = 0; i < variants.length; i++) {
			// A run that lost its delivery between variants leaves the encode loop here;
			// its last check was the previous variant's upload.
			if (superseded) break;
			const v = variants[i];
			const variantBase = spanStart + i * perVariant;
			let lastPct = -1;
			let lastWriteMs = 0;
			// Per-variant, and flipped before this variant's post-encode writes: a tick
			// reported once its variant's ffmpeg has exited is stale by definition (the
			// variant-end write and everything after supersede it), and it must queue
			// NOTHING. The reporting loop inside `ffmpegHls` is detached and keeps draining
			// the dead process's buffered stdout after this await resolves, so without the
			// per-variant flip its late ticks would re-enqueue writes with no one waiting
			// on them — landing through the estimate-clear write and the completion write,
			// where a final row reading a mid-ladder progress and a stale estimate is a
			// bug the real 2026-10-11 job 15 carried. One shared flag could not do this:
			// a stale tick draining during the AUDIO pass would still read the encode
			// flag as true, which is exactly the window the old shape leaked through.
			let variantReporting = true;
			await ffmpegHls(
				await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
				outputDir,
				v.height,
				v.bitrate,
				v.name,
				(outSec, speed) => {
					if (duration <= 0 || !variantReporting || superseded) return;
					const frac = Math.min(1, outSec / duration);
					const pct = Math.min(spanEnd - 1, Math.round(variantBase + frac * perVariant));
					const eta = clampEta(remainingEncodeSeconds(heights, i, outSec, duration, speed));
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
			);
			variantReporting = false;
			await updateJobProgress(jobId, Math.round(spanStart + (i + 1) * perVariant));
			// This variant's segments are off the disk before the next variant's encode
			// grows the directory again — the whole point of uploading per variant.
			await uploadAndFree(outputDir);
		}

		// A run that learned it was superseded leaves here; the `finally` below still
		// frees its temp directory, and nothing was uploaded or written to the row.
		if (superseded) return;

		// 3b. The audio-only rendition, beside the variants — one more pass over the same
		// source, so a video can be listened to as a podcast without its picture. Its
		// presence is what `userTranscoding` serializes as `audioManifestUrl`. A silent
		// source has nothing to demux, so it ships no rendition and the master says so.
		const hasAudio = probe.streams?.some((s: { codec_type: string }) => s.codec_type === "audio");
		if (hasAudio) {
			await ffmpegAudioHls(
				await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
				outputDir,
			);
			await uploadAndFree(outputDir);
		}

		// 4. Generate master playlist
		await generateMasterPlaylist(outputDir, variants, !!hasAudio);
		// Re-check before the estimate-clear and the 80 write: this run has now seen
		// every upload's check, but the row is what the whole tail below is written on.
		if (!(await ensureStillOurs())) return;
		// ⚠️ **The estimate covers the encoding alone, so it is cleared here.** Uploading the
		// segments takes a time nothing measures, and the last estimate the
		// encode wrote, usually a second or two, would otherwise stand for as long as they take.
		// A write the last variant queued is let land first, or it could write its figure
		// over the clear. Every tick whose variant has ended was already stopped at the
		// queueing step, so nothing enqueued after this line exists.
		await lastWrite;
		await db
			.update(transcodingJobs)
			.set({ progress: 80, etaSeconds: null })
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
