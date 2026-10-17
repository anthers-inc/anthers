// SPDX-License-Identifier: Apache-2.0
/**
 * The video ladder's plan, as data — `planLadderFor` and the master's lines.
 *
 * Publish-early (2026-10-18) made the ORDER load-bearing, not just the membership: the
 * rungs encode smallest-first and the release gate opens at the first one, so an
 * ascending slip here is a creator publishing on the hour-long rung again. The master's
 * lines are pinned because its progressive rewrites are how the tree plays early — the
 * audio group must name a rendition that exists, and nothing else on the row guarantees
 * that.
 */
import { describe, expect, it } from "bun:test";
import { masterPlaylistLines, planLadderFor } from "../jobs/transcode-video.js";

describe("planLadderFor", () => {
	it("orders the ladder smallest-first, whatever the source", () => {
		const ladder = planLadderFor(2160, 3840);
		expect(ladder.map((v) => v.height)).toEqual([480, 720, 1080]);
	});

	it("caps the ladder at the source's own resolution", () => {
		// A 720p source encodes 480p and 720p only: an invented 1080p rung upscales and
		// charges the CDN for it.
		expect(planLadderFor(720, 1280).map((v) => v.height)).toEqual([480, 720]);
		expect(planLadderFor(480, 854).map((v) => v.height)).toEqual([480]);
		// A source with no probed height still gets its floor rung.
		expect(planLadderFor(0, 0).map((v) => v.height)).toEqual([480]);
	});

	it("derives each rung's width from the source aspect ratio, rounded to even", () => {
		const ladder = planLadderFor(1080, 1920); // 16:9
		expect(ladder.find((v) => v.height === 480)?.width).toBe(854);
		const portrait = planLadderFor(1920, 1080); // 9:16
		expect(portrait.find((v) => v.height === 480)?.width).toBe(270);
	});
});

describe("masterPlaylistLines", () => {
	const ladder = planLadderFor(2160, 3840);

	it("names the rungs it was given, and nothing that is not on the tree yet", () => {
		const lines = masterPlaylistLines(ladder.slice(0, 1), true, false);
		expect(lines).toEqual([
			"#EXTM3U",
			'#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480',
			'480p.m3u8',
		]);
	});

	it("carries the audio group only when a rendition exists to resolve it", () => {
		const withRendition = masterPlaylistLines(ladder, true, true);
		expect(withRendition[1]).toContain('EXT-X-MEDIA:TYPE=AUDIO');
		expect(withRendition[2]).toContain('AUDIO="aud"');
		// The progressive rewrites (rungs alone) name no unreached group.
		const progressive = masterPlaylistLines(ladder.slice(0, 2), true, false);
		expect(progressive).not.toContain('EXT-X-MEDIA');
	});
});