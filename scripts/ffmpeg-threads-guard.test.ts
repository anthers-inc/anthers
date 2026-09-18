// SPDX-License-Identifier: Apache-2.0
/**
 * Every ffmpeg the API runs is built by `ffmpegCommand`, so its threads are pinned.
 *
 * 🚨 **An ffmpeg left to choose its own thread count sizes itself to the host's cores rather
 * than the worker's**, and every thread holds frames of its own: a 4K source encoded to 1080p
 * peaked at 1,418 MB unpinned and 400 MB pinned, on a worker with 512 MB. The helper is only
 * worth anything if nothing goes around it, and the next ffmpeg added to a job is the one that
 * would — so this refuses any source under `apps/api/src` that names `"ffmpeg"` as a program
 * anywhere but the helper itself. `lib/ffmpeg.ts` carries the measurements.
 *
 * The seeding scripts are exempt. They run once on a developer's machine to build fixtures, and
 * never in the worker.
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { FFMPEG_THREADS, ffmpegCommand } from "../apps/api/src/lib/ffmpeg";

const ROOT = "apps/api/src";
const HELPER = "lib/ffmpeg.ts";

function isExempt(rel: string): boolean {
	return (
		rel === HELPER ||
		rel.startsWith("scripts/") ||
		rel.includes("__tests__/") ||
		/\.test\.tsx?$/.test(rel)
	);
}

/** The API's sources, as paths relative to `apps/api/src`. */
async function sourceFiles(): Promise<string[]> {
	const found: string[] = [];
	for await (const rel of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: ROOT })) {
		if (!rel.includes("node_modules/")) found.push(rel);
	}
	return found;
}

/** `"ffmpeg"` as a string literal, which is how a program name reaches `Bun.spawn`. */
const NAMES_FFMPEG = /["'`]ffmpeg["'`]/;

describe("ffmpegCommand", () => {
	it("pins the decoder before the input and the encoder after it", () => {
		const threads = ["-threads", String(FFMPEG_THREADS)];
		const command = ffmpegCommand("in.mp4", ["-c:v", "libx264", "out.m3u8"], ["-v", "error"]);
		expect(command).toEqual([
			"ffmpeg",
			"-v",
			"error",
			...threads,
			"-i",
			"in.mp4",
			...threads,
			"-c:v",
			"libx264",
			"out.m3u8",
		]);
	});
});

describe("no ffmpeg outside the helper", () => {
	it("scans the worker's sources, so a broken glob cannot pass silently", async () => {
		const files = await sourceFiles();
		expect(files).toContain("jobs/transcode-video.ts");
		expect(files).toContain("jobs/process-audio.ts");
		expect(files).toContain("lib/video-frames.ts");
	});

	it("finds no source that spawns ffmpeg itself", async () => {
		const offenders: string[] = [];
		for (const rel of await sourceFiles()) {
			if (isExempt(rel)) continue;
			if (NAMES_FFMPEG.test(await Bun.file(join(ROOT, rel)).text())) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});
});
