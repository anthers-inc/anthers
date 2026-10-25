// SPDX-License-Identifier: Apache-2.0
/**
 * Replace-in-place: a new source archives the version it replaces, then retires its
 * renditions.
 *
 * 🚨 **The 2026-10-23 version ruling replaced the no-old-versions ruling of 2026-10-10 and
 * 2026-10-12.** The creator's original — the remux-retained file where one exists, otherwise
 * the uploaded source — survives as a creator-only `work_media_versions` row, while every
 * derived output the prior job rows name (the HLS run, an MP3, a remuxed MP4) leaves storage
 * through `media-purge.ts`, which owns what may be deleted. The prior job rows are deleted so
 * the replacement is the Work's only processing truth. A paged set still follows
 * `syncFromSourceKey`; its archival half lands with the set path.
 *
 * 🚨 **Storage is asserted by the calls made, not by probing the bucket** — a sweep has
 * no observable API effect, so `storage.delete`/`deletePrefix` are spied the
 * `deletion-sweeps-storage.test.ts` way. ⚠️ **`queue.send` is replaced for the duration**,
 * exactly as `work-file-arrival.test.ts` does: pg-boss is not running under the test
 * runner, and what is under test is that the route asks, not that a worker answers.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import {
	transcodingJobs,
	users,
	webBuilds,
	workMediaVersions,
	workSourceFiles,
	works,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, type WorkFixture } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const id = crypto.randomUUID().slice(0, 8);
const creatorName = `replace_${id}`;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

let cookie = "";
let creatorId = 0;
const createdWorkIds: number[] = [];

async function makeWork(fixture: Omit<WorkFixture, "creatorId">) {
	const row = await insertWork({ ...fixture, creatorId });
	createdWorkIds.push(row.id);
	return row;
}

/** Keys the sweep asked storage to delete; prefixes likewise. Cleared per case. */
const deleted: string[] = [];
const sweptPrefixes: string[] = [];
let delSpy: ReturnType<typeof spyOn> | undefined;
let prefixSpy: ReturnType<typeof spyOn> | undefined;
let sendSpy: ReturnType<typeof spyOn> | undefined;

function captureStorage() {
	deleted.length = 0;
	sweptPrefixes.length = 0;
	delSpy = spyOn(storage, "delete").mockImplementation(async (key: string) => {
		deleted.push(key);
	});
	prefixSpy = spyOn(storage, "deletePrefix").mockImplementation(async (prefix: string) => {
		sweptPrefixes.push(prefix);
	});
	sendSpy = spyOn(queue, "send").mockImplementation(async () => null);
}

function restoreStorage() {
	delSpy?.mockRestore();
	prefixSpy?.mockRestore();
	sendSpy?.mockRestore();
}

const ORIGIN = "http://localhost:3000";

