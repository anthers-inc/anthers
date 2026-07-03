// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Audio processing job: normalize, convert to MP3, generate waveform.
 *
 * Ported from _legacy/backend/content/tasks.py process_audio()
 */

import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { postContents, posts, transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { type AccessiblePost, isPubliclyFree } from "../services/access.js";
import { storage } from "../services/storage/index.js";

export interface ProcessAudioData {
	jobId: number;
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
	return JSON.parse(await new Response(proc.stdout).text());
}

/** Generate waveform peaks (128 data points) using ffprobe frame analysis */
async function generateWaveform(filePath: string, numPoints = 128): Promise<number[]> {
	// Try peak level analysis first
	const proc = Bun.spawn(
		[
			"ffprobe",
			"-v",
			"quiet",
			"-f",
			"lavfi",
			"-i",
			`amovie=${filePath},astats=metadata=1:reset=1`,
			"-show_entries",
			"frame_tags=lavfi.astats.Overall.Peak_level",
			"-of",
			"csv=p=0",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);

	const exitCode = await proc.exited;
	const stdout = await new Response(proc.stdout).text();

	if (exitCode !== 0 || !stdout.trim()) {
		// Fallback: simple volume detection per segment
		return generateWaveformFallback(filePath, numPoints);
	}

	const rawPeaks: number[] = [];
	for (const line of stdout.trim().split("\n")) {
		const val = Number.parseFloat(line.trim());
		if (!Number.isFinite(val)) continue;
		// Convert from dB to linear (0-1 range)
		const linear = Math.min(1.0, Math.max(0.0, 10 ** (val / 20)));
		rawPeaks.push(linear);
	}

	if (rawPeaks.length === 0) return Array(numPoints).fill(0.5);
	return downsamplePeaks(rawPeaks, numPoints);
}

/** Fallback waveform generation using volumedetect per segment */
async function generateWaveformFallback(filePath: string, numPoints: number): Promise<number[]> {
	const probe = await ffprobe(filePath);
	const duration = Number.parseFloat(probe.format?.duration ?? "1");
	const segmentDuration = duration / numPoints;

	const peaks: number[] = [];
	for (let i = 0; i < numPoints; i++) {
		const start = i * segmentDuration;
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-i",
				filePath,
				"-ss",
				String(start),
				"-t",
				String(segmentDuration),
				"-af",
				"volumedetect",
				"-f",
				"null",
				"-",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		const stderr = await new Response(proc.stderr).text();

		let maxVol = -50.0;
		for (const line of stderr.split("\n")) {
			if (line.includes("max_volume")) {
				const match = line.match(/max_volume:\s*([-\d.]+)/);
				if (match) maxVol = Number.parseFloat(match[1]);
			}
		}
		// Convert dB to 0-1 range (-50dB = silence, 0dB = max)
		const linear = Math.max(0, Math.min(1, (maxVol + 50) / 50));
		peaks.push(Math.round(linear * 1000) / 1000);
	}
	return peaks;
}

/** Downsample a list of peaks to target count via max-in-chunk */
function downsamplePeaks(peaks: number[], targetCount: number): number[] {
	if (peaks.length <= targetCount) {
		return peaks.map((p) => Math.round(p * 1000) / 1000);
	}
	const chunkSize = peaks.length / targetCount;
	const result: number[] = [];
	for (let i = 0; i < targetCount; i++) {
		const start = Math.floor(i * chunkSize);
		const end = Math.floor((i + 1) * chunkSize);
		const chunk = peaks.slice(start, end);
		const peak = chunk.length > 0 ? Math.max(...chunk) : 0;
		result.push(Math.round(peak * 1000) / 1000);
	}
	return result;
}

async function updateJobProgress(jobId: number, progress: number) {
	await db.update(transcodingJobs).set({ progress }).where(eq(transcodingJobs.id, jobId));
}

export async function processAudio(data: ProcessAudioData) {
	const { jobId } = data;

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

	const [element] = await db
		.select()
		.from(postContents)
		.where(eq(postContents.id, job.contentId))
		.limit(1);
	if (!element) throw new Error(`Content element ${job.contentId} not found`);

	const [post] = await db.select().from(posts).where(eq(posts.id, element.postId)).limit(1);
	if (!post) throw new Error(`Post ${element.postId} not found`);

	// A post is publicly served when it's free to everyone.
	const isPublicPost = isPubliclyFree(post as AccessiblePost);

	const storageKey = element.audioFile ?? "";
	if (!storageKey) throw new Error("No audio file on content element");

	let localPath: string | null = null;
	let outputPath: string | null = null;

	try {
		// 0. Download source file to local temp path for ffmpeg
		localPath = await storage.downloadToTemp(storageKey);

		// 1. Probe for duration
		const probe = await ffprobe(localPath);
		const duration = Number.parseFloat(probe.format?.duration ?? "0");
		if (duration > 0) {
			await db
				.update(postContents)
				.set({ durationSeconds: Math.round(duration) })
				.where(eq(postContents.id, element.id));
		}
		await updateJobProgress(jobId, 20);

		// 2. Normalize and convert to MP3
		outputPath = join(tmpdir(), `audio_${randomUUID()}.mp3`);
		const proc = Bun.spawn(
			[
				"ffmpeg",
				"-i",
				localPath,
				"-af",
				"loudnorm",
				"-c:a",
				"libmp3lame",
				"-b:a",
				"192k",
				outputPath,
				"-y",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Audio normalization failed: ${stderr.slice(0, 500)}`);
		}
		await updateJobProgress(jobId, 60);

		// 3. Upload processed file to storage (creator-first layout — see media-upload route).
		// ACL follows access: free/ungated posts get a public MP3 the CDN serves directly
		// (getUrl returns a bare, unsigned URL); priced/gated posts keep it private (future
		// signed-URL playback). Without this, public audio 403s.
		const outputKey = `creators/${post.creatorId}/audio/processed/${randomUUID().replace(/-/g, "")}.mp3`;
		const outputBuffer = await readFile(outputPath);
		const acl = isPublicPost ? "public" : "private";
		await storage.upload(outputKey, outputBuffer, "audio/mpeg", acl);
		const outputUrl = await storage.getUrl(outputKey);
		await updateJobProgress(jobId, 80);

		// 4. Generate waveform
		const waveform = await generateWaveform(localPath, 128);

		// 5. Complete
		await db
			.update(transcodingJobs)
			.set({
				status: "completed",
				progress: 100,
				outputFileUrl: outputUrl,
				waveformData: waveform,
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
		if (outputPath) {
			try {
				await rm(outputPath);
			} catch {}
		}
	}
}
