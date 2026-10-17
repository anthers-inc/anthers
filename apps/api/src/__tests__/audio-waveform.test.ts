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

/** An 8-second 440 Hz sine at full scale — loud enough that every bucket's peak is real. */
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
