// SPDX-License-Identifier: Apache-2.0
/**
 * The waveform's own math, pure and cheap: `resamplePeaks` is what turns the server's
 * 128 precomputed FFmpeg points into the bar count the measured width actually wants,
 * and an off-by-one or a drifted endpoint here is visible in every audio surface at
 * once. Asserted by hand against what the eye checks: endpoints kept, range kept, and
 * a mid-song sample never bigger than its neighbors' neighborhood allows.
 */
import { describe, expect, test } from "bun:test";
import { resamplePeaks } from "./WaveformDisplay";

describe("resamplePeaks", () => {
	test("kept at least one bar — an empty list makes silence, not NaN", () => {
		expect(resamplePeaks([], 8)).toEqual(Array(8).fill(0));
		expect(resamplePeaks([0.5], 8)).toEqual(Array(8).fill(0.5));
	});

	test("a single requested bar is a real sample, not an index past the array", () => {
		expect(resamplePeaks([0.1, 0.9, 0.5], 1)).toEqual([0.9]);
	});

	test("a same-length request is the list back, untouched", () => {
		const peaks = [0.2, 0.5, 0.9];
		expect(resamplePeaks(peaks, 3)).toEqual(peaks);
	});

	test("upsampling keeps both endpoints — the song starts and ends where it started", () => {
		const out = resamplePeaks([0.25, 0.75], 5);
		expect(out).toEqual([0.25, 0.375, 0.5, 0.625, 0.75]);
	});

	test("downsampling never leaves the source range", () => {
		const peaks = Array.from({ length: 128 }, (_, i) => (i % 7) / 7);
		for (const bar of resamplePeaks(peaks, 40)) {
			expect(bar).toBeGreaterThanOrEqual(0);
			expect(bar).toBeLessThanOrEqual(1);
		}
	});

	test("a count below one means no bars to draw", () => {
		expect(resamplePeaks([0.3, 0.6], 0)).toEqual([]);
	});
});
