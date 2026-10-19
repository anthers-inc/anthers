// SPDX-License-Identifier: Apache-2.0
/**
 * The audio job's waveform pass, against a real ffmpeg.
 *
 * 🚨 The pass this pins was rewritten 2026-10-18 after a real test measured the old one:
 * ffprobe's per-frame `astats` metadata decoded at roughly realtime — a six-minute track
 * spent four minutes at 80% with the row's figure frozen near "less than a minute left".
 * The rewrite decodes to 8 kHz mono and buckets in-process, so the assertions here are the
 * two properties that failure lacked: the pass is FAST on a real file, and its progress is
 * visible to the caller (the ticks) rather than a held allowance.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateWaveform } from "../jobs/process-audio.js";

let dir: string;

afterAll(async () => {
	if (dir) await rm(dir, { recursive: true, force: true });
});

/** An 8-second 440 Hz sine at full scale — loud enough that every bucket's measure is real. */
async function syntheticTone(): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "waveform-"));
	const path = join(dir, "tone.wav");
	const proc = Bun.spawn([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=8",
		// The sine source's own level is an eighth of full scale; lifted here so the
		// fixture really is the full-scale tone both tests describe.
		"-af",
		"volume=8",
		"-ac",
		"1",
		"-ar",
		"44100",
		"-f",
		"wav",
		"-y",
		path,
	]);
	if ((await proc.exited) !== 0) throw new Error("fixture tone failed to synthesize");
	return path;
}

/**
 * The shape a mastered track has in miniature: a full-scale burst every 40ms (so every
 * bucket of the waveform contains one) over silence the rest of the time. The sample
 * peak is ~0.9 everywhere, but only an eighth of the time carries signal — the sound a
 * listener hears as far sparser than its peak suggests. A per-bucket peak reads this
 * as a solid wall; the RMS measure this suite pins reads its real density.
 */
async function gatedBursts(): Promise<string> {
	dir = await mkdtemp(join(tmpdir(), "waveform-gated-"));
	const path = join(dir, "gated.wav");
	const proc = Bun.spawn([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"aevalsrc=if(lt(mod(t\\,0.05)\\,0.005)\\,0.9*sin(2*PI*440*t)\\,0):s=44100:d=8",
		"-ac",
		"1",
		"-f",
		"wav",
		"-y",
		path,
	]);
	if ((await proc.exited) !== 0) throw new Error("fixture bursts failed to synthesize");
	return path;
}

describe("the audio job's waveform pass", () => {
	it("yields 128 real peaks from a real file, fast", async () => {
		const startedAt = Date.now();
		const path = await syntheticTone();
		const peaks = await generateWaveform(path, 128, 8);
		const elapsedMs = Date.now() - startedAt;
		expect(peaks.length).toBe(128);
		// A full-scale sine's peaks are well above silence, and the bucketing leaves
		// almost no empty bins on a continuous tone.
		const nonzero = peaks.filter((p) => p > 0.1).length;
		expect(nonzero).toBeGreaterThan(120);
		// The measured property: seconds, not the ~realtime minutes the astats pass
		// cost. A generous bound that still fails the old implementation hard.
		expect(elapsedMs).toBeLessThan(15_000);
	}, 30_000);

	it("measures density, not the loudest transient in each bucket", async () => {
		// 🚨 The defect this pins (2026-10-19): a mastered track's buckets all reach full
		// scale, so peak-per-bucket drew the waveform as a wall with no dynamics. The
		// gated fixture is the same shape in miniature — full-scale transients, sparse
		// signal — and its RMS has to land far below full scale even though its peak does
		// not.
		const path = await gatedBursts();
		const peaks = await generateWaveform(path, 128, 8);
		const loudest = Math.max(...peaks);
		expect(peaks.length).toBe(128);
		// Every bucket carries the burst, so none of this is a silence artifact.
		expect(peaks.filter((p) => p > 0.01).length).toBeGreaterThan(120);
		// A peak-per-bucket pass would read ~1.0 here; density is a small fraction of it.
		expect(loudest).toBeLessThan(0.4);
	}, 30_000);

	it("reports its progress to the caller as it decodes", async () => {
		const path = await syntheticTone();
		const seen: Array<[number, number]> = [];
		await generateWaveform(path, 128, 8, (processed, total) => {
			seen.push([processed, total]);
		});
		expect(seen.length).toBeGreaterThan(0);
		// The totals are constant and sane, and the processed counts increase.
		expect(seen.every(([, total]) => total === 8 * 8000)).toBe(true);
		for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
	}, 30_000);
});
