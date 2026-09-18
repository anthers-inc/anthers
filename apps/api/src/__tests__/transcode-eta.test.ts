// SPDX-License-Identifier: Apache-2.0
/**
 * The estimate a creator reads while a video encodes: what it projects, and that the figure a
 * job writes never climbs.
 */
import { describe, expect, it } from "bun:test";
import { createEtaClamp, remainingEncodeSeconds } from "../jobs/transcode-eta.js";

const FROM_1080 = [1080, 720, 480];

describe("remainingEncodeSeconds", () => {
	it("weights each variant still to come by its height against the one running", () => {
		// A minute of video at realtime: the rest of 1080p, then 720p at 2/3 and 480p at 4/9 of it.
		expect(remainingEncodeSeconds(FROM_1080, 0, 0, 60, 1)).toBe(Math.round(60 + 40 + 60 * (4 / 9)));
		// Halfway through 720p at twice realtime: 30s of it left, then 480p at 2/3 of 720p.
		expect(remainingEncodeSeconds(FROM_1080, 1, 30, 60, 2)).toBe(Math.round((30 + 40) / 2));
	});

	it("counts only the rest of the last variant", () => {
		expect(remainingEncodeSeconds(FROM_1080, 2, 30, 60, 2)).toBe(15);
		expect(remainingEncodeSeconds([480], 0, 60, 60, 1)).toBe(0);
	});

	it("has nothing to say before ffmpeg reports a speed", () => {
		expect(remainingEncodeSeconds(FROM_1080, 0, 0, 60, 0)).toBeNull();
		expect(remainingEncodeSeconds(FROM_1080, 0, 0, 0, 1)).toBeNull();
	});
});

describe("createEtaClamp", () => {
	it("never lets the written figure climb", () => {
		const clamp = createEtaClamp();
		// A new variant's first readings are slow, so its first estimate is the higher one.
		expect([300, 240, 280, 200, 210].map(clamp)).toEqual([300, 240, 240, 200, 200]);
	});

	it("holds the last figure through a reading with no speed", () => {
		const clamp = createEtaClamp();
		expect(clamp(null)).toBeNull();
		expect(clamp(120)).toBe(120);
		expect(clamp(null)).toBe(120);
	});

	it("starts afresh for each run of a job", () => {
		const first = createEtaClamp();
		first(30);
		expect(createEtaClamp()(300)).toBe(300);
	});
});
