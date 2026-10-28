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
import { works, workTranscodingJobs } from "@anthers/db/schema";
import { and, eq, gt, isNotNull, sql } from "drizzle-orm";
import { ffmpegCommand } from "../lib/ffmpeg.js";
import { storage } from "../services/storage/index.js";
import { MAX_TRANSCODE_RESUMES } from "./resume-orphans.js";
import { createEtaClamp } from "./transcode-eta.js";

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

/**
 * Generate waveform peaks (128 data points) from one ffmpeg pass over the file.
 *
 * The first cut asked ffprobe's `amovie …,astats` for a peak per frame and paid for every
 * frame's metadata print: it decoded at roughly realtime, four to five minutes for a
 * six-minute track on the worker (measured 2026-10-18) — exactly the stretch that made a
 * running job sit at 80% reading "less than a minute left". One pass decoding to 8 kHz
 * mono and bucketing the samples in-process yields the same 128 peaks in seconds, and
 * the byte stream doubles as the pass's own progress: `onTick` reports samples
 * processed out of the expected total, which the caller turns into the row's real
 * percentage and figure while the pass runs.
 *
 * ⭐ **Each bucket is the root mean square of its samples, not their loudest one**
 * (2026-10-19). Peak-per-bucket was what the first version measured, and against a
 * mastered track it drew a wall: a loud, well-compressed master touches (or nearly
 * touches) full scale in almost every bucket, so the bar heights all sat at the ceiling
 * and the drawing had no shape to show. Density is what a listener reads as loudness —
 * a dense chorus and a sparse verse at the same peak are not the same loudness — and
 * RMS is the measure that follows it. The display normalizes by the track's own loudest
 * bucket, so the stored value only has to be proportional.
 */
export async function generateWaveform(
	filePath: string,
	numPoints = 128,
	durationSeconds = 0,
	onTick?: (processed: number, total: number) => void,
): Promise<number[]> {
	const proc = Bun.spawn(
		ffmpegCommand(filePath, [
			"-map",
			"0:a:0",
			"-ac",
			"1",
			"-ar",
			"8000",
			"-f",
			"s16le",
			"-acodec",
			"pcm_s16le",
			"pipe:1",
			"-y",
		]),
		{ stdout: "pipe", stderr: "pipe" },
	);

	// One bucket per peak point, assigned by sample index — whatever the duration's
	// rounding, every sample lands in a bucket and the buckets are the exactly-128 bins
	// the player's shape expects. A bucket no sample reached (a stream that ended early)
	// stays 0. The tick cadence is a second of audio, floored at a 5% step so a short
	// file still ticks; the caller throttles what it writes.
	//
	// Each bucket carries the sum of squared samples and how many samples landed in it;
	// the RMS is taken at the bucket boundary rather than the running peak. A bucket
	// whose window ends mid-stream is still finalized on the last sample, so a short
	// file cannot silently drop its tail.
	const totalSamples = Math.max(1, Math.round(8000 * durationSeconds));
	const tickEvery = Math.max(1, Math.min(8000, Math.floor(totalSamples / 20)));
	const peaks = new Array<number>(numPoints).fill(0);
	const sums = new Float64Array(numPoints);
	const counts = new Uint32Array(numPoints);
	let samples = 0;
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
		for (let off = 0; off + 1 < view.byteLength; off += 2) {
			// Normalize first so the squared sum stays well inside a double's exact range
			// for any track length: 32768² × millions would otherwise lose precision.
			const sample = view.getInt16(off, true) / 32768;
			const bucket = Math.min(numPoints - 1, Math.floor((samples * numPoints) / totalSamples));
			sums[bucket] += sample * sample;
			counts[bucket] += 1;
			samples++;
			if (onTick && samples % tickEvery === 0) onTick(samples, totalSamples);
		}
	}
	if (samples === 0) {
		// The stream died before any sample: the old astats path is the recorded fallback,
		// and volumedetect per segment under it — slower still, but the peak shape it
		// yields is real and this shape of failure is rare.
		return generateWaveformFallback(filePath, numPoints);
	}
	for (let i = 0; i < numPoints; i++) {
		peaks[i] = counts[i] > 0 ? Math.sqrt(sums[i] / counts[i]) : 0;
	}
	return peaks.map((p) => Math.round(p * 1000) / 1000);
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

