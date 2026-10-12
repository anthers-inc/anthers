// SPDX-License-Identifier: Apache-2.0
/**
 * Remove media from an unpublished Work — the creator's clean slate.
 *
 * The route exists because a Work's exit from bad media until now was only full delete
 * or a stuck state: `DELETE /works/:id/media` takes a never-released Work back to the
 * no-media shape a draft is created in, sweeping everything its enumeration names —
 * source, remux-retained original, derived outputs, the paged ebook prefix, thumbnail,
 * assets and builds — through `media-purge.ts`, the one writer for what may be deleted.
 *
 * 🚨 Storage is asserted by the calls made (spied), not by probing the bucket — the
 * calls are the promise a sweep best-efforts toward in production.
 * ⚠️ The gate under test is `releasedAt` — ever-released is never, including withdrawn.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import {
	transcodingJobs,
	users,
	webBuilds,
	workPages,
	workPanels,
	workSourceFiles,
	works,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, type WorkFixture } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const id = crypto.randomUUID().slice(0, 8);
const creatorName = `mediaoff_${id}`;
const strangerName = `mediaoff_other_${id}`;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

let creatorCookie = "";
let strangerCookie = "";
let creatorId = 0;
const createdWorkIds: number[] = [];

async function makeWork(fixture: Omit<WorkFixture, "creatorId">) {
	const row = await insertWork({ ...fixture, creatorId });
	createdWorkIds.push(row.id);
	return row;
}

const deleted: string[] = [];
const sweptPrefixes: string[] = [];
let delSpy: ReturnType<typeof spyOn> | undefined;
let prefixSpy: ReturnType<typeof spyOn> | undefined;

function captureStorage() {
	deleted.length = 0;
	sweptPrefixes.length = 0;
	delSpy = spyOn(storage, "delete").mockImplementation(async (key: string) => {
		deleted.push(key);
	});
	prefixSpy = spyOn(storage, "deletePrefix").mockImplementation(async (prefix: string) => {
		sweptPrefixes.push(prefix);
	});
}

function restoreStorage() {
	delSpy?.mockRestore();
	prefixSpy?.mockRestore();
}

describe("remove an unpublished Work's media", () => {
	beforeAll(async () => {
		const creator = await createAccount(creatorName, { fields: { isCreator: true } });
		creatorId = creator.userId;
		creatorCookie = creator.cookie;
		const stranger = await createAccount(strangerName);
		strangerCookie = stranger.cookie;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		if (createdWorkIds.length > 0) {
			await db.delete(workPanels).where(
				inArray(
					workPanels.pageId,
					(
						await db
							.select({ id: workPages.id })
							.from(workPages)
							.where(inArray(workPages.workId, createdWorkIds))
					).map((r) => r.id),
				),
			);
			await db.delete(workPages).where(inArray(workPages.workId, createdWorkIds));
			await db.delete(workSourceFiles).where(inArray(workSourceFiles.workId, createdWorkIds));
			await db.delete(transcodingJobs).where(inArray(transcodingJobs.workId, createdWorkIds));
			await db.delete(webBuilds).where(inArray(webBuilds.workId, createdWorkIds));
			await db.delete(works).where(inArray(works.id, createdWorkIds));
		}
		await db.delete(users).where(eq(users.id, creatorId));
	});

	it(
		"sweeps everything the Work names and returns the row to the no-media draft shape",
		async () => {
			const work = await makeWork({ type: "video", title: "sweep-me", visibility: "private" });
			const source = `creators/${creatorId}/videos/originals/src-${work.id}.mp4`;
			const original = `creators/${creatorId}/videos/originals/src-${work.id}.mkv`;
			const thumb = `creators/${creatorId}/thumbnails/t-${work.id}.jpg`;
			await db
				.update(works)
				.set({
					sourceKey: source,
					sourceOriginalKey: original,
					thumbnail: thumb,
					durationSeconds: 90,
					scheduledReleaseAt: new Date(Date.now() + 3_600_000),
				})
				.where(eq(works.id, work.id));
			await db.insert(transcodingJobs).values({
				workId: work.id,
				mediaType: "video",
				status: "failed",
				hlsManifestUrl: `creators/${creatorId}/videos/hls/run${work.id}/master.m3u8`,
				errorMessage: "stuck",
			});

			captureStorage();
			try {
				const res = await req(`/api/content/works/${work.id}/media`, {
					method: "DELETE",
					headers: { Cookie: creatorCookie, Origin: ORIGIN },
				});
				expect(res.status).toBe(200);

				const [row] = await db.select().from(works).where(eq(works.id, work.id));
				expect(row.sourceKey).toBe("");
				expect(row.sourceOriginalKey).toBe("");
				expect(row.thumbnail).toBe("");
				expect(row.durationSeconds).toBeNull();
				// A schedule with no media is unmeetable; removing clears it rather than
				// leaving the release sweep waiting forever.
				expect(row.scheduledReleaseAt).toBeNull();

				const jobs = await db.select().from(transcodingJobs).where(eq(transcodingJobs.workId, work.id));
				expect(jobs).toHaveLength(0);

				expect(deleted).toContain(source);
				expect(deleted).toContain(original);
				expect(deleted).toContain(thumb);
				// The run prefix arrives the shape it is derived in — master minus file.
				expect(sweptPrefixes).toContain(`creators/${creatorId}/videos/hls/run${work.id}`);
			} finally {
				restoreStorage();
			}
		},
		DB_SETUP_TIMEOUT,
	);

	it(
		"a paged Work loses its set rows, its pages and its panels, and the whole ebook prefix is swept",
		async () => {
			const work = await makeWork({ type: "comic", title: "paged", visibility: "private" });
			const pdf = `creators/${creatorId}/assets/src-${work.id}.pdf`;
			await db.update(works).set({ sourceKey: pdf }).where(eq(works.id, work.id));
			await db.insert(workSourceFiles).values({ workId: work.id, position: 0, file: pdf });
			const prefix = `creators/${creatorId}/ebook/${work.id}/run/`;
			const [page] = await db
				.insert(workPages)
				.values({ workId: work.id, pageNumber: 1, file: `${prefix}page-0001.jpg`, width: 800, height: 1200 })
				.returning({ id: workPages.id });
			await db.insert(workPanels).values({
				pageId: page.id,
				panelNumber: 1,
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				auto: true,
			});

			captureStorage();
			try {
				const res = await req(`/api/content/works/${work.id}/media`, {
					method: "DELETE",
					headers: { Cookie: creatorCookie, Origin: ORIGIN },
				});
				expect(res.status).toBe(200);

				expect((await db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, work.id)))).toHaveLength(0);
				expect((await db.select().from(workPages).where(eq(workPages.workId, work.id)))).toHaveLength(0);
				// The panels cascade off their page; the sweep's ebook prefix covers the page
				// objects and everything else that run wrote.
				expect(sweptPrefixes).toContain(`creators/${creatorId}/ebook/${work.id}/`);
				expect(deleted).toContain(pdf);
			} finally {
				restoreStorage();
			}
		},
		DB_SETUP_TIMEOUT,
	);

	it("refuses a Work that was ever released — including on its own schedule", async () => {
		const work = await makeWork({ type: "game", title: "released", visibility: "released" });
		captureStorage();
		try {
			const res = await req(`/api/content/works/${work.id}/media`, {
				method: "DELETE",
				headers: { Cookie: creatorCookie, Origin: ORIGIN },
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { code?: string };
			expect(body.code).toBe("media_removal_published");
			expect(deleted).toHaveLength(0);
			expect(sweptPrefixes).toHaveLength(0);
		} finally {
			restoreStorage();
		}
	});

	it("refuses a stranger and answers a stranger 404, not why", async () => {
		const work = await makeWork({ type: "game", title: "owned", visibility: "private" });
		const res = await req(`/api/content/works/${work.id}/media`, {
			method: "DELETE",
			headers: { Cookie: strangerCookie, Origin: ORIGIN },
		});
		expect(res.status).toBe(404);
	});

	it("refuses a quarantined Work with a 404 that says neither yes nor no", async () => {
		const work = await makeWork({ type: "video", title: "held", visibility: "private" });
		await db
			.update(works)
			.set({ quarantineStatus: "quarantined" })
			.where(eq(works.id, work.id));
		captureStorage();
		try {
			const res = await req(`/api/content/works/${work.id}/media`, {
				method: "DELETE",
				headers: { Cookie: creatorCookie, Origin: ORIGIN },
			});
			expect(res.status).toBe(404);
			expect(deleted).toHaveLength(0);
		} finally {
			restoreStorage();
		}
	});
});