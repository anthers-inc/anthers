// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sampling a video into frames, and the policy that decides how many.
 *
 * 🚨 **PDQ is an image hash, so a video is only scanned as well as it is sampled.** That
 * makes `frameSchedule` a safety decision wearing the clothes of an arithmetic helper: too
 * few frames and a match sits between two samples, too many and one upload is tens of
 * thousands of hashes. It is pure so the policy can be argued with directly rather than
 * inferred from an ffmpeg command line.
 *
 * ⚠️ **The ffmpeg cases run real ffmpeg against a video generated on the spot.** A fixture
 * checked into the repo would drift from what ffmpeg actually emits, and the thing most
 * worth proving here — that consecutive frames hash *differently* — cannot be proved with a
 * stub at all. A stubbed reader would happily return the same buffer twice, which is
 * exactly the bug that would make video scanning look like it works while examining one
 * instant of every upload.
 */
import { describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FRAME_INTERVAL_SECONDS,
	frameSchedule,
	hashVideoFrames,
	MAX_FRAMES_PER_VIDEO,
	probeVideo,
} from "../lib/video-frames.js";

describe("frameSchedule — how densely a video is sampled", () => {
	it("gives a short video one frame per interval", () => {
		expect(frameSchedule(100)).toEqual({ interval: 10, count: 10 });
		expect(frameSchedule(FRAME_INTERVAL_SECONDS)).toEqual({ interval: 10, count: 1 });
	});

	it("🚨 never returns zero frames, however short or unreported the duration", () => {
		// A container that will not report its length is exactly the kind of file worth
		// looking at, and a schedule of zero frames would record it as unscannable while
		// looking like a completed scan.
		for (const duration of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(frameSchedule(duration).count, String(duration)).toBeGreaterThanOrEqual(1);
		}
	});

	it("⭐ stretches the interval past the cap rather than truncating the video", () => {
		// The distinction that matters: a three-hour video gets a frame every fifty-odd
		// seconds across the whole thing, NOT ten-second sampling of the first half hour and
		// nothing after it. Truncating would leave the back of every long upload unexamined
		// while the row said the video had been scanned.
		const threeHours = 3 * 60 * 60;
		const schedule = frameSchedule(threeHours);
		expect(schedule.count).toBe(MAX_FRAMES_PER_VIDEO);
		expect(schedule.interval).toBeGreaterThan(FRAME_INTERVAL_SECONDS);
		// The last frame lands at the end of the video, not at the cap's own horizon.
		expect(schedule.interval * schedule.count).toBeCloseTo(threeHours, 5);
	});

	it("keeps sampling inside the interval it promises, at every length", () => {
		// Derived rather than spot-checked. Below the cap the spacing must never exceed the
		// stated interval; above it, the frames must still span the whole duration.
		for (const duration of [1, 9, 11, 60, 999, 1999, 2001, 7200, 36_000]) {
			const { interval, count } = frameSchedule(duration);
			expect(count, `${duration}s count`).toBeLessThanOrEqual(MAX_FRAMES_PER_VIDEO);
			expect(interval * count, `${duration}s span`).toBeCloseTo(duration, 5);
			if (count < MAX_FRAMES_PER_VIDEO) {
				expect(interval, `${duration}s interval`).toBeLessThanOrEqual(FRAME_INTERVAL_SECONDS);
			}
		}
	});
});

/** A synthetic video whose picture changes over time, so frames must differ. */
async function makeVideo(seconds: number, size = "160x120"): Promise<string> {
	const path = join(tmpdir(), `vf_${crypto.randomUUID()}.mp4`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc=duration=${seconds}:size=${size}:rate=10`,
			"-pix_fmt",
			"yuv420p",
			path,
			"-y",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(await proc.exited, "ffmpeg could not generate the fixture video").toBe(0);
	return path;
}

describe("hashVideoFrames — the real ffmpeg path", () => {
	it("probes a generated video for the three facts the sampler needs", async () => {
		const path = await makeVideo(5);
		try {
			const probe = await probeVideo(path);
			expect(probe).not.toBeNull();
			expect(probe!.width).toBe(160);
			expect(probe!.height).toBe(120);
			expect(probe!.durationSeconds).toBeGreaterThan(4);
		} finally {
			await rm(path).catch(() => {});
		}
	});

	it("🚨 hashes each sampled frame differently, proving it moved through the video", async () => {
		// The assertion the whole file exists for. Reading the pipe with the frame size
		// miscalculated, or reusing one buffer, produces the right *number* of hashes with
		// the wrong content — a scan that examines one instant of every upload and reports
		// success. `testsrc` changes every frame, so identical hashes cannot be a coincidence.
		const path = await makeVideo(45);
		try {
			const probe = await probeVideo(path);
			const frames = await hashVideoFrames(path, {
				width: probe!.width,
				height: probe!.height,
				durationSeconds: probe!.durationSeconds,
			});
			expect(frames.length).toBeGreaterThan(2);
			expect(new Set(frames.map((f) => f.hash.hash)).size).toBe(frames.length);
			// 64 hex characters, in the reference byte order a vendor expects.
			for (const frame of frames) {
				expect(frame.hash.hash).toMatch(/^[0-9a-f]{64}$/);
			}
		} finally {
			await rm(path).catch(() => {});
		}
	}, 60_000);

	it("⭐ stamps each frame with where in the video it came from", async () => {
		// The timestamps are what the per-frame `media_scans` keys are built from, so a
		// matching frame can be pointed at rather than merely counted.
		const path = await makeVideo(45);
		try {
			const probe = await probeVideo(path);
			const frames = await hashVideoFrames(path, {
				width: probe!.width,
				height: probe!.height,
				durationSeconds: probe!.durationSeconds,
			});
			const times = frames.map((f) => f.atSeconds);
			expect(times[0]).toBe(0);
			// Strictly increasing: two frames sharing a timestamp would collide on the same
			// `media_scans` key and silently overwrite each other.
			expect([...times].sort((a, b) => a - b)).toEqual(times);
			expect(new Set(times).size).toBe(times.length);
		} finally {
			await rm(path).catch(() => {});
		}
	}, 60_000);

	it("refuses a nonsense frame size rather than reading the pipe forever", async () => {
		// `width * height * 3` is the frame boundary. A zero would make it zero bytes, and
		// the read loop would slice an infinite number of empty frames out of one buffer.
		expect(
			await hashVideoFrames("/nonexistent", { width: 0, height: 0, durationSeconds: 10 }),
		).toEqual([]);
	});

	it("throws when ffmpeg fails and nothing came out, so the object stays owed", async () => {
		// A transient failure must be distinguishable from a genuinely unscannable file:
		// one is retried, the other is recorded. Throwing is what leaves it owed.
		await expect(
			hashVideoFrames("/nonexistent.mp4", { width: 160, height: 120, durationSeconds: 10 }),
		).rejects.toThrow(/ffmpeg/);
	});
});
