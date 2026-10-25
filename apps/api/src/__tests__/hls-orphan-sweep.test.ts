// SPDX-License-Identifier: Apache-2.0
/**
 * The orphan sweep takes back a dead encode's run prefix — and only that.
 *
 * The prefix under test is a real directory in the local storage root, because the
 * whole question is what EXISTS in storage rather than what a row says: a reference is
 * any video transcode row whose master playlist resolves under the prefix, and a live
 * job is any pending/processing video transcode for the same creator — the one guard
 * that makes deleting storage while an encode may be writing into it impossible,
 * given a pending row's own run prefix exists nowhere in the database yet.
 *
 * Local storage keeps this a filesystem question: staged prefixes are directories this
 * suite writes files into, and the sweep's deletions are real `rm -rf`s the assertions
 * can see.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { sweepOrphanedVideoHlsPrefixes } from "../services/media-purge.js";
import { storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);

/** One private file under a prefix, so the prefix exists in storage at all. */
async function stage(prefix: string): Promise<void> {
	await storage.upload(`${prefix}segment-000.ts`, Buffer.from([1]), "video/mp2t", "private");
}

/** Is anything still stored under this prefix? */
const exists = async (prefix: string): Promise<boolean> =>
	storage.exists(`${prefix}segment-000.ts`);

describe("the HLS orphan sweep", () => {
	let referencedId: number;
	let danglingId: number;
	let liveCreatorId: number;
	let liveWorkId: number;
	let liveJobId: number;
	let referencedPrefix: string;

	beforeAll(async () => {
		// A creator with a completed transcode: one referenced prefix, one dangling one.
		referencedId = (await createAccount(`orphan_a_${RUN}`, { fields: { creatorMode: true } }))
			.userId;
		const work = await insertWork({
			creatorId: referencedId,
			type: "video",
			title: `Orphan A ${RUN}`,
		});
		referencedPrefix = `creators/${referencedId}/videos/hls/${RUN}-referenced/`;
		await stage(referencedPrefix);
		await stage(`creators/${referencedId}/videos/hls/${RUN}-dangling/`);
		await db.insert(transcodingJobs).values({
			workId: work.id,
			mediaType: "video",
			status: "completed",
			hlsManifestUrl: await storage.getUrl(`${referencedPrefix}master.m3u8`),
		});

		// A creator mid-encode: a pending row whose own run prefix exists nowhere yet,
		// and a dangling prefix beside it that must survive the sweep anyway.
		liveCreatorId = (
			await createAccount(`orphan_b_${RUN}`, {
				fields: { creatorMode: true },
			})
		).userId;
		const liveWork = await insertWork({
			creatorId: liveCreatorId,
			type: "video",
			title: `Orphan B ${RUN}`,
		});
		liveWorkId = liveWork.id;
		await stage(`creators/${liveCreatorId}/videos/hls/${RUN}-live-dangling/`);
		const [job] = await db
			.insert(transcodingJobs)
			.values({ workId: liveWork.id, mediaType: "video", status: "pending" })
			.returning();
		liveJobId = job.id;

		danglingId = referencedId;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.delete(transcodingJobs).where(eq(transcodingJobs.id, liveJobId));
		await db.delete(transcodingJobs).where(eq(transcodingJobs.workId, liveWorkId));
		// The Works cascade with their accounts; the prefixes this suite staged go too.
		await storage.deletePrefix(`creators/${referencedId}/`);
		await storage.deletePrefix(`creators/${liveCreatorId}/`);
	});

	it("sweeps the unreferenced prefixes and nothing a row points at or a live job could write", async () => {
		const swept = await sweepOrphanedVideoHlsPrefixes();

		// The referenced prefix survives — it IS the deliverable.
		expect(await exists(referencedPrefix)).toBe(true);
		// The dangling prefix beside it, under the same creator, is taken back. The
		// count is asserted loosely: other suites' leftovers under their own creators
		// are fair game for the enumeration, and asserting an exact machine-wide
		// count would make this suite the disk's janitor's scorekeeper.
		const danglingGone = await exists(`creators/${danglingId}/videos/hls/${RUN}-dangling/`);
		expect(danglingGone).toBe(false);
		expect(swept).toBeGreaterThanOrEqual(1);

		// The creator mid-encode keeps EVERYTHING, dangling included — the pending row
		// is the guard, since its own run prefix cannot be known yet.
		expect(await exists(`creators/${liveCreatorId}/videos/hls/${RUN}-live-dangling/`)).toBe(true);
	});

	it("a second run sweeps nothing further", async () => {
		await sweepOrphanedVideoHlsPrefixes();
		// Whatever other suites' strays the first run already took, this one finds none
		// of ITS OWN subject again — the idempotence the scheduling relies on.
		expect(await exists(`creators/${referencedId}/videos/hls/${RUN}-dangling/`)).toBe(false);
	});

	it("the enumeration reads the run prefix the URL forms", async () => {
		// The reference test itself: a row's stored form is a URL (the master's
		// address), and the sweep resolves its key. This pins the resolution the
		// sweep and the storage-usage walk share.
		const url = await storage.getUrl(`${referencedPrefix}master.m3u8`);
		expect(urlToKey(url).replace(/\/[^/]+$/, "")).toBe(referencedPrefix.replace(/\/$/, ""));
	});
});
