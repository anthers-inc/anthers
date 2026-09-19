// SPDX-License-Identifier: Apache-2.0
/**
 * A video transcode takes no thumbnail on its creator's behalf.
 *
 * 🚨 **A video's thumbnail is its creator's choice, uploaded or picked from a frame** (Parker,
 * 2026-09-18: *"this is how every other video platform works"*). A still the platform takes could
 * be any moment of a Mature or Adult video, and a thumbnail is what feeds show to everybody, so
 * the transcode leaves the Work without one and release refuses it until the creator chooses
 * (`thumbnail_missing`). This runs the real job on a real video, because what is under test is
 * which code the job calls, which no stub can show.
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

/** A two-second synthetic video, small enough that the real encode is quick. */
async function makeVideo(): Promise<Buffer> {
	const path = join(tmpdir(), `tts_${RUN}.mp4`);
	const proc = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc=duration=2:size=160x120:rate=10",
			"-pix_fmt",
			"yuv420p",
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

describe("a video transcode", () => {
	let creatorId: number;
	let sent: Array<{ name: string; data: unknown; options: unknown }> = [];
	let sendSpy: ReturnType<typeof spyOn>;

	/** A video Work whose source already has its answer, and a pending transcode for it. */
	async function stage(label: string): Promise<{ workId: number; jobId: number }> {
		const sourceKey = `creators/${creatorId}/videos/originals/${RUN}-${label}.mp4`;
		await storage.upload(sourceKey, await makeVideo(), "video/mp4", "private");
		const workId = (
			await insertWork({ creatorId, type: "video", title: `Thumbnail ${label} ${RUN}` })
		).id;
		await db.update(works).set({ sourceKey, thumbnail: null }).where(eq(works.id, workId));
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
		creatorId = (await createAccount(`tts_${RUN}`, { fields: { isCreator: true } })).userId;
		sendSpy = spyOn(queue, "send").mockImplementation((async (
			name: string,
			data: unknown,
			options: unknown,
		) => {
			sent.push({ name, data, options });
			return "job";
		}) as typeof queue.send);
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		sendSpy.mockRestore();
		// The Work, its transcode and its scan rows go with the account.
		await storage.deletePrefix(`creators/${creatorId}/`);
	});

	it("finishes the encode and leaves the Work without a thumbnail, with nothing sent to scan", async () => {
		const { workId, jobId } = await stage("no-poster");
		sent = [];

		await transcodeVideo({ jobId });

		const [job] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, jobId));
		expect(job.status).toBe("completed");
		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work.thumbnail).toBeNull();
		expect(sent.filter((s) => s.name === QUEUES.SCAN_MEDIA)).toEqual([]);
	}, 60_000);
});
