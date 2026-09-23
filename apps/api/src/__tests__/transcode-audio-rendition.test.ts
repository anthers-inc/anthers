// SPDX-License-Identifier: Apache-2.0
/**
 * Every video carries an audio-only rendition, so it can be listened to as a podcast.
 *
 * 🚨 **What is under test is the SHAPE of the master playlist, which no stub can show** —
 * the RFC 8216 multi-rendition contract (`#EXT-X-MEDIA` plus an `AUDIO` group on each
 * variant) is a string either side of an upload can break silently while both stay green.
 * This runs the real job on a real video, on the same pattern as transcode-no-poster.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import { mediaScans, transcodingJobs, works } from "@anthers/db/schema";
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

/** A two-second synthetic video WITH an audio track — silent video has no rendition to take. */
async function makeVideo(): Promise<Buffer> {
	const path = join(tmpdir(), `podcast_${RUN}.mp4`);
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

describe("the audio-only rendition", () => {
	let creatorId: number;
	let jobId: number;

	beforeAll(async () => {
		creatorId = (await createAccount(`podcast_${RUN}`, { fields: { isCreator: true } })).userId;
		// The send spy from sibling suites is irrelevant here: the job runs directly.
		const sourceKey = `creators/${creatorId}/videos/originals/${RUN}.mp4`;
		await storage.upload(sourceKey, await makeVideo(), "video/mp4", "private");
		const workId = (await insertWork({ creatorId, type: "video", title: `Podcast ${RUN}` })).id;
		await db.update(works).set({ sourceKey }).where(eq(works.id, workId));
		await db
			.insert(mediaScans)
			.values({ storageKey: sourceKey, workId, determination: "clean", scannedAt: new Date() });
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "video", status: "pending" })
			.returning();
		jobId = job.id;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await storage.deletePrefix(`creators/${creatorId}/`);
	});

	it("produces audio.m3u8 and its segments beside the variants", async () => {
		await transcodeVideo({ jobId });

		const [job] = await db.select().from(transcodingJobs).where(eq(transcodingJobs.id, jobId));
		expect(job.status).toBe("completed");
		const prefix = urlToKey(job.hlsManifestUrl ?? "").replace(/\/[^/]+$/, "");

		// The rendition exists in storage — the master playlist alone proving nothing.
		const audioPlaylist = await storage.read(`${prefix}/audio.m3u8`);
		expect(audioPlaylist).not.toBeNull();
		expect(new TextDecoder().decode(audioPlaylist ?? new Uint8Array())).toContain("#EXTM3U");
		expect(await storage.exists(`${prefix}/audio-000.ts`)).toBe(true);

		// And the master names it, per RFC 8216's media-rendition contract: the one audio
		// group the variants all reference, replacing each one's muxed audio it would have.
		const masterBytes = await storage.read(`${prefix}/master.m3u8`);
		expect(masterBytes).not.toBeNull();
		const master = new TextDecoder().decode(masterBytes ?? new Uint8Array());
		expect(master).toContain(
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Spoken",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
		);
		const variants = master.split("\n").filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
		expect(variants.length).toBeGreaterThan(0);
		for (const variant of variants) {
			expect(variant).toContain(',AUDIO="aud"');
		}
	}, 60_000);
});
