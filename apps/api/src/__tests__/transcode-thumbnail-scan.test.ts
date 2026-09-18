// SPDX-License-Identifier: Apache-2.0
/**
 * The poster thumbnail a video transcode generates is queued for a scan the moment it exists.
 *
 * 🚨 **The transcode is a writer of a Work's objects, and it used to skip detection.** It wrote
 * the thumbnail straight onto the Work, into the public bucket, and nothing queued a scan for it,
 * so the hourly `rescan-owed` sweep was the only thing that ever looked. On production on
 * 2026-09-18 a released video's poster went 23 minutes unscanned that way. This runs the real job
 * on a real video, because the gap was in which code the job calls, which no stub can show.
 *
 * ⚠️ **The source is given an answer first, so the only scan owed is the thumbnail's.** That is
 * the ordinary case — the video's own scan finishes long before its encode — and it also proves
 * the job does not send the whole video again to cover a new thumbnail.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { mediaScans, transcodingJobs, works } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { JOB_OPTIONS, QUEUES, queue } from "../jobs/queue.js";
import { transcodeVideo } from "../jobs/transcode-video.js";
import { storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";
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

describe("a video transcode's generated thumbnail", () => {
	let creatorId: number;
	let workId: number;
	let sent: Array<{ name: string; data: unknown; options: unknown }> = [];
	let sendSpy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		creatorId = (await createAccount(`tts_${RUN}`, { fields: { isCreator: true } })).userId;
		const sourceKey = `creators/${creatorId}/videos/originals/${RUN}.mp4`;
		await storage.upload(sourceKey, await makeVideo(), "video/mp4", "private");

		workId = (await insertWork({ creatorId, type: "video", title: `Thumbnail scan ${RUN}` })).id;
		await db.update(works).set({ sourceKey, thumbnail: null }).where(eq(works.id, workId));
		await db
			.insert(mediaScans)
			.values({ storageKey: sourceKey, workId, determination: "clean", scannedAt: new Date() });

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

	it("is queued for a scan as soon as the transcode attaches it, and nothing else is", async () => {
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "video", status: "pending" })
			.returning();
		sent = [];

		await transcodeVideo({ jobId: job.id });

		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work.thumbnail).toBeTruthy();
		const thumbnailKey = urlToKey(work.thumbnail as string);
		expect(sent.filter((s) => s.name === QUEUES.SCAN_MEDIA)).toEqual([
			{
				name: QUEUES.SCAN_MEDIA,
				data: { storageKey: thumbnailKey, workId, kind: "image" },
				options: JOB_OPTIONS[QUEUES.SCAN_MEDIA],
			},
		]);
		// The release gate waits on the new object, which it can only do with a clock running.
		expect(work.scanQueuedAt).toBeInstanceOf(Date);
	}, 60_000);
});
