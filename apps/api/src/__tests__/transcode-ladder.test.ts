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
 *
 * The shared pass's command is pinned here too: it is the shape that makes two rungs and
 * the rendition cost one decode instead of three, and the smallest rung's absence from it
 * is what keeps the first rung publishing early.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LADDER_CRF,
	masterPlaylistLines,
	measurePassBandwidths,
	planLadderFor,
	sharedPassOutputs,
	singlePassOutputs,
} from "../jobs/transcode-video.js";

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

describe("the rungs' rate control", () => {
	// 🚨 Every rung is CRF under its own VBV ceiling, and `-b:v` is what must NOT be there:
	// naming a bitrate beside `-crf` turns x264 back into the ABR mode this replaced.
	const rung = planLadderFor(720, 1280).find((v) => v.name === "720p");
	if (!rung) throw new Error("the 720p rung is missing from the plan");

	it("asks for CRF with the rung's ceiling as a VBV bound", () => {
		const args = singlePassOutputs(rung, "/out");
		expect(args).toContain("-crf");
		expect(args[args.indexOf("-crf") + 1]).toBe(String(LADDER_CRF));
		expect(args[args.indexOf("-maxrate") + 1]).toBe("2500k");
		expect(args[args.indexOf("-bufsize") + 1]).toBe("5000k");
		expect(args).not.toContain("-b:v");
	});

	it("carries the same rate control into the shared pass", () => {
		const outputs = sharedPassOutputs(planLadderFor(1080, 1920).slice(1), "/out", true);
		expect(outputs.join(" ")).toContain(`-crf ${LADDER_CRF}`);
		expect(outputs.join(" ")).not.toContain("-b:v");
		// Each tall rung names its own ceiling, so a 1080p branch is not bounded at 720p's.
		expect(outputs.join(" ")).toContain("-maxrate 5000k");
		expect(outputs.join(" ")).toContain("-maxrate 2500k");
	});
});

describe("measurePassBandwidths", () => {
	const dirs: string[] = [];
	const makeDir = async () => {
		const dir = join(tmpdir(), `bw_${crypto.randomUUID().slice(0, 8)}`);
		await mkdir(dir, { recursive: true });
		dirs.push(dir);
		return dir;
	};
	afterAll(async () => {
		for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	});

	it("advertises the peak segment's own rate, not the rung's ceiling", async () => {
		const dir = await makeDir();
		// Two six-second segments: 750 kB is 1000 kbps, 300 kB is 400 kbps.
		await Bun.write(join(dir, "720p_000.ts"), new Uint8Array(750_000));
		await Bun.write(join(dir, "720p_001.ts"), new Uint8Array(300_000));
		await Bun.write(
			join(dir, "720p.m3u8"),
			["#EXTM3U", "#EXTINF:6.000000,", "720p_000.ts", "#EXTINF:6.000000,", "720p_001.ts"].join(
				"\n",
			),
		);
		const rung = planLadderFor(720, 1280).find((v) => v.name === "720p");
		if (!rung) throw new Error("the 720p rung is missing from the plan");
		expect(rung.bandwidth).toBe(2500000);
		await measurePassBandwidths(dir, [rung]);
		expect(rung.bandwidth).toBe(1000000);
	});

	it("rounds the advertised rate up, so it is never short of the segment", async () => {
		const dir = await makeDir();
		// 750,100 bytes over six seconds is 1000133.3… bps.
		await Bun.write(join(dir, "480p_000.ts"), new Uint8Array(750_100));
		await Bun.write(
			join(dir, "480p.m3u8"),
			["#EXTM3U", "#EXTINF:6.000000,", "480p_000.ts"].join("\n"),
		);
		const rung = planLadderFor(480, 854)[0];
		await measurePassBandwidths(dir, [rung]);
		expect(rung?.bandwidth).toBe(1001000);
	});

	it("keeps the planned ceiling when a rung's files are not there", async () => {
		const dir = await makeDir();
		const rung = planLadderFor(1080, 1920)[0];
		await measurePassBandwidths(dir, [rung]);
		expect(rung?.bandwidth).toBe(1000000);
	});
});

describe("sharedPassOutputs", () => {
	// The tall rungs only: the smallest is encoded alone so the release gate opens on it.
	const tall = planLadderFor(1080, 1920).slice(1);

	it("scales every tall rung from one decode, in one filtergraph", () => {
		const outputs = sharedPassOutputs(tall, "/out", true);
		expect(outputs[0]).toBe("-filter_complex");
		expect(outputs[1]).toBe(
			"[0:v]split=2[vsrc0][vsrc1];[vsrc0]scale=-2:720[v0];[vsrc1]scale=-2:1080[v1];[0:a]asplit=3[a0][a1][a2]",
		);
		// The split has as many branches as rungs, in the order the ladder planned them.
		expect(outputs[1]).not.toContain("480");
	});

	it("gives each rung its own muxer and the rendition its own playlist", () => {
		const outputs = sharedPassOutputs(tall, "/out", true);
		for (const name of ["720p", "1080p"]) {
			expect(outputs).toContain(join("/out", `${name}.m3u8`));
			expect(outputs).toContain(join("/out", `${name}_%03d.ts`));
		}
		// The audio-only rendition rides the same pass, so its decode is the shared one.
		expect(outputs).toContain(join("/out", "audio.m3u8"));
		expect(outputs).toContain(join("/out", "audio-%03d.ts"));
		expect(outputs.join(" ")).toContain("-hls_playlist_type vod");
	});

	it("drops the audio branches and the rendition for a silent source", () => {
		const outputs = sharedPassOutputs(tall, "/out", false);
		const filter = outputs[1] ?? "";
		expect(filter).not.toContain("[0:a]");
		expect(filter).not.toContain("asplit");
		expect(outputs).not.toContain(join("/out", "audio.m3u8"));
	});
});

describe("masterPlaylistLines", () => {
	const ladder = planLadderFor(2160, 3840);

	it("names the rungs it was given, and nothing that is not on the tree yet", () => {
		const lines = masterPlaylistLines(ladder.slice(0, 1), true, false);
		expect(lines).toEqual([
			"#EXTM3U",
			"#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480",
			"480p.m3u8",
		]);
	});

	it("carries the audio group only when a rendition exists to resolve it", () => {
		const withRendition = masterPlaylistLines(ladder, true, true);
		expect(withRendition[1]).toContain("EXT-X-MEDIA:TYPE=AUDIO");
		expect(withRendition[2]).toContain('AUDIO="aud"');
		// The progressive rewrites (rungs alone) name no unreached group.
		const progressive = masterPlaylistLines(ladder.slice(0, 2), true, false);
		expect(progressive).not.toContain("EXT-X-MEDIA");
	});
});
