// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Video transcoding job: converts uploaded video to adaptive HLS.
 *
 * Ported from _legacy/backend/content/tasks.py transcode_video()
 *
 * Flow:
 * 1. Probe source file with ffprobe for resolution/duration
 * 2. Determine variants based on source height (480p, 720p, 1080p)
 * 3. Transcode each variant to HLS via ffmpeg
 * 4. Generate master playlist
 * 5. Upload all HLS files to storage
 * 6. Auto-generate thumbnail at 25% mark if none exists
 * 7. Update TranscodingJob status throughout
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { storage } from "../services/storage/index.js";

export interface TranscodeVideoData {
	jobId: number;
}

interface Variant {
	name: string;
	height: number;
	bitrate: string;
	bandwidth: number;
	width: number;
}

/** Run ffprobe and return parsed JSON metadata */
async function ffprobe(filePath: string) {
	const proc = Bun.spawn(
		["ffprobe", "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
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
		[
			"ffmpeg",
			"-i",
			inputPath,
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
		],
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

/** Generate an HLS master playlist */
async function generateMasterPlaylist(outputDir: string, variants: Variant[]) {
	const lines = ["#EXTM3U"];
	for (const v of variants) {
		lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height}`);
		lines.push(`${v.name}.m3u8`);
	}
	await Bun.write(join(outputDir, "master.m3u8"), `${lines.join("\n")}\n`);
}

/** Generate a thumbnail from a video at the given position */
async function generateThumbnail(
	inputPath: string,
	positionSeconds: number,
): Promise<string | null> {
	const outPath = join(tmpdir(), `thumb_${randomUUID()}.jpg`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-i",
			inputPath,
			"-ss",
			String(positionSeconds),
			"-vframes",
			"1",
			"-q:v",
			"2",
			outPath,
			"-y",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		try {
			await rm(outPath);
		} catch {}
		return null;
	}
	return outPath;
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

	// Mark as processing.
	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0 })
		.where(eq(transcodingJobs.id, jobId));

	const [item] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!item) throw new Error(`Content item ${job.workId} not found`);

	const storageKey = item.sourceKey ?? "";
	if (!storageKey) throw new Error("No source file on content item");

	let localPath: string | null = null;
	let outputDir: string | null = null;
	let thumbPath: string | null = null;

	try {
		// 0. Download source file to local temp path for ffmpeg
		localPath = await storage.downloadToTemp(storageKey);

		// 1. Probe source
		const probe = await ffprobe(localPath);
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

		// Variants span the 10→80 range; within each, ffmpeg's -progress drives a
		// smooth sub-percentage and a live ETA (remaining encode-seconds ÷ speed).
		const spanStart = 10;
		const spanEnd = 80;
		const perVariant = (spanEnd - spanStart) / variants.length;
		for (let i = 0; i < variants.length; i++) {
			const v = variants[i];
			const variantBase = spanStart + i * perVariant;
			let lastPct = -1;
			let lastWriteMs = 0;
			await ffmpegHls(localPath, outputDir, v.height, v.bitrate, v.name, (outSec, speed) => {
				if (duration <= 0) return;
				const frac = Math.min(1, outSec / duration);
				const pct = Math.min(spanEnd - 1, Math.round(variantBase + frac * perVariant));
				// Remaining = rest of this variant + full duration for each later variant.
				const remainingSec = Math.max(0, duration - outSec) + (variants.length - 1 - i) * duration;
				const eta = speed > 0 ? Math.round(remainingSec / speed) : null;
				const now = Date.now();
				if (pct !== lastPct && now - lastWriteMs >= 1000) {
					lastPct = pct;
					lastWriteMs = now;
					// Fire-and-forget so the progress stream isn't blocked on the DB write.
					db.update(transcodingJobs)
						.set({ progress: pct, etaSeconds: eta })
						.where(eq(transcodingJobs.id, jobId))
						.execute()
						.catch(() => {});
				}
			});
			await updateJobProgress(jobId, Math.round(spanStart + (i + 1) * perVariant));
		}

		// 4. Generate master playlist
		await generateMasterPlaylist(outputDir, variants);
		await updateJobProgress(jobId, 80);

		// 5. Upload HLS files to storage (creator-first layout — see media-upload route)
		const storagePrefix = `creators/${item.creatorId}/videos/hls/${randomUUID().replace(/-/g, "")}`;
		const hlsFiles = await readdir(outputDir);
		for (const filename of hlsFiles) {
			const filePath = join(outputDir, filename);
			const fileBuffer = await readFile(filePath);
			const ct = filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
			// Content is processed in the library before it's attached to any post, so its
			// access isn't known yet (and one item can be posted with different access).
			// EVERYTHING is private — playlists included. A public playlist had a working
			// CDN URL that bypassed the access-checked endpoint entirely, which is the whole
			// point of that endpoint; it fetches playlists signed now, so nothing needs the
			// public bootstrap that used to justify it.
			await storage.upload(`${storagePrefix}/${filename}`, fileBuffer, ct, "private");
		}
		await updateJobProgress(jobId, 90);

		// 6. Auto-generate a poster thumbnail for the item if none set. Posts that
		// reference the item derive their card image from it at display time.
		let thumbnailKey: string | null = null;
		if (!item.thumbnail) {
			const thumbPosition = Math.max(1, Math.round(duration * 0.25));
			thumbPath = await generateThumbnail(localPath, thumbPosition);
			if (thumbPath) {
				const thumbBuffer = await readFile(thumbPath);
				thumbnailKey = `creators/${item.creatorId}/thumbnails/${randomUUID().replace(/-/g, "")}.jpg`;
				await storage.upload(thumbnailKey, thumbBuffer, "image/jpeg", "public");
				const thumbnailUrl = await storage.getUrl(thumbnailKey);
				await db.update(works).set({ thumbnail: thumbnailUrl }).where(eq(works.id, item.id));
			}
		}

		// 7. Complete
		const manifestUrl = await storage.getUrl(`${storagePrefix}/master.m3u8`);
		await db
			.update(transcodingJobs)
			.set({
				status: "completed",
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
				errorMessage: message.slice(0, 1000),
			})
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		// Clean up temp files (only files under tmpdir)
		if (localPath?.startsWith(tmpdir())) {
			try {
				await rm(localPath);
			} catch {}
		}
		if (outputDir) {
			try {
				await rm(outputDir, { recursive: true });
			} catch {}
		}
		if (thumbPath) {
			try {
				await rm(thumbPath);
			} catch {}
		}
	}
}
