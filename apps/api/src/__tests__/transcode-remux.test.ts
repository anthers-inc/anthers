// SPDX-License-Identifier: Apache-2.0
/**
 * The remux through the real job, on files ffmpeg itself produced — the two behaviors
 * a creator meets:
 *
 *   - **An OBS-shaped upload remuxes and plays.** An H.264+AAC file in MKV (OBS's
 *     default) is copied into an MP4 beside the original, the Work is re-pointed at
 *     it, its scan is queued like any other attach, and the ladder completes against
 *     the copy. Nothing re-encodes the source — the copy's streams are the answer.
 *   - **A codec pair outside the accepted set is refused quietly.** The job row goes
 *     `failed` with the creator-facing sentence naming the set, and the handler
 *     RETURNS rather than throwing — no second attempt of a decision that cannot
 *     change.
 *
 * These run the real transcode (a two-second synthetic source), because what is under
 * test is which commands the job runs against a real container — every stub expresses
 * the answer the test wrote first.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { mediaScans, transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { QUEUES, queue } from "../jobs/queue.js";
import { transcodeVideo } from "../jobs/transcode-video.js";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

/**
 * A two-second synthetic video with spoken audio, in a container of the test's
 * choosing — the same testsrc the other transcode suites run, plus a sine tone, so the
 * source carries both the streams a real capture does.
 */
async function makeVideo(
	container: "matroska" | "mp4",
	audioCodec: string,
	videoCodec = "libx264",
): Promise<Buffer> {
	const path = join(tmpdir(), `trx_${RUN}.${container === "matroska" ? "mkv" : "mp4"}`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=2:size=160x120:rate=10",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-c:v",
			videoCodec,
			"-c:a",
			audioCodec,
			"-pix_fmt",
			"yuv420p",
			"-f",
			container,
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

describe("a video transcode's ingest three-way", () => {
	let creatorId: number;
	let sent: Array<{ name: string; data: { storageKey: string; workId: number; kind?: string } }> =
		[];
	let sendSpy: ReturnType<typeof spyOn>;

	async function stage(
		label: string,
		bytes: Buffer,
		filename: string,
	): Promise<{ workId: number; jobId: number }> {
		const sourceKey = `creators/${creatorId}/videos/originals/${RUN}-${filename}`;
		await storage.upload(sourceKey, bytes, "video/x-container", "private");
		const workId = (await insertWork({ creatorId, type: "video", title: `Remux ${label} ${RUN}` }))
			.id;
		await db.update(works).set({ sourceKey, thumbnail: null }).where(eq(works.id, workId));
		// The source object's own scan answer, exactly as an attach of it queued one —
		// what the remuxed copy arrives owing is what the suite's last assertion reads.
		await db
			.insert(mediaScans)
			.values({ storageKey: sourceKey, workId, determination: "clean", scannedAt: new Date() });
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "video", status: "pending" })
			.returning();
		return { workId, jobId: job.id };
	}

	beforeAll(async () => {
		creatorId = (await createAccount(`trx_${RUN}`, { fields: { creatorMode: true } })).userId;
		sendSpy = spyOn(queue, "send").mockImplementation((async (
			name: string,
			data: { storageKey: string; workId: number; kind?: string },
		) => {
			sent.push({ name, data });
			return "job";
		}) as typeof queue.send);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		sendSpy.mockRestore();
		await storage.deletePrefix(`creators/${creatorId}/`);
	});

	it("remuxes an OBS-shaped MKV beside the original, re-points the Work, queues the copy's scan, and completes the ladder", async () => {
		sent = [];
		const { workId, jobId } = await stage("mkv", await makeVideo("matroska", "aac"), "capture.mkv");

		await transcodeVideo({ jobId });

		// The ladder completed — the encode ran against the copy, not the MKV.
		const [job] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, jobId));
		expect(job.status).toBe("completed");
		expect(job.hlsManifestUrl).toMatch(/master\.m3u8$/);

		// The Work points at the copy: the same directory and stem as the original, the
		// pair's native container.
		const [work] = await db.select().from(works).where(eq(works.id, workId));
		const remuxedSourceKey = work.sourceKey ?? "";
		const originalKey = `creators/${creatorId}/videos/originals/${RUN}-capture.mkv`;
		expect(remuxedSourceKey).toBe(`creators/${creatorId}/videos/originals/${RUN}-capture.mp4`);

		// The copy is really in storage, and its video stream is the H.264 the source carried.
		const probe = await probeStreams(remuxedSourceKey);
		expect(probe.streams.some((s) => s.codec_name === "h264")).toBe(true);

		// The remuxed copy is an attach by another name: its scan is queued, and the
		// original's answer — already recorded before the remux — is the suite's proof
		// that what was queued is for the COPY.
		const scanSends = sent.filter((s) => s.name === QUEUES.SCAN_MEDIA);
		expect(scanSends).toHaveLength(1);
		expect(scanSends[0].data.storageKey).toBe(remuxedSourceKey);
		expect(scanSends[0].data.storageKey).not.toBe(originalKey);
	}, 120_000);

	it("refuses a codec pair outside the accepted set, quietly and finally", async () => {
		sent = [];
		// Capture-tool audio: PCM in an MKV. The video is H.264; the pair has no native
		// container that plays both, so it is a refusal rather than a remux.
		const { workId, jobId } = await stage(
			"pcm",
			await makeVideo("matroska", "pcm_s16le"),
			"refuse.mkv",
		);

		// The handler returns normally — no throw, so the queue's job completes and no
		// retry re-runs the answer — and the row is failed with the creator-facing copy.
		await transcodeVideo({ jobId });

		const [job] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, jobId));
		expect(job.status).toBe("failed");
		expect(job.errorMessage).toContain("The accepted set is");
		expect(job.errorMessage).toContain("H.264");

		// A refusal leaves the Work pointing where it was; nothing was remuxed or queued.
		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work.sourceKey).toContain("refuse.mkv");
		expect(sent.filter((s) => s.name === QUEUES.SCAN_MEDIA)).toEqual([]);
	}, 60_000);

	it("an upload already in its native container skips the remux entirely", async () => {
		sent = [];
		const { workId, jobId } = await stage("mp4", await makeVideo("mp4", "aac"), "already.mp4");

		await transcodeVideo({ jobId });

		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work.sourceKey).toContain("already.mp4");
		// No scan was queued: attaching this source recorded its answer; the Work's own
		// objects were not changed by a pass that never touched storage.
		expect(sent.filter((s) => s.name === QUEUES.SCAN_MEDIA)).toEqual([]);
		const [job] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, jobId));
		expect(job.status).toBe("completed");
	}, 60_000);
});

/** Run the job's own ffprobe over the copy in storage, read at its readability address. */
async function probeStreams(
	sourceKey: string,
): Promise<{ streams: Array<{ codec_name?: string }> }> {
	const address = await storage.readableInput(sourceKey);
	const bytes = address.startsWith("http")
		? Buffer.from(await (await fetch(address)).arrayBuffer())
		: Buffer.from(await Bun.file(address).arrayBuffer());
	const path = join(tmpdir(), `trx_probe_${RUN}`);
	await Bun.write(path, bytes);
	try {
		const proc = Bun.spawn(
			["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", path],
			{
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(await proc.exited).toBe(0);
		return JSON.parse(await new Response(proc.stdout).text());
	} finally {
		await rm(path).catch(() => {});
	}
}
