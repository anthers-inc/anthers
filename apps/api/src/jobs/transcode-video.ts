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
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { ffmpegCommand } from "../lib/ffmpeg.js";
import { storage } from "../services/storage/index.js";
import { createEtaClamp, remainingEncodeSeconds } from "./transcode-eta.js";

export interface TranscodeVideoData {
	jobId: number;
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
			"-preset",
			"fast",
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

export async function transcodeVideo(data: TranscodeVideoData) {
	const { jobId } = data;

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	// Idempotency: a late pg-boss retry of a job already finished (e.g. by the
	// worker startup-resume path) is a no-op.
	if (job.status === "completed") {
		console.log(`[transcode-video] job ${jobId} already completed; skipping`);
		return;
	}

	// Mark as processing. The estimate is cleared too, so a job run again after a crash does not
	// show the previous run's figure until its own first reading.
	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0, etaSeconds: null, updatedAt: new Date() })
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
		let encoding = true;
		let lastWrite: Promise<unknown> = Promise.resolve();
		for (let i = 0; i < variants.length; i++) {
			const v = variants[i];
			const variantBase = spanStart + i * perVariant;
			let lastPct = -1;
			let lastWriteMs = 0;
			await ffmpegHls(
				await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS }),
				outputDir,
				v.height,
				v.bitrate,
				v.name,
				(outSec, speed) => {
					if (duration <= 0 || !encoding) return;
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
			await updateJobProgress(jobId, Math.round(spanStart + (i + 1) * perVariant));
			// This variant's segments are off the disk before the next variant's encode
			// grows the directory again — the whole point of uploading per variant.
			await uploadAndFree(outputDir);
		}

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
		// ⚠️ **The estimate covers the encoding alone, so it is cleared here.** Uploading the
		// segments takes a time nothing measures, and the last estimate the
		// encode wrote, usually a second or two, would otherwise stand for as long as they take.
		// A progress reading still in flight is let land first, or it could write that figure back.
		encoding = false;
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
