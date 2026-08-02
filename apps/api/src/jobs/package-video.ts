// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Package a browser-transcoded video into adaptive HLS.
 *
 * The creator's browser already did the CPU-heavy encode (an H.264/AAC MP4 variant
 * ladder — see apps/web/src/lib/transcode.ts) and uploaded each variant. This job
 * only **remuxes** those ready-made MP4s into HLS with `-c copy` (no re-encode), so
 * it's cheap and fast even on the single-vCPU worker. The client forces a keyframe
 * every 6s, so `-hls_time 6` segments cleanly on copy.
 *
 * Falls through to the same completion shape as transcode-video.ts (a master.m3u8
 * URL on the transcoding job), and applies the same access-based ACLs.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db";
import { works, transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { storage } from "../services/storage/index.js";

/** Variant descriptor supplied by the client (its uploaded MP4 + geometry). */
export interface PackageVariant {
	name: string;
	height: number;
	width: number;
	bitrate: string;
	bandwidth: number;
	key: string; // storage key of the uploaded MP4
}

export interface PackageVideoData {
	jobId: number;
	variants: PackageVariant[];
	duration?: number;
}

/** Remux one MP4 → HLS variant with stream copy (no re-encode). */
async function remuxToHls(inputPath: string, outputDir: string, name: string): Promise<void> {
	const playlist = join(outputDir, `${name}.m3u8`);
	const segmentPattern = join(outputDir, `${name}_%03d.ts`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-i",
			inputPath,
			"-c",
			"copy",
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
		throw new Error(`ffmpeg HLS remux failed for ${name}: ${stderr.slice(0, 500)}`);
	}
}

/** Generate an HLS master playlist from the variant specs (highest bandwidth first). */
async function generateMasterPlaylist(outputDir: string, variants: PackageVariant[]) {
	const ordered = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
	const lines = ["#EXTM3U"];
	for (const v of ordered) {
		lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth},RESOLUTION=${v.width}x${v.height}`);
		lines.push(`${v.name}.m3u8`);
	}
	await Bun.write(join(outputDir, "master.m3u8"), `${lines.join("\n")}\n`);
}

/** Extract a poster thumbnail from a local MP4 at the given position. */
async function generateThumbnail(
	inputPath: string,
	positionSeconds: number,
): Promise<string | null> {
	const outPath = join(tmpdir(), `thumb_${randomUUID()}.jpg`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-ss",
			String(positionSeconds),
			"-i",
			inputPath,
			"-frames:v",
			"1",
			"-q:v",
			"3",
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

export async function packageVideo(data: PackageVideoData) {
	const { jobId, variants, duration } = data;

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	if (job.status === "completed") {
		console.log(`[package-video] job ${jobId} already completed; skipping`);
		return;
	}
	if (!variants || variants.length === 0) {
		throw new Error(`[package-video] job ${jobId} has no variants`);
	}

	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0 })
		.where(eq(transcodingJobs.id, jobId));

	const [item] = await db
		.select()
		.from(works)
		.where(eq(works.id, job.workId))
		.limit(1);
	if (!item) throw new Error(`Content item ${job.workId} not found`);

	// Persist the client-probed duration on the item (thumbnail position + UI).
	if (duration && duration > 0 && !item.durationSeconds) {
		await db
			.update(works)
			.set({ durationSeconds: Math.round(duration) })
			.where(eq(works.id, item.id));
	}

	const localPaths: string[] = [];
	let outputDir: string | null = null;
	let thumbPath: string | null = null;

	try {
		outputDir = join(tmpdir(), `hls_${randomUUID()}`);
		await mkdir(outputDir, { recursive: true });

		// Download + remux each variant. Downloads dominate the runtime; give them the
		// bulk of the progress band (10→85) and split evenly across variants.
		await updateJobProgress(jobId, 5);
		const span = 80 / variants.length;
		let firstLocal: string | null = null;
		for (let i = 0; i < variants.length; i++) {
			const v = variants[i];
			const localPath = await storage.downloadToTemp(v.key);
			localPaths.push(localPath);
			if (!firstLocal) firstLocal = localPath;
			await remuxToHls(localPath, outputDir, v.name);
			await updateJobProgress(jobId, Math.round(5 + (i + 1) * span));
		}

		// Master playlist.
		await generateMasterPlaylist(outputDir, variants);
		await updateJobProgress(jobId, 88);

		// Upload HLS output — playlists AND segments private. Access is enforced at serve
		// time via the signed-HLS endpoint (the item may be posted with different access,
		// so we can't bake it in here), and a public playlist was a working CDN URL around
		// that endpoint. Mirrors transcode-video.ts; keep the two in step.
		const storagePrefix = `creators/${item.creatorId}/videos/hls/${randomUUID().replace(/-/g, "")}`;
		const hlsFiles = await readdir(outputDir);
		for (const filename of hlsFiles) {
			const fileBuffer = await readFile(join(outputDir, filename));
			const ct = filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
			await storage.upload(`${storagePrefix}/${filename}`, fileBuffer, ct, "private");
		}
		await updateJobProgress(jobId, 94);

		// Thumbnail: the client usually uploads one (item.thumbnail already set). Only
		// derive a fallback from a variant if none exists.
		if (!item.thumbnail && firstLocal) {
			const at = Math.max(1, Math.round((duration && duration > 0 ? duration : 4) * 0.25));
			thumbPath = await generateThumbnail(firstLocal, at);
			if (thumbPath) {
				const thumbBuffer = await readFile(thumbPath);
				const thumbnailKey = `creators/${item.creatorId}/thumbnails/${randomUUID().replace(/-/g, "")}.jpg`;
				await storage.upload(thumbnailKey, thumbBuffer, "image/jpeg", "public");
				const thumbnailUrl = await storage.getUrl(thumbnailKey);
				await db
					.update(works)
					.set({ thumbnail: thumbnailUrl })
					.where(eq(works.id, item.id));
			}
		}

		const manifestUrl = await storage.getUrl(`${storagePrefix}/master.m3u8`);
		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100, etaSeconds: null, hlsManifestUrl: manifestUrl })
			.where(eq(transcodingJobs.id, jobId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(transcodingJobs)
			.set({ status: "failed", errorMessage: message.slice(0, 1000) })
			.where(eq(transcodingJobs.id, jobId));
		throw error;
	} finally {
		for (const p of localPaths) {
			if (p.startsWith(tmpdir())) {
				try {
					await rm(p);
				} catch {}
			}
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
