// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's archived media versions: the creator's list, the original download, and the
 * removal that deletes only the version's own bytes.
 *
 * 🚨 **Every route is owner-only.** A stranger gets the same 404 a missing Work gets, because
 * the existence of an old version is not something a request should confirm. The history is
 * the creator's; a reader sees only the current version's date on the Work's page.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import {
	assets,
	users,
	webBuildFiles,
	webBuilds,
	workMediaVersions,
	workSourceFiles,
	works,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { unzipSync } from "fflate";
import app from "../index";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const id = crypto.randomUUID().slice(0, 8);
const ownerName = `versions_${id}`;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

let ownerCookie = "";
let ownerId = 0;
let strangerCookie = "";
let strangerId = 0;
const workIds: number[] = [];

async function makeVersionedWork() {
	const current = `creators/${ownerId}/videos/originals/current-${id}.mp4`;
	const work = await insertWork({
		type: "video",
		title: "versioned",
		creatorId: ownerId,
		sourceKey: current,
		visibility: "private",
	});
	workIds.push(work.id);
	const old = `creators/${ownerId}/videos/originals/old-${id}.mp4`;
	const [version] = await db
		.insert(workMediaVersions)
		.values({
			workId: work.id,
			uploadedAt: new Date("2026-01-02T03:04:05.000Z"),
			media: {
				kind: "source",
				file: {
					file: old,
					filename: "old.mp4",
					fileSize: 4321,
					mimeType: "video/mp4",
				},
			},
		})
		.returning();
	return { work, version, current, old };
}

