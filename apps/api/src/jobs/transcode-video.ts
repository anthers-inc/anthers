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

import { eq } from "drizzle-orm";
import { db } from "@anthers/db";
import { transcodingJobs, posts } from "@anthers/db/schema";
import { mkdir, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
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
		[
			"ffprobe",
			"-v",
			"quiet",
			"-print_format",
			"json",
			"-show_format",
			"-show_streams",
			filePath,
		],
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

/** Transcode to a single HLS variant */
async function ffmpegHls(
	inputPath: string,
	outputDir: string,
	height: number,
	bitrate: string,
	name: string,
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
			"-y",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`ffmpeg HLS failed for ${name}: ${stderr.slice(0, 500)}`);
	}
	return playlist;
}

/** Generate an HLS master playlist */
async function generateMasterPlaylist(
	outputDir: string,
	variants: Variant[],
) {
	const lines = ["#EXTM3U"];
	for (const v of variants) {
		lines.push(
			`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height}`,
		);
		lines.push(`${v.name}.m3u8`);
	}
	await Bun.write(join(outputDir, "master.m3u8"), lines.join("\n") + "\n");
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
	await db
		.update(transcodingJobs)
		.set({ progress })
		.where(eq(transcodingJobs.id, jobId));
}

export async function transcodeVideo(data: TranscodeVideoData) {
	const { jobId } = data;

	// Mark as processing
	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0 })
		.where(eq(transcodingJobs.id, jobId));

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);

	const [post] = await db
		.select()
		.from(posts)
		.where(eq(posts.id, job.postId))
		.limit(1);
	if (!post) throw new Error(`Post ${job.postId} not found`);

	const storageKey = post.videoFile ?? "";
	if (!storageKey) throw new Error("No video file on post");

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

		// Update post duration
		if (duration > 0) {
			await db
				.update(posts)
				.set({ durationSeconds: Math.round(duration) })
				.where(eq(posts.id, post.id));
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

		const progressPerVariant = Math.floor(60 / variants.length);
		for (let i = 0; i < variants.length; i++) {
			const v = variants[i];
			await ffmpegHls(localPath, outputDir, v.height, v.bitrate, v.name);
			await updateJobProgress(jobId, 10 + (i + 1) * progressPerVariant);
		}

		// 4. Generate master playlist
		await generateMasterPlaylist(outputDir, variants);
		await updateJobProgress(jobId, 80);

		// 5. Upload HLS files to storage
		const storagePrefix = `videos/hls/${randomUUID().replace(/-/g, "")}`;
		const hlsFiles = await readdir(outputDir);
		for (const filename of hlsFiles) {
			const filePath = join(outputDir, filename);
			const fileBuffer = await readFile(filePath);
			const ct = filename.endsWith(".m3u8")
				? "application/vnd.apple.mpegurl"
				: "video/mp2t";
			// HLS segments for gated content are private; playlists need to be accessible
			const acl = filename.endsWith(".m3u8") ? "public" : "private";
			await storage.upload(
				`${storagePrefix}/${filename}`,
				fileBuffer,
				ct,
				acl,
			);
		}
		await updateJobProgress(jobId, 90);

		// 6. Auto-generate thumbnail if none set
		let thumbnailKey: string | null = null;
		if (!post.thumbnail) {
			const thumbPosition = Math.max(1, Math.round(duration * 0.25));
			thumbPath = await generateThumbnail(localPath, thumbPosition);
			if (thumbPath) {
				const thumbBuffer = await readFile(thumbPath);
				thumbnailKey = `thumbnails/${randomUUID().replace(/-/g, "")}.jpg`;
				await storage.upload(
					thumbnailKey,
					thumbBuffer,
					"image/jpeg",
					"public",
				);
				// Update post thumbnail
				const thumbnailUrl = await storage.getUrl(thumbnailKey);
				await db
					.update(posts)
					.set({ thumbnail: thumbnailUrl })
					.where(eq(posts.id, post.id));
			}
		}

		// 7. Complete
		const manifestUrl = await storage.getUrl(
			`${storagePrefix}/master.m3u8`,
		);
		await db
			.update(transcodingJobs)
			.set({
				status: "completed",
				progress: 100,
				hlsManifestUrl: manifestUrl,
			})
			.where(eq(transcodingJobs.id, jobId));
	} catch (error) {
		const message =
			error instanceof Error ? error.message : String(error);
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