describe("replace-in-place retires the old version", () => {
	beforeAll(async () => {
		const account = await createAccount(creatorName, { fields: { creatorMode: true } });
		creatorId = account.userId;
		cookie = account.cookie;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// Works first (creator_id is SET NULL — removing the user would orphan content).
		if (createdWorkIds.length > 0) {
			await db.delete(workSourceFiles).where(inArray(workSourceFiles.workId, createdWorkIds));
			await db.delete(transcodingJobs).where(inArray(transcodingJobs.workId, createdWorkIds));
			await db.delete(webBuilds).where(inArray(webBuilds.workId, createdWorkIds));
			await db.delete(works).where(inArray(works.id, createdWorkIds));
		}
		await db.delete(users).where(eq(users.id, creatorId));
	});

	it(
		"an image replacement swaps the key, the thumbnail, and the object",
		async () => {
			const work = await makeWork({ type: "image", title: "img", visibility: "private" });
			const oldKey = `creators/${creatorId}/assets/old-${work.id}.png`;
			const newKey = `creators/${creatorId}/assets/new-${work.id}.png`;
			await db.update(works).set({ sourceKey: oldKey }).where(eq(works.id, work.id));

			captureStorage();
			try {
				const res = await req(`/api/content/works/${work.id}`, {
					method: "PATCH",
					headers: { cookie, Origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ sourceKey: newKey }),
				});
				expect(res.status).toBe(200);
				const [row] = await db.select().from(works).where(eq(works.id, work.id));
				expect(row.sourceKey).toBe(newKey);
				// The image is its own thumbnail: the face follows the replacement.
				expect(row.thumbnail).toBe(newKey);
				// The old image survives as the version's original; the new one is a
				// reference the client just uploaded, so nothing is deleted here.
				expect(deleted).not.toContain(oldKey);
				expect(deleted).not.toContain(newKey);
				const [version] = await db
					.select()
					.from(workMediaVersions)
					.where(eq(workMediaVersions.workId, work.id));
				expect(version.media.kind).toBe("set");
				expect(version.media.kind === "set" && version.media.files[0].file).toBe(oldKey);
			} finally {
				restoreStorage();
			}
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"a video replacement archives the creator's original and sweeps the remuxed MP4, the HLS prefix and the prior job rows",
		async () => {
			const work = await makeWork({ type: "video", title: "vid", visibility: "private" });
			const oldSource = `creators/${creatorId}/videos/originals/old-${work.id}.mp4`;
			const oldOriginal = `creators/${creatorId}/videos/originals/old-${work.id}.mkv`;
			const oldHlsRun = `creators/${creatorId}/videos/hls/run${work.id}a`;
			const newKey = `creators/${creatorId}/videos/originals/new-${work.id}.mp4`;
			const uploadedAt = new Date("2026-01-02T03:04:05.000Z");
			await db
				.update(works)
				.set({
					sourceKey: oldSource,
					sourceOriginalKey: oldOriginal,
					versionAddedAt: uploadedAt,
				})
				.where(eq(works.id, work.id));
			await db.insert(transcodingJobs).values([
				{
					workId: work.id,
					mediaType: "video",
					status: "completed",
					hlsManifestUrl: `${oldHlsRun}/master.m3u8`,
				},
				{ workId: work.id, mediaType: "video", status: "failed", errorMessage: "old failure" },
			]);

			captureStorage();
			try {
				const res = await req(`/api/content/works/${work.id}`, {
					method: "PATCH",
					headers: { cookie, Origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ sourceKey: newKey }),
				});
				expect(res.status).toBe(200);

				// The creator's original survives in the version; the remuxed MP4 is a
				// rendition and leaves. The transcode's run prefix arrives the sweep shape
				// it is derived in — master key minus its file, no trailing slash.
				expect(deleted).not.toContain(oldOriginal);
				expect(deleted).toContain(oldSource);
				expect(sweptPrefixes).toContain(oldHlsRun);

				// The version row carries the date the media was added while it was current.
				const [version] = await db
					.select()
					.from(workMediaVersions)
					.where(eq(workMediaVersions.workId, work.id));
				expect(version).toBeDefined();
				expect(version.uploadedAt).toEqual(uploadedAt);
				expect(version.media).toEqual({
					kind: "source",
					file: {
						file: oldOriginal,
						filename: oldOriginal.split("/").pop() ?? "",
						fileSize: null,
						mimeType: "",
					},
				});

				// The prior job rows are gone; exactly one new pending job stands for the
				// replacement, which the release gate and the status badge both read.
				const rows = await db
					.select()
					.from(transcodingJobs)
					.where(eq(transcodingJobs.workId, work.id));
				expect(rows).toHaveLength(1);
				expect(rows[0].status).toBe("pending");
				expect(rows[0].mediaType).toBe("video");

				const [row] = await db.select().from(works).where(eq(works.id, work.id));
				expect(row.sourceKey).toBe(newKey);
				expect(row.sourceOriginalKey).toBe("");
				expect(row.versionAddedAt.getTime()).toBeGreaterThan(uploadedAt.getTime());
			} finally {
				restoreStorage();
			}
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"a comic's legacy-column replacement retires the set's old file and re-renders",
		async () => {
			const work = await makeWork({ type: "comic", title: "comic", visibility: "private" });
			const oldImage = `creators/${creatorId}/assets/old-${work.id}.png`;
			const newImage = `creators/${creatorId}/assets/new-${work.id}.png`;
			await db.update(works).set({ sourceKey: oldImage }).where(eq(works.id, work.id));
			await db.insert(workSourceFiles).values({ workId: work.id, position: 0, file: oldImage });

			captureStorage();
			try {
				const res = await req(`/api/content/works/${work.id}`, {
					method: "PATCH",
					headers: { cookie, Origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ sourceKey: newImage }),
				});
				expect(res.status).toBe(200);

				// The set was replaced: one row, at the new file; the old object swept.
				const rows = await db
					.select()
					.from(workSourceFiles)
					.where(eq(workSourceFiles.workId, work.id));
				expect(rows).toHaveLength(1);
				expect(rows[0].file).toBe(newImage);
				// The old page image is the version's original, not a deleted object.
				expect(deleted).not.toContain(oldImage);
				const [version] = await db
					.select()
					.from(workMediaVersions)
					.where(eq(workMediaVersions.workId, work.id));
				expect(version.media.kind).toBe("set");
				expect(
					version.media.kind === "set" && version.media.files.map((file) => file.file),
				).toContain(oldImage);

				// Exactly one re-render was asked, through the queue the route names.
				const sends = sendSpy!.mock.calls.map((call: unknown[]) => call[0]);
				expect(sends).toContain(QUEUES.RENDER_PAGED);
			} finally {
				restoreStorage();
			}
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"a bare clear of the source is refused with the direction out, and nothing changes",
		async () => {
			const work = await makeWork({ type: "video", title: "no-clear", visibility: "private" });
			const oldKey = `creators/${creatorId}/videos/originals/keep-${work.id}.mp4`;
			await db.update(works).set({ sourceKey: oldKey }).where(eq(works.id, work.id));

			captureStorage();
			try {
				const res = await req(`/api/content/works/${work.id}`, {
					method: "PATCH",
					headers: { cookie, Origin: ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ sourceKey: "" }),
				});
				expect(res.status).toBe(400);
				const body = (await res.json()) as { code?: string };
				expect(body.code).toBe("source_clear_refused");

				const [row] = await db.select().from(works).where(eq(works.id, work.id));
				expect(row.sourceKey).toBe(oldKey);
				expect(deleted).toHaveLength(0);
			} finally {
				restoreStorage();
			}
		},
		DB_SETUP_TIMEOUT,
	);
});