describe("a Work's archived media versions", () => {
	beforeAll(async () => {
		const owner = await createAccount(ownerName, { fields: { isCreator: true } });
		ownerId = owner.userId;
		ownerCookie = owner.cookie;
		const stranger = await createAccount(`${ownerName}_stranger`, {
			fields: { isCreator: true },
		});
		strangerId = stranger.userId;
		strangerCookie = stranger.cookie;
	}, 30_000);

	afterAll(async () => {
		if (workIds.length > 0) {
			await db.delete(works).where(inArray(works.id, workIds));
		}
		await db.delete(users).where(eq(users.id, ownerId));
		await db.delete(users).where(eq(users.id, strangerId));
	});

	it("archives the prior build set when a hosted build is promoted", async () => {
		const work = await insertWork({
			type: "game",
			title: "hosted version",
			creatorId: ownerId,
			visibility: "released",
		});
		workIds.push(work.id);
		const before = new Date("2026-03-04T05:06:07.000Z");
		await db.update(works).set({ versionAddedAt: before }).where(eq(works.id, work.id));

		const [oldBuild] = await db
			.insert(webBuilds)
			.values({ workId: work.id, label: "Old", entryPath: "index.html", isPrimary: true })
			.returning();
		await db.insert(webBuildFiles).values({
			buildId: oldBuild.id,
			path: "index.html",
			storageKey: `creators/${ownerId}/web-builds/${oldBuild.id}/index.html`,
			fileSize: 120,
			mimeType: "text/html",
		});
		const [nextBuild] = await db
			.insert(webBuilds)
			.values({ workId: work.id, label: "Next", entryPath: "index.html" })
			.returning();
		await db.insert(webBuildFiles).values({
			buildId: nextBuild.id,
			path: "index.html",
			storageKey: `creators/${ownerId}/web-builds/${nextBuild.id}/index.html`,
			fileSize: 200,
			mimeType: "text/html",
		});

		const res = await req(`/api/web-builds/works/${work.id}/web-build/${nextBuild.id}/complete`, {
			method: "POST",
			headers: {
				cookie: ownerCookie,
				Origin: "http://localhost:3000",
				"content-type": "application/json",
			},
			body: JSON.stringify({ isPrimary: true }),
		});
		expect(res.status).toBe(200);

		// One build stands: the promoted one, as primary.
		const builds = await db.select().from(webBuilds).where(eq(webBuilds.workId, work.id));
		expect(builds.map((build) => [build.label, build.isPrimary])).toEqual([["Next", true]]);

		// The old build is the archived version — and the promoted build is not.
		const [version] = await db
			.select()
			.from(workMediaVersions)
			.where(eq(workMediaVersions.workId, work.id));
		expect(version?.media.kind).toBe("builds");
		const archived = version?.media.kind === "builds" ? version.media.webBuilds : [];
		expect(archived.map((build) => build.label)).toEqual(["Old"]);
		expect(archived[0]?.files.map((file) => file.path)).toEqual(["index.html"]);
		expect(version?.uploadedAt).toEqual(before);

		// And the promoted build is the Work's current version.
		const [row] = await db
			.select({ versionAddedAt: works.versionAddedAt })
			.from(works)
			.where(eq(works.id, work.id));
		expect(row?.versionAddedAt?.getTime() ?? 0).toBeGreaterThan(before.getTime());
	});

	it("replaces a released set as a new version", async () => {
		const work = await insertWork({
			type: "comic",
			title: "set version",
			creatorId: ownerId,
			visibility: "released",
		});
		workIds.push(work.id);
		const first = `creators/${ownerId}/comics/one-${id}.png`;
		const second = `creators/${ownerId}/comics/two-${id}.png`;
		const next = `creators/${ownerId}/comics/next-${id}.png`;
		await db.insert(workSourceFiles).values([
			{
				workId: work.id,
				position: 0,
				file: first,
				filename: "one.png",
				fileSize: 10,
				mimeType: "image/png",
			},
			{
				workId: work.id,
				position: 1,
				file: second,
				filename: "two.png",
				fileSize: 20,
				mimeType: "image/png",
			},
		]);
		const before = new Date("2026-01-05T00:00:00.000Z");
		await db
			.update(works)
			.set({ sourceKey: second, versionAddedAt: before })
			.where(eq(works.id, work.id));

		// The append route refuses a released set; this is the one that moves it.
		const append = await req(`/api/content/works/${work.id}/source-files`, {
			method: "POST",
			headers: {
				cookie: ownerCookie,
				Origin: "http://localhost:3000",
				"content-type": "application/json",
			},
			body: JSON.stringify({ files: [{ file: next, filename: "next.png", fileSize: 30 }] }),
		});
		expect(append.status).toBe(409);

		const res = await req(`/api/content/works/${work.id}/source-files`, {
			method: "PUT",
			headers: {
				cookie: ownerCookie,
				Origin: "http://localhost:3000",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				files: [{ file: next, filename: "next.png", fileSize: 30, mimeType: "image/png" }],
			}),
		});
		expect(res.status).toBe(200);

		const rows = await db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, work.id));
		expect(rows.map((row) => [row.position, row.filename])).toEqual([[0, "next.png"]]);

		// The set it replaced is the version, with both of its pages.
		const [version] = await db
			.select()
			.from(workMediaVersions)
			.where(eq(workMediaVersions.workId, work.id));
		expect(version?.media.kind).toBe("set");
		expect(
			version?.media.kind === "set" ? version.media.files.map((file) => file.filename) : [],
		).toEqual(["one.png", "two.png"]);
		expect(version?.uploadedAt).toEqual(before);
	});

	it("lists the archive to its owner and hides it from a stranger", async () => {
		const { work } = await makeVersionedWork();

		const own = await req(`/api/content/works/${work.id}/versions`, {
			headers: { cookie: ownerCookie },
		});
		expect(own.status).toBe(200);
		const body = (await own.json()) as {
			versions: {
				id: number;
				uploadedAt: string;
				kind: string;
				fileCount: number;
				totalBytes: number;
				files: { filename: string; fileSize: number | null }[];
			}[];
		};
		expect(body.versions).toHaveLength(1);
		expect(body.versions[0].kind).toBe("source");
		expect(body.versions[0].fileCount).toBe(1);
		expect(body.versions[0].totalBytes).toBe(4321);
		expect(body.versions[0].files[0].filename).toBe("old.mp4");
		expect(body.versions[0].uploadedAt).toContain("2026-01-02");

		const other = await req(`/api/content/works/${work.id}/versions`, {
			headers: { cookie: strangerCookie },
		});
		expect(other.status).toBe(404);

		// The current version's date is the one fact the Work's own payload carries.
		const detail = await req(`/api/content/works/${work.id}`, {
			headers: { cookie: ownerCookie },
		});
		expect(detail.status).toBe(200);
		const detailBody = (await detail.json()) as { work: { versionAddedAt?: string } };
		expect(detailBody.work.versionAddedAt).toBeTruthy();
	});

	it("downloads the archived original, and refuses a stranger", async () => {
		const { work, old } = await makeVersionedWork();

		// A version id that does not belong to this Work is a 404, not a different Work's
		// history.
		const missing = await req(`/api/content/works/${work.id}/versions/999999/download`, {
			headers: { cookie: ownerCookie },
		});
		expect(missing.status).toBe(404);

		const [version] = await db
			.select()
			.from(workMediaVersions)
			.where(eq(workMediaVersions.workId, work.id));
		const download = await testFetch(
			new Request(`http://localhost/api/content/works/${work.id}/versions/${version.id}/download`, {
				headers: { cookie: ownerCookie },
				redirect: "manual",
			}),
		);
		expect(download.status).toBe(302);
		expect(download.headers.get("location") ?? "").toContain(old);

		const stranger = await req(`/api/content/works/${work.id}/versions/${version.id}/download`, {
			headers: { cookie: strangerCookie },
		});
		expect(stranger.status).toBe(404);
	});

	it("archives the prior builds when a new primary build is added", async () => {
		const work = await insertWork({
			type: "game",
			title: "versioned game",
			creatorId: ownerId,
			visibility: "private",
		});
		workIds.push(work.id);
		const oldBuild = `creators/${ownerId}/assets/old-game-${id}.zip`;
		const oldMacBuild = `creators/${ownerId}/assets/old-game-mac-${id}.zip`;
		const newBuild = `creators/${ownerId}/assets/new-game-${id}.zip`;
		const uploadedAt = new Date("2026-02-03T04:05:06.000Z");
		await db.update(works).set({ versionAddedAt: uploadedAt }).where(eq(works.id, work.id));
		// One Work, two platform builds: the primary Windows build and a secondary macOS one.
		await db.insert(assets).values([
			{
				workId: work.id,
				file: oldBuild,
				filename: "old-game.zip",
				fileSize: 1000,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			},
			{
				workId: work.id,
				file: oldMacBuild,
				filename: "old-game-mac.zip",
				fileSize: 1100,
				mimeType: "application/zip",
				platform: "mac",
				isPrimary: false,
			},
		]);

		const res = await req(`/api/content/works/${work.id}/assets`, {
			method: "POST",
			headers: {
				cookie: ownerCookie,
				Origin: "http://localhost:3000",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				file: newBuild,
				filename: "new-game.zip",
				fileSize: 2000,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			}),
		});
		expect(res.status).toBe(201);

		const [version] = await db
			.select()
			.from(workMediaVersions)
			.where(eq(workMediaVersions.workId, work.id));
		expect(version).toBeDefined();
		expect(version.uploadedAt).toEqual(uploadedAt);
		expect(version.media.kind).toBe("builds");
		expect(
			version.media.kind === "builds"
				? version.media.assets.map((asset) => [asset.platform, asset.file]).sort()
				: [],
		).toEqual([
			["mac", oldMacBuild],
			["windows", oldBuild],
		]);

		const rows = await db.select().from(assets).where(eq(assets.workId, work.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].file).toBe(newBuild);
		expect(rows[0].isPrimary).toBe(true);

		const [row] = await db.select().from(works).where(eq(works.id, work.id));
		expect(row.versionAddedAt.getTime()).toBeGreaterThan(uploadedAt.getTime());
	});

	it("streams a zip when a version holds more than one original", async () => {
		const work = await insertWork({
			type: "image",
			title: "versioned gallery",
			creatorId: ownerId,
			visibility: "private",
		});
		workIds.push(work.id);
		const first = `creators/${ownerId}/assets/page-1-${id}.png`;
		const second = `creators/${ownerId}/assets/page-2-${id}.png`;
		await storage.upload(first, new TextEncoder().encode("one"), "image/png", "private");
		await storage.upload(second, new TextEncoder().encode("two"), "image/png", "private");
		const [version] = await db
			.insert(workMediaVersions)
			.values({
				workId: work.id,
				uploadedAt: new Date("2025-11-01T00:00:00.000Z"),
				media: {
					kind: "set",
					files: [
						{ file: first, filename: "page-1.png", fileSize: 3, mimeType: "image/png" },
						{ file: second, filename: "page-2.png", fileSize: 3, mimeType: "image/png" },
					],
				},
			})
			.returning();

		const res = await req(`/api/content/works/${work.id}/versions/${version.id}/download`, {
			headers: { cookie: ownerCookie },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/zip");
		const zip = unzipSync(new Uint8Array(await res.arrayBuffer()));
		expect(Object.keys(zip).some((name) => name.endsWith("page-1.png"))).toBe(true);
		expect(Object.keys(zip).some((name) => name.endsWith("page-2.png"))).toBe(true);
		expect(new TextDecoder().decode(zip[Object.keys(zip)[0]])).toBe("one");
	});

	it("sweeps a version's originals with the Work", async () => {
		const { work, old } = await makeVersionedWork();
		const deleted: string[] = [];
		const spy = spyOn(storage, "delete").mockImplementation(async (key: string) => {
			deleted.push(key);
		});
		try {
			const res = await req(`/api/content/works/${work.id}`, {
				method: "DELETE",
				headers: { cookie: ownerCookie, Origin: "http://localhost:3000" },
			});
			expect(res.status).toBe(204);
			expect(deleted).toContain(old);
		} finally {
			spy.mockRestore();
		}
	});

	it("removes a version and its own original, but never a key the current Work still uses", async () => {
		const { work, version, current } = await makeVersionedWork();
		const [shared] = await db
			.insert(workMediaVersions)
			.values({
				workId: work.id,
				uploadedAt: new Date("2025-12-01T00:00:00.000Z"),
				media: {
					kind: "source",
					file: {
						file: current,
						filename: "current.mp4",
						fileSize: 1,
						mimeType: "video/mp4",
					},
				},
			})
			.returning();

		const deleted: string[] = [];
		const spy = spyOn(storage, "delete").mockImplementation(async (key: string) => {
			deleted.push(key);
		});
		try {
			const res = await req(`/api/content/works/${work.id}/versions/${version.id}`, {
				method: "DELETE",
				headers: { cookie: ownerCookie, Origin: "http://localhost:3000" },
			});
			expect(res.status).toBe(200);
			expect(deleted).toContain(version.media.kind === "source" ? version.media.file.file : "");
			expect(deleted).not.toContain(current);

			const left = await db
				.select()
				.from(workMediaVersions)
				.where(eq(workMediaVersions.id, version.id));
			expect(left).toHaveLength(0);

			// The shared-key row is removed, but deleting it must not take the live original.
			const sharedRes = await req(`/api/content/works/${work.id}/versions/${shared.id}`, {
				method: "DELETE",
				headers: { cookie: ownerCookie, Origin: "http://localhost:3000" },
			});
			expect(sharedRes.status).toBe(200);
			expect(deleted).not.toContain(current);
		} finally {
			spy.mockRestore();
		}
	});
});
