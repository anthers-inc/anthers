// SPDX-License-Identifier: Apache-2.0
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
import { transcodingJobs, works } from "@anthers/db/schema";
import { eq, and, gt, isNotNull, sql } from "drizzle-orm";
import { ffmpegCommand } from "../lib/ffmpeg.js";
import { storage } from "../services/storage/index.js";
import { createEtaClamp } from "./transcode-eta.js";
import { MAX_TRANSCODE_RESUMES } from "./resume-orphans.js";

/**
 * How long the job's signed source address stays valid, exactly as the video legs'
 * reasoning is carried in their own files: one pass, minutes, and an expired address
 * fails the job into the queue's ordinary retries.
 */
const SOURCE_URL_TTL_SECONDS = 60 * 60;

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
			ffmpegCommand(filePath, [
				"-ss",
				String(start),
				"-t",
				String(segmentDuration),
				"-af",
				"volumedetect",
				"-f",
				"null",
				"-",
			]),
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
	// The job's own wall times, recorded at the completion write (`timings`) — the
	// history the queue's cost estimates read (`queue-position.ts`). Marks taken at
	// each step boundary; the deltas are the actual costs of the actual passes.
	const marks: Record<string, number> = { start: Date.now() };
	const mark = (name: string) => {
		marks[name] = Date.now();
	};

	const [job] = await db
		.select()
		.from(transcodingJobs)
		.where(eq(transcodingJobs.id, jobId))
		.limit(1);
	if (!job) throw new Error(`TranscodingJob ${jobId} not found`);
	// Idempotency: a late pg-boss retry of a job already finished (e.g. by the
	// worker startup-resume path) is a no-op. A row the boot sweep finally failed —
	// its crash-resume ceiling spent — is equally final, and must not be resurrected
	// by a stale redelivery that would restore the crash loop the ceiling exists to
	// stop. A failed row BELOW the bound stays re-runnable on purpose: a handler
	// refusal from a possibly-transient cause still inside its job's retry budget,
	// where re-running is the queue's ordinary self-healing.
	if (job.status === "completed") {
		console.log(`[process-audio] job ${jobId} already completed; skipping`);
		return;
	}
	// 🚨 A canceled row is final: the creator stopped it, and a stale redelivery must
	// not resume what they stopped.
	if (job.status === "canceled") {
		console.log(`[process-audio] job ${jobId} canceled; skipping`);
		return;
	}
	if (job.status === "failed" && job.resumeCount >= MAX_TRANSCODE_RESUMES) {
		console.log(`[process-audio] job ${jobId} failed past its resume bound; skipping`);
		return;
	}

	// The claim spends any benign-interruption flag the previous stop left: a run
	// reaching the row has consumed the excuse, so whatever kills THIS run says for
	// itself.
	await db
		.update(transcodingJobs)
		.set({ status: "processing", progress: 0, etaSeconds: null, interruptedGracefully: false, updatedAt: new Date() })
		.where(eq(transcodingJobs.id, jobId));

	const [item] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!item) throw new Error(`Content item ${job.workId} not found`);

	const storageKey = item.sourceKey ?? "";
	if (!storageKey) throw new Error("No source file on content item");

	let source: string;
	let outputPath: string | null = null;

	try {
		// The source is read in place — `readableInput`: its own path in local mode, a
		// ranged-read signed address in remote mode — and ffprobe's and ffmpeg's passes
		// take either form. No temp copy of the source exists, so the job's residency
		// is its MP3's output file alone, and that is freed below the moment its own
		// upload lands.
		source = await storage.readableInput(storageKey, { expiresIn: SOURCE_URL_TTL_SECONDS });

		// 1. Probe for duration
		mark("probeStart");
		const probe = await ffprobe(source);
		const duration = Number.parseFloat(probe.format?.duration ?? "0");
		if (duration > 0) {
			await db
				.update(works)
				.set({ durationSeconds: Math.round(duration) })
				.where(eq(works.id, item.id));
		}
		await updateJobProgress(jobId, 20);

		// 2. Normalize and convert to MP3
		mark("probeEnd");
		mark("encodeStart");
		const clampEta = createEtaClamp();

		/**
		 * The waveform pass's cost, projected, is folded into the running estimate rather
		 * than left as a multi-minute tail after "0 seconds": the whole file is decoded a
		 * second time to compute the peaks. Priced from the lane's own recorded history —
		 * the median waveform wall time of recent completed audio jobs (`timings`,
		 * camelCase keys like the jsonb elsewhere) — else a duration-scaled shape
		 * clamped to real bounds. No history and no duration means no estimate to make,
		 * which the clamp renders as the figure it already held.
		 */
		const [historyMedian] = await db
			.select({
				medianWaveformMs: sql<number | null>`percentile_cont(0.5) within group (order by ((timings->>'waveformMs')::numeric))`,
			})
			.from(transcodingJobs)
			.where(
				and(
					eq(transcodingJobs.status, "completed"),
					isNotNull(transcodingJobs.timings),
					eq(transcodingJobs.mediaType, "audio"),
					gt(transcodingJobs.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
				),
			);
		const medianWaveform = Number(historyMedian?.medianWaveformMs ?? 0) / 1000;
		const waveformAllowance =
			medianWaveform > 0 ? medianWaveform : Math.min(900, Math.max(30, duration / 8));

		outputPath = join(tmpdir(), `audio_${randomUUID()}.mp3`);
		const proc = Bun.spawn(
			ffmpegCommand(source, [
				"-af",
				"loudnorm",
				"-c:a",
				"libmp3lame",
				"-b:a",
				"192k",
				outputPath,
				// The estimate the creator reads comes from ffmpeg's own progress stream,
				// tick-driven the way the video ladder reports — position and speed, so the
				// running audio job carries its own real figure instead of encoding blind.
				"-progress",
				"pipe:1",
				"-nostats",
				"-y",
			]),
			{ stdout: "pipe", stderr: "pipe" },
		);
		if (proc.stdout) {
			// Same parser shape the video ladder's tick loop runs; the write is
			// fire-and-forget so the stream never blocks on the DB.
			void (async () => {
				const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
				const decoder = new TextDecoder();
				let buf = "";
				let speed = 0;
				let lastWriteMs = 0;
				let tickWrite: Promise<unknown> = Promise.resolve();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						buf += decoder.decode(value, { stream: true });
						const lines = buf.split("\n");
						buf = lines.pop() ?? "";
						for (const line of lines) {
							const eqPos = line.indexOf("=");
							if (eqPos < 0) continue;
							const key = line.slice(0, eqPos).trim();
							const val = line.slice(eqPos + 1).trim();
							if (key === "speed") {
								const s = Number.parseFloat(val);
								if (Number.isFinite(s) && s > 0) speed = s;
							} else if (key === "out_time") {
								const m = val.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
								if (!m) continue;
								const outSec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
								if (!Number.isFinite(outSec) || !(speed > 0) || !(duration > 0)) continue;
								// Throttled like the video ladder's ticks — the estimate narrows the
								// tail into the running figure as ffmpeg itself reports it.
								const now = Date.now();
								if (now - lastWriteMs < 1000) continue;
								const encodeLeft = Math.max(0, (duration - outSec) / speed);
								const estimate = clampEta(Math.round(encodeLeft + waveformAllowance));
								if (estimate == null) continue;
								lastWriteMs = now;
								// Fire-and-forget so the progress stream isn't blocked on the DB write.
								tickWrite = db
									.update(transcodingJobs)
									.set({ etaSeconds: estimate })
									.where(eq(transcodingJobs.id, jobId))
									.execute()
									.catch(() => {});
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
			throw new Error(`Audio normalization failed: ${stderr.slice(0, 500)}`);
		}
		mark("encodeEnd");
		// The encode is done — the estimate narrows to the tail the clamp has not already
		// reached: upload, then the waveform pass the allowance projected.
		const tailEta = clampEta(Math.round(waveformAllowance));
		if (tailEta != null)
			await db.update(transcodingJobs).set({ etaSeconds: tailEta }).where(eq(transcodingJobs.id, jobId));
		await updateJobProgress(jobId, 60);

		/**
		 * ⭐ The cancel checkpoint, placed before the run's only storage write. A creator
		 * canceling an in-flight audio job must not have their stopped run upload its MP3
		 * anyway — an object no row would ever name, left behind in `audio/processed/`.
		 * The row is re-read; anything that is no longer `processing` (the creator's
		 * cancel route marks it `canceled`, another handler's claim marks it anything
		 * else) stops the run here, before touching storage, the same shape the video
		 * job's `ensureStillOurs` takes at its own upload checks. Once the upload has
		 * begun the run finishes normally — the MP3 and waveform it produces are the
		 * truth for the source the Work still names, and a cancel that arrives in the
		 * window takes effect at the next state change.
		 */
		const [nowRow] = await db
			.select({ status: transcodingJobs.status })
			.from(transcodingJobs)
			.where(eq(transcodingJobs.id, jobId))
			.limit(1);
		if (nowRow?.status !== "processing") {
			console.log(`[process-audio] job ${jobId} no longer processing; abandoning before upload`);
			return;
		}

		// 3. Upload processed file (creator-first layout). Processed in the library before
		// it's attached to any post, so access isn't known here — which is exactly why the
		// MP3 is PRIVATE and delivery goes through the access-checked audio endpoint
		// (`GET /posts/:slug/audio/:contentId`), the same shape video uses for HLS. This
		// used to be public: a bare CDN URL that played, handed out in the post JSON, so
		// gated audio was retrievable by an anonymous user.
		const outputKey = `creators/${item.creatorId}/audio/processed/${randomUUID().replace(/-/g, "")}.mp3`;
		const outputBuffer = await readFile(outputPath);
		await storage.upload(outputKey, outputBuffer, "audio/mpeg", "private");
		// The deliverable produced and delivered: its temp file is dead the moment the
		// upload lands, so the finally sweep below is crash cleanup, not the plan.
		mark("uploadEnd");
		await rm(outputPath).catch(() => {});
		outputPath = null;
		const outputUrl = await storage.getUrl(outputKey);
		await updateJobProgress(jobId, 80);

		// 4. Generate waveform
		const waveform = await generateWaveform(source, 128);
		mark("waveformEnd");

		// The deltas, as the row keeps them: the measured answer to "what did an audio
		// job actually cost", which the queue's estimates read instead of constants as
		// soon as any exists.
		const timings = {
			probeMs: marks.probeEnd - marks.probeStart,
			encodeMs: marks.encodeEnd - marks.encodeStart,
			uploadMs: marks.uploadEnd - marks.encodeEnd,
			waveformMs: marks.waveformEnd - marks.uploadEnd,
			totalMs: marks.waveformEnd - marks.start,
		};

		// 5. Complete
		await db
			.update(transcodingJobs)
			.set({
				status: "completed",
				// When it finished, which is what "recently finished" on the Dashboard reads —
				// and the estimate is cleared, the same rule the video job keeps: a completed
				// row owes nothing, so no held figure survives to claim it does.
				updatedAt: new Date(),
				progress: 100,
				etaSeconds: null,
				outputFileUrl: outputUrl,
				waveformData: waveform,
				timings,
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
		// Crash cleanup only: the source is read in place (nothing to clean), and the
		// output freed itself the moment its own upload landed.
		if (outputPath) {
			try {
				await rm(outputPath);
			} catch {}
		}
	}
}
