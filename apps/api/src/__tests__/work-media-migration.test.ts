// SPDX-License-Identifier: Apache-2.0
/**
 * The Work-media migration, end to end: a Work whose rows and objects sit under its
 * publisher's prefix is moved into `works/{workId}/`, the rows and the scan ledger follow,
 * and a second run finds nothing to do.
 *
 * ⚠️ **The script runs as a child process, which is how it runs for real.** It imports the
 * database client and the storage backend from the environment, and a `bun run` child of
 * the test session inherits both without starting a session of its own.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { db } from "@anthers/db/client";
import {
	mediaScans,
	workAssets,
	workCaptionTracks,
	workMediaVersions,
	workPhysicalListings,
	workPreviewMedia,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import { storage } from "../services/storage/index.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

const REPO = join(import.meta.dir, "../../../..");
const SCRIPT = join(REPO, "apps/api/src/scripts/move-work-media-to-work-keys.ts");

purgeAccountsCreatedHere();

/** Write bytes at a key and return the key, so the storage copy has something to move. */
async function put(key: string): Promise<string> {
	await storage.upload(key, Buffer.from(`bytes for ${key}`), "application/octet-stream", "private");
	return key;
}

describe("the Work-media migration", () => {
	let creatorId = 0;
	let workId = 0;
	let reportPath = "";

	/** Every old key, so the assertions know what must be gone. */
	const oldKeys: string[] = [];
	const newKey = (suffix: string) => `works/${workId}/${suffix}`;
	const oldKey = (suffix: string) => `creators/${creatorId}/${suffix}`;

	beforeAll(async () => {
		creatorId = (await createAccount(`media-migrate_${Date.now().toString(36)}`)).userId;
		const work = await insertWork({ creatorId, type: "video", title: "Migration fixture" });
		workId = work.id;

		const source = await put(oldKey(`videos/originals/${workId}.mp4`));
		const thumbnail = await put(oldKey(`thumbnails/${workId}/poster.jpg`));
		const asset = await put(oldKey(`assets/${workId}/build.zip`));
		const preview = await put(oldKey(`previews/images/${workId}/shot.jpg`));
		const caption = await put(oldKey(`previews/captions/${workId}/en.vtt`));
		const hlsPrefix = oldKey(`videos/hls/run-${workId}/`);
		const manifest = await put(`${hlsPrefix}master.m3u8`);
		const segment = await put(`${hlsPrefix}720p_000.ts`);
		const archived = await put(oldKey(`assets/${workId}/old-version.zip`));
		oldKeys.push(source, thumbnail, asset, preview, caption, manifest, segment, archived);

		await db.update(works).set({ sourceKey: source, thumbnail }).where(eq(works.id, workId));
		await db.insert(workAssets).values({
			workId,
			file: asset,
			filename: "build.zip",
			fileSize: 10,
		});
		await db.insert(workPreviewMedia).values({ workId, kind: "image", file: preview, position: 0 });
		await db.insert(workCaptionTracks).values({
			previewId: null,
			workId,
			language: "en",
			kind: "captions",
			storageKey: caption,
			byteSize: 10,
			cueCount: 1,
		});
		await db.insert(workTranscodingJobs).values({
			workId,
			mediaType: "video",
			status: "completed",
			hlsManifestUrl: await storage.getUrl(manifest),
		});
		await db.insert(workMediaVersions).values({
			workId,
			versionLabel: "original",
			uploadedAt: new Date(),
			media: {
				kind: "source",
				file: {
					file: archived,
					filename: "old-version.zip",
					fileSize: 10,
					mimeType: "application/zip",
				},
			},
		});
		await db.insert(mediaScans).values({
			storageKey: asset,
			workId,
			objectKind: "asset",
			determination: "clean",
		});

		reportPath = join(REPO, "cache", `migration-test-${Date.now()}.json`);
		await mkdir(join(REPO, "cache"), { recursive: true });
	});

	it("moves every object and every reference, then finds nothing left on a second run", async () => {
		const first = Bun.spawnSync(
			["bun", "run", SCRIPT, "--work", String(workId), "--apply", "--report", reportPath],
			{ cwd: REPO, env: process.env },
		);
		expect(first.exitCode, first.stderr.toString()).toBe(0);

		for (const old of oldKeys) {
			expect(await storage.exists(old)).toBe(false);
		}
		expect(await storage.exists(newKey(`videos/originals/${workId}.mp4`))).toBe(true);
		expect(await storage.exists(newKey(`thumbnails/${workId}/poster.jpg`))).toBe(true);
		expect(await storage.exists(newKey(`assets/${workId}/build.zip`))).toBe(true);
		expect(await storage.exists(newKey(`previews/images/${workId}/shot.jpg`))).toBe(true);
		expect(await storage.exists(newKey(`previews/captions/${workId}/en.vtt`))).toBe(true);
		expect(await storage.exists(newKey(`videos/hls/run-${workId}/master.m3u8`))).toBe(true);
		expect(await storage.exists(newKey(`videos/hls/run-${workId}/720p_000.ts`))).toBe(true);
		expect(await storage.exists(newKey(`assets/${workId}/old-version.zip`))).toBe(true);

		const [work] = await db.select().from(works).where(eq(works.id, workId));
		expect(work.sourceKey).toBe(newKey(`videos/originals/${workId}.mp4`));
		expect(work.thumbnail).toBe(newKey(`thumbnails/${workId}/poster.jpg`));
		const [asset] = await db.select().from(workAssets).where(eq(workAssets.workId, workId));
		expect(asset.file).toBe(newKey(`assets/${workId}/build.zip`));
		const [preview] = await db
			.select()
			.from(workPreviewMedia)
			.where(eq(workPreviewMedia.workId, workId));
		expect(preview.file).toBe(newKey(`previews/images/${workId}/shot.jpg`));
		const [caption] = await db
			.select()
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, workId));
		expect(caption.storageKey).toBe(newKey(`previews/captions/${workId}/en.vtt`));
		const [job] = await db
			.select()
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.workId, workId));
		expect(job.hlsManifestUrl).toContain(newKey(`videos/hls/run-${workId}/master.m3u8`));
		const [version] = await db
			.select()
			.from(workMediaVersions)
			.where(eq(workMediaVersions.workId, workId));
		expect(version.media.kind).toBe("source");
		if (version.media.kind === "source") {
			expect(version.media.file.file).toBe(newKey(`assets/${workId}/old-version.zip`));
		}
		const [scan] = await db.select().from(mediaScans).where(eq(mediaScans.workId, workId));
		expect(scan.storageKey).toBe(newKey(`assets/${workId}/build.zip`));

		const report = JSON.parse(await readFile(reportPath, "utf8")) as {
			summary: { skipped: number; objects: number; failures: unknown[] };
		};
		expect(report.summary.failures).toHaveLength(0);
		expect(report.summary.objects).toBeGreaterThanOrEqual(oldKeys.length);

		// A second run is a no-op: every column now names the Work's namespace.
		const secondReport = join(REPO, "cache", `migration-test-second-${Date.now()}.json`);
		const second = Bun.spawnSync(
			["bun", "run", SCRIPT, "--work", String(workId), "--apply", "--report", secondReport],
			{ cwd: REPO, env: process.env },
		);
		expect(second.exitCode, second.stderr.toString()).toBe(0);
		const rerun = JSON.parse(await readFile(secondReport, "utf8")) as {
			summary: { skipped: number; objects: number };
		};
		expect(rerun.summary.skipped).toBe(1);
		expect(rerun.summary.objects).toBe(0);
	});

	it("moves a physical listing's gallery images and rewrites its JSON", async () => {
		const work = await insertWork({
			creatorId,
			type: "physical",
			title: "Physical gallery fixture",
		});
		const oldA = `creators/${creatorId}/thumbnails/unknown/gallery-${work.id}-a.png`;
		const oldB = `creators/${creatorId}/thumbnails/unknown/gallery-${work.id}-b.png`;
		await put(oldA);
		await put(oldB);
		await db.insert(workPhysicalListings).values({
			workId: work.id,
			images: [
				{ key: oldA, alt: "front", cover: true },
				{ key: oldB, alt: "back", cover: false },
			],
		});

		const report = join(REPO, "cache", `migration-physical-${Date.now()}.json`);
		const run = Bun.spawnSync(
			["bun", "run", SCRIPT, "--work", String(work.id), "--apply", "--report", report],
			{ cwd: REPO, env: process.env },
		);
		expect(run.exitCode, run.stderr.toString()).toBe(0);
		expect(await storage.exists(oldA)).toBe(false);
		expect(await storage.exists(oldB)).toBe(false);

		const newA = `works/${work.id}/thumbnails/unknown/gallery-${work.id}-a.png`;
		const newB = `works/${work.id}/thumbnails/unknown/gallery-${work.id}-b.png`;
		const [listing] = await db
			.select()
			.from(workPhysicalListings)
			.where(eq(workPhysicalListings.workId, work.id));
		expect(listing.images).toEqual([
			{ key: newA, alt: "front", cover: true },
			{ key: newB, alt: "back", cover: false },
		]);
		expect(await storage.exists(newA)).toBe(true);
		expect(await storage.exists(newB)).toBe(true);
	});
});
