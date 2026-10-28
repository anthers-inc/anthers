// SPDX-License-Identifier: Apache-2.0
/**
 * A video transcode frees its temp footprint as it goes.
 *
 * 🚨 **The worker's filesystem is ephemeral and small, and the platform replaces a container
 * whose disk fills — silently, with no line the app can log.** A job that held a large
 * source beside all of its output is how a burst of uploads bounced that worker every few
 * minutes, so the contract pinned here is two-sided: each pass's files upload the moment
 * its encode completes (observed by reading the job's own progress at the moment of the
 * first upload — under an end-of-job upload loop the progress is already 80), and nothing
 * of the job's is left on the disk after it completes.
 *
 * ⭐ **What no stub can show is the interleaving.** The job runs for real, against a real
 * 720p source — 720 keeps a second variant in the plan, because with one variant there is
 * no "before the next one" to observe — on the same pattern as transcode-no-poster.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { mediaScans, works, workTranscodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { transcodeVideo } from "../jobs/transcode-video.js";
import { storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

/**
 * A two-second synthetic 1080p video WITH an audio track. Height 1080 puts three rungs in
 * the plan, so the shared pass carries two outputs and the rendition — the shape the
 * decode-once work introduced — and the audio gives the rendition a part in the freeing
 * contract.
 */