async function updateJobProgress(jobId: number, progress: number) {
	await db.update(workTranscodingJobs).set({ progress }).where(eq(workTranscodingJobs.id, jobId));
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
		.from(workTranscodingJobs)
		.where(eq(workTranscodingJobs.id, jobId))
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
		.update(workTranscodingJobs)
		.set({
			status: "processing",
			progress: 0,
			etaSeconds: null,
			interruptedGracefully: false,
			updatedAt: new Date(),
		})
		.where(eq(workTranscodingJobs.id, jobId));

	const [item] = await db.select().from(works).where(eq(works.id, job.workId)).limit(1);
	if (!item) throw new Error(`Content item ${job.workId} not found`);

	const storageKey = item.sourceKey ?? "";
	if (!storageKey) throw new Error("No source file on content item");

	let source: string;
	let outputPath: string | null = null;
	// The encode's progress ticks are fire-and-forget; this flips to false the moment
	// the encoder exits (after it is awaited), so the dead encoder's drained stdout can
	// never queue a write — the same guard the video ladder runs per variant.
	let encodeReporting = true;
	// The last tick the encoder queued, so the tail's narrowing and the completion write
	// can wait for it rather than race it — the same guard the video ladder runs per variant.
	let tickWrite: Promise<unknown> = Promise.resolve();

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
		 * than left as a tail with no figure: the pass decodes the whole file a second
		 * time to compute the peaks. Priced as a RATE — the median of recent completed
		 * jobs' waveform wall time per second of audio (from `timings`, camelCase keys
		 * like the jsonb elsewhere), scaled by this file's duration — because a rate is
		 * what carries across files of different lengths, and a total does not. A pass
		 * measured before the durations were recorded has no rate to offer, and that
		 * exclusion is load-bearing as well as incidental: the astats era's multiminute
		 * measurements (2026-10-18's prod recordings, ~0.8x realtime) would otherwise
		 * price the pass that replaced them. No history means a duration-scaled shape;
		 * both branches clamp to bounds a pass can honestly hit.
		 */
		const [historyRate] = await db
			.select({
				rate: sql<
					number | null
				>`percentile_cont(0.5) within group (order by ((timings->>'waveformMs')::numeric / NULLIF((timings->>'durationSeconds')::numeric, 0)))`,
			})
			.from(workTranscodingJobs)
			.where(
				and(
					eq(workTranscodingJobs.status, "completed"),
					isNotNull(workTranscodingJobs.timings),
					eq(workTranscodingJobs.mediaType, "audio"),
					gt(workTranscodingJobs.createdAt, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
				),
			);
		const medianWaveformRate = Number(historyRate?.rate ?? 0);
		const waveformAllowance =
			medianWaveformRate > 0
				? Math.min(300, Math.max(20, (medianWaveformRate * duration) / 1000))
				: Math.min(300, Math.max(20, duration / 16));

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
								if (!encodeReporting) break;
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
									.update(workTranscodingJobs)
									.set({ etaSeconds: estimate })
									.where(eq(workTranscodingJobs.id, jobId))
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
		// A tick whose encoder has exited is stale by definition: flip first, let the
		// last queued tick land, then narrow — the exact order the video ladder runs
		// between its own variants, whose stale-tick incident is its docblock's record.
		encodeReporting = false;
		await tickWrite;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`Audio normalization failed: ${stderr.slice(0, 500)}`);
		}
		mark("encodeEnd");
		// The encode is done — the estimate narrows to the tail the clamp has not already
		// reached: upload, then the waveform pass the allowance projected.
		const tailEta = clampEta(Math.round(waveformAllowance));
		if (tailEta != null)
			await db
				.update(workTranscodingJobs)
				.set({ etaSeconds: tailEta })
				.where(eq(workTranscodingJobs.id, jobId));
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
			.select({ status: workTranscodingJobs.status })
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.id, jobId))
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
		mark("waveformStart");
		/**
		 * The tail's own ticks: the pass knows its progress exactly (samples decoded out
		 * of the expected total), so the row's percentage walks 80→99 and its figure is
		 * the measured remaining — elapsed wall per processed fraction — rather than a
		 * held allowance. Deliberately NOT through the monotonic clamp: a measured
		 * remaining is allowed to rise above the projection (a slow stretch is real),
		 * and the figure must follow the truth, not only shrink. Fire-and-forget and
		 * throttled like the encode's ticks, so the stream never waits on the DB.
		 */
		const waveStartMs = Date.now();
		let waveLastWriteMs = 0;
		const waveform = await generateWaveform(source, 128, duration, (processed, total) => {
			const now = Date.now();
			if (now - waveLastWriteMs < 1000) return;
			waveLastWriteMs = now;
			const progress = Math.min(99, 80 + Math.round((19 * processed) / Math.max(1, total)));
			const frac = processed / Math.max(1, total);
			// Under 2% the rate is too little measured to extrapolate from; the held
			// figure (the projection) is better than a rate built on two samples.
			const remaining =
				frac >= 0.02 ? Math.round(((now - waveStartMs) * (1 - frac)) / (frac * 1000)) : null;
			void db
				.update(workTranscodingJobs)
				.set(remaining == null ? { progress } : { progress, etaSeconds: remaining })
				.where(eq(workTranscodingJobs.id, jobId))
				.execute()
				.catch(() => {});
		});
		mark("waveformEnd");

		// The deltas, as the row keeps them: the measured answer to "what did an audio
		// job actually cost", which the queue's estimates read instead of constants as
		// soon as any exists.
		const timings = {
			// The file's own length, beside the costs: the wave allowance and the queue's
			// pricing read RATE medians (cost per second of audio), which is what carries
			// across files of different lengths — without it a measurement prices only a
			// file of its own size.
			durationSeconds: Math.round(duration),
			probeMs: marks.probeEnd - marks.probeStart,
			encodeMs: marks.encodeEnd - marks.encodeStart,
			uploadMs: marks.uploadEnd - marks.encodeEnd,
			waveformMs: marks.waveformEnd - marks.uploadEnd,
			totalMs: marks.waveformEnd - marks.start,
		};

		// 5. Complete
		await db
			.update(workTranscodingJobs)
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
			.where(eq(workTranscodingJobs.id, jobId));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await db
			.update(workTranscodingJobs)
			.set({
				status: "failed",
				updatedAt: new Date(),
				errorMessage: message.slice(0, 1000),
			})
			.where(eq(workTranscodingJobs.id, jobId));
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