async function makeVideo(): Promise<Buffer> {
	const path = join(tmpdir(), `resid_${RUN}.mp4`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=2:size=1920x1080:rate=10",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-shortest",
			path,
			"-y",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(await proc.exited).toBe(0);
	const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
	await rm(path).catch(() => {});
	return bytes;
}

/**
 * The names downloadToTemp and the job itself give their temp writes, under both storage
 * backends. A sibling suite's leaked temp file would surface here too — which is an honest
 * failure, because residency is what the disk pays for whichever job wrote the bytes.
 */
const TEMP_PREFIXES = ["hls_", "local_dl_", "s3dl_"];
const listTemp = async (): Promise<string[]> =>
	(await readdir(tmpdir())).filter((n) => TEMP_PREFIXES.some((p) => n.startsWith(p)));

describe("a transcode's temp residency", () => {
	let creatorId: number;
	let jobId: number | null = null;
	let originalUpload: typeof storage.upload;
	let uploadSpy: ReturnType<typeof spyOn>;
	/** The downloads a regression would make: the job must read the source in place. */
	let downloadSpy: ReturnType<typeof spyOn>;
	/** The uploads the spy observed, each with the job's progress read at that moment. */
	const uploads: Array<{ key: string; progress: number | null }> = [];
	let strayTemps: string[] = [];

	beforeAll(async () => {
		creatorId = (await createAccount(`resid_${RUN}`, { fields: { creatorMode: true } })).userId;
		originalUpload = storage.upload.bind(storage);
		uploadSpy = spyOn(storage, "upload").mockImplementation((async (
			key: string,
			body: Buffer | Uint8Array,
			contentType: string,
			acl: "public" | "private",
		) => {
			// Staging uploads pass through before the job exists; only uploads whose
			// progress can be read against the running job are recorded.
			if (jobId != null) {
				const [row] = await db
					.select({ progress: workTranscodingJobs.progress })
					.from(workTranscodingJobs)
					.where(eq(workTranscodingJobs.id, jobId));
				uploads.push({ key, progress: row?.progress ?? null });
			}
			return originalUpload(key, body, contentType, acl);
		}) as typeof storage.upload);
		// The source leg reads in place (a temp copy is the residency class that killed
		// the worker); the mock refuses loudly, so a regression fails THIS job visibly
		// rather than quietly costing the disk again.
		downloadSpy = spyOn(storage, "downloadToTemp").mockRejectedValue(
			new Error("the transcode downloaded its source instead of reading it in place"),
		);

		const sourceKey = `creators/${creatorId}/videos/originals/${RUN}.mp4`;
		await storage.upload(sourceKey, await makeVideo(), "video/mp4", "private");
		const workId = (await insertWork({ creatorId, type: "video", title: `Residency ${RUN}` })).id;
		await db.update(works).set({ sourceKey }).where(eq(works.id, workId));
		await db
			.insert(mediaScans)
			.values({ storageKey: sourceKey, workId, determination: "clean", scannedAt: new Date() });
		const [job] = await db
			.insert(workTranscodingJobs)
			.values({ workId, mediaType: "video", status: "pending" })
			.returning();
		jobId = job.id;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		uploadSpy.mockRestore();
		downloadSpy.mockRestore();
		// The run's own leftovers go too, whether the assertions passed or not — a suite
		// testing the cleanup contract must not become the leak it watches for.
		for (const name of strayTemps) {
			await rm(join(tmpdir(), name), { recursive: true }).catch(() => {});
		}
		await storage.deletePrefix(`creators/${creatorId}/`);
	});

	it("completes with its uploads interleaved into the encodes, not stacked at the end", async () => {
		let straysAfterRun: string[] = [];
		try {
			await transcodeVideo({ jobId: jobId! });
		} finally {
			// Recorded whatever the job left behind, so the sibling test below reads the
			// run rather than re-running it — including after a failure here.
			straysAfterRun = await listTemp();
		}
		strayTemps = straysAfterRun;

		const [job] = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.id, jobId!));
		expect(job.status).toBe("completed");
		expect(job.hlsManifestUrl).toContain("master.m3u8");

		// The uploads landed where a completed job's deliverables always have: in storage,
		// under the prefix the manifest points at, master and rendition and variants all there.
		const prefix = urlToKey(job.hlsManifestUrl ?? "").replace(/\/[^/]+$/, "");
		const master = await storage.read(`${prefix}/master.m3u8`);
		expect(master).not.toBeNull();
		const masterText = new TextDecoder().decode(master ?? new Uint8Array());
		expect(masterText).toContain("#EXTM3U");
		// 🚨 Every rung advertises its own MEASURED rate, and the VBV ceiling is what bounds
		// it. The ABR ladder advertised a constant while its segments peaked at four times it
		// (5 Mbps declared, 20.4 Mbps measured at 1080p on the real benchmark source,
		// 2026-10-28), which is a player stalling on the level it was told it could afford.
		const ceilings: Record<string, number> = {
			"854x480": 1_000_000,
			"1280x720": 2_500_000,
			"1920x1080": 5_000_000,
		};
		/** The master's rungs, as the player reads them: the STREAM-INF line and its playlist. */
		const masterLines = masterText.split("\n").map((line) => line.trim());
		const rungs: Array<{ bandwidth: number; resolution: string; playlist: string }> = [];
		for (const [i, line] of masterLines.entries()) {
			const info = line.match(/#EXT-X-STREAM-INF:BANDWIDTH=(\d+),RESOLUTION=(\d+x\d+)/);
			if (info?.[1] && info[2]) {
				rungs.push({
					bandwidth: Number(info[1]),
					resolution: info[2],
					playlist: masterLines[i + 1] ?? "",
				});
			}
		}
		expect(rungs.map((r) => r.resolution)).toEqual(["854x480", "1280x720", "1920x1080"]);
		for (const rung of rungs) {
			const ceiling = ceilings[rung.resolution];
			expect(ceiling).toBeDefined();
			// A capped encode can overshoot its ceiling by its audio track and the container's
			// overhead; it cannot overshoot it by the multiples an uncapped one did.
			expect(rung.bandwidth).toBeLessThanOrEqual((ceiling ?? 0) * 1.25);
			// ⭐ The advertised figure IS the measurement: recomputed here from the segments
			// the job actually stored, it is their peak rate rounded up to a whole kbps.
			const variant = new TextDecoder().decode(
				(await storage.read(`${prefix}/${rung.playlist}`)) ?? new Uint8Array(),
			);
			const lines = variant.split("\n").map((line) => line.trim());
			let peak = 0;
			for (const [i, line] of lines.entries()) {
				const duration = Number.parseFloat(line.match(/^#EXTINF:([\d.]+)/)?.[1] ?? "0");
				const segment = lines[i + 1];
				if (!(duration > 0) || !segment || segment.startsWith("#")) continue;
				const size = await storage.size(`${prefix}/${segment}`);
				peak = Math.max(peak, (size * 8) / duration);
			}
			expect(rung.bandwidth).toBe(Math.ceil(peak / 1000) * 1000);
		}
		expect(await storage.exists(`${prefix}/audio.m3u8`)).toBe(true);
		expect(await storage.exists(`${prefix}/audio-000.ts`)).toBe(true);
		expect(await storage.exists(`${prefix}/720p.m3u8`)).toBe(true);
		expect(await storage.exists(`${prefix}/1080p.m3u8`)).toBe(true);
		expect(await storage.exists(`${prefix}/480p.m3u8`)).toBe(true);

		const hls = uploads.filter((u) => u.key.includes("/videos/hls/"));
		// A playlist and a segment per variant, a playlist and a segment for the rendition,
		// and the master — more than five is what "all of it landed" looks like from storage.
		expect(hls.length).toBeGreaterThan(5);
		// The first upload happened while the encode-phase spans were still being walked —
		// before the 80 that only the step after the encodes writes. Under an end-of-job
		// upload loop this reads 80, which is exactly the regression the restructure is.
		expect(hls[0]?.progress).toBeLessThan(80);
		// The master is uploaded after every variant and rendition file it names.
		expect(hls.at(-1)?.key.endsWith("master.m3u8")).toBe(true);
		// And the source never became a temp copy: the pin above the run.
		expect(downloadSpy).not.toHaveBeenCalled();
	}, 60_000);

	it("leaves nothing of itself on the disk after it completes", async () => {
		expect(strayTemps).toEqual([]);
	});
});
