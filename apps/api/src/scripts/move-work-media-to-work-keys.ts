// SPDX-License-Identifier: Apache-2.0
/**
 * Move every Work's media from its publisher's creator prefix into the Work's own
 * namespace: `creators/{creatorId}/…` → `works/{workId}/…`.
 *
 * ⭐ **The rule the script implements is a pure prefix rewrite, and that is what makes it
 * safe to resume.** A Work-media key is exactly its old self with `creators/{id}/` replaced
 * by `works/{workId}/`; no per-media-type table, no re-derivation of a name. A Work whose
 * columns already name the new shape is skipped, so a second run is free and a run that
 * died between two Works resumes at the first unfinished one.
 *
 * 🚨 **Copy, rewrite in one transaction, delete afterwards.** The order is the whole design:
 * an object has to exist at its new key before a row points there, and the old object must
 * stay until every row that named it has committed. Deleting first would lose bytes if the
 * transaction failed; rewriting first would hand out keys with nothing behind them. The
 * delete step only touches keys under the publisher's prefix, so a Work whose column names
 * a stranger's object copies it without destroying the stranger's original.
 *
 * The objects are enumerated from the database, with one exception: an HLS rendition's
 * segment names live in the playlists rather than in a table, so the run prefix is listed
 * from storage and every object under it moves with its master playlist.
 *
 * Usage:
 *
 *   bun run apps/api/src/scripts/move-work-media-to-work-keys.ts            # dry run
 *   bun run apps/api/src/scripts/move-work-media-to-work-keys.ts --apply    # write
 *   bun run apps/api/src/scripts/move-work-media-to-work-keys.ts --check    # report only
 *
 * `--work <id>` limits a run to one Work (the rehearsal and the repair path), `--limit <n>`
 * stops after n Works, and `--report <path>` writes the JSON summary somewhere other than
 * the default `cache/work-media-migration-<stamp>.json`.
 *
 * ⚠️ **In-flight upload sessions are not migrated.** A multipart session's parts belong to
 * the key it was opened on; rewriting its destination mid-upload would complete into an
 * object the row no longer names. Sessions opened before this change are old-shape, so the
 * script reports them and `--abort-open-sessions` aborts them (the client starts again, and
 * its digest resume finds nothing). The new upload path cannot create one without a Work id.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "@anthers/db/client";
import {
	mediaQuarantine,
	mediaScans,
	mediaUploadSessions,
	workAssets,
	workBuildFiles,
	workBuilds,
	workCaptionTracks,
	workMediaVersions,
	workPages,
	workPhysicalListings,
	workPreviewMedia,
	workSectionAssets,
	workSections,
	workSourceFiles,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { storage } from "../services/storage/index.js";
import { isKeyUnder, urlToKey, workKeyForMigration } from "../services/storage/keys.js";
import { keysInMedia } from "../services/work-versions.js";

type WorkRow = typeof works.$inferSelect;

/** One object that moves, with the value the database should hold afterwards. */
interface KeyMove {
	oldKey: string;
	newKey: string;
	/** The column/JSON value as stored — a bare key or a URL — and its rewritten form. */
	oldRef: string;
	newRef: string;
}

interface PrefixMove {
	oldPrefix: string;
	newPrefix: string;
}

interface QuarantineMove {
	id: number;
	oldKey: string;
	newKey: string;
	oldQuarantineKey: string;
	newQuarantineKey: string;
}

/** Everything one Work's migration needs, computed before anything is written. */
interface WorkPlan {
	work: WorkRow;
	keys: KeyMove[];
	prefixes: PrefixMove[];
	quarantines: QuarantineMove[];
	warnings: string[];
	/** Rows to rewrite after the objects are copied. */
	assets: (typeof workAssets.$inferSelect)[];
	sourceFiles: (typeof workSourceFiles.$inferSelect)[];
	pages: (typeof workPages.$inferSelect)[];
	sections: (typeof workSections.$inferSelect)[];
	sectionAssets: (typeof workSectionAssets.$inferSelect)[];
	captions: { id: number; storageKey: string }[];
	previews: (typeof workPreviewMedia.$inferSelect)[];
	buildFiles: { id: number; storageKey: string }[];
	versions: { id: number; media: (typeof workMediaVersions.$inferSelect)["media"] }[];
	jobs: { id: number; hlsManifestUrl: string | null; outputFileUrl: string | null }[];
	/** The physical good's storefront gallery, whose images are bare storage keys. */
	listing: typeof workPhysicalListings.$inferSelect | null;
	scans: { id: number; storageKey: string }[];
}

interface Summary {
	stamp: string;
	apply: boolean;
	works: number;
	skipped: number;
	objects: number;
	prefixes: number;
	deleted: number;
	warnings: string[];
	failures: { workId: number; reason: string }[];
	openSessions: number;
}

function money(n: number): string {
	return n.toLocaleString("en-US");
}

/** The new reference for a stored value, preserving whether it was a key or a URL. */
async function rekeyRef(value: string, newKey: string): Promise<string> {
	const key = urlToKey(value);
	// A bare key stays a bare key; a URL is rebuilt by the storage layer, so the row keeps
	// the same shape it had before (and the local backend's `content/` prefix with it).
	if (value === key) return newKey;
	return storage.getUrl(newKey);
}

/** Add one stored reference to the plan, mapping it only when it is a Work-media key. */
async function addRef(
	plan: WorkPlan,
	value: string | null | undefined,
	seen: Set<string>,
	label: string,
): Promise<void> {
	if (!value) return;
	const key = urlToKey(value);
	if (!key || seen.has(key)) return;
	const newKey = workKeyForMigration(key, plan.work.id);
	if (!newKey) {
		plan.warnings.push(`${label}: not a mappable key (${key})`);
		return;
	}
	if (newKey === key) {
		seen.add(key);
		return;
	}
	seen.add(key);
	plan.keys.push({
		oldKey: key,
		newKey,
		oldRef: value,
		newRef: await rekeyRef(value, newKey),
	});
}

async function planWork(work: WorkRow): Promise<WorkPlan> {
	const plan: WorkPlan = {
		work,
		keys: [],
		prefixes: [],
		quarantines: [],
		warnings: [],
		assets: [],
		sourceFiles: [],
		pages: [],
		sections: [],
		sectionAssets: [],
		captions: [],
		previews: [],
		buildFiles: [],
		versions: [],
		jobs: [],
		listing: null,
		scans: [],
	};
	const seen = new Set<string>();
	const workId = work.id;

	await addRef(plan, work.sourceKey, seen, "works.source_key");
	await addRef(plan, work.sourceOriginalKey, seen, "works.source_original_key");
	await addRef(plan, work.thumbnail, seen, "works.thumbnail");
	await addRef(plan, work.thumbnailSource, seen, "works.thumbnail_source");

	const [
		assets,
		sourceFiles,
		pages,
		sections,
		sectionAssets,
		captions,
		previews,
		versions,
		jobs,
		listingRows,
	] = await Promise.all([
		db.select().from(workAssets).where(eq(workAssets.workId, workId)),
		db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, workId)),
		db.select().from(workPages).where(eq(workPages.workId, workId)),
		db.select().from(workSections).where(eq(workSections.workId, workId)),
		db.select().from(workSectionAssets).where(eq(workSectionAssets.workId, workId)),
		db
			.select({ id: workCaptionTracks.id, storageKey: workCaptionTracks.storageKey })
			.from(workCaptionTracks)
			.where(eq(workCaptionTracks.workId, workId)),
		db.select().from(workPreviewMedia).where(eq(workPreviewMedia.workId, workId)),
		db
			.select({ id: workMediaVersions.id, media: workMediaVersions.media })
			.from(workMediaVersions)
			.where(eq(workMediaVersions.workId, workId)),
		db
			.select({
				id: workTranscodingJobs.id,
				hlsManifestUrl: workTranscodingJobs.hlsManifestUrl,
				outputFileUrl: workTranscodingJobs.outputFileUrl,
			})
			.from(workTranscodingJobs)
			.where(eq(workTranscodingJobs.workId, workId)),
		db.select().from(workPhysicalListings).where(eq(workPhysicalListings.workId, workId)).limit(1),
	]);
	plan.assets = assets;
	plan.sourceFiles = sourceFiles;
	plan.pages = pages;
	plan.sections = sections;
	plan.sectionAssets = sectionAssets;
	plan.captions = captions;
	plan.previews = previews;
	plan.versions = versions;
	plan.jobs = jobs;
	plan.listing = listingRows[0] ?? null;

	for (const row of assets) await addRef(plan, row.file, seen, `asset ${row.id}`);
	for (const row of sourceFiles) await addRef(plan, row.file, seen, `source file ${row.id}`);
	for (const row of pages) await addRef(plan, row.file, seen, `page ${row.id}`);
	for (const row of sections) await addRef(plan, row.file, seen, `section ${row.id}`);
	for (const row of sectionAssets) await addRef(plan, row.file, seen, `section asset ${row.id}`);
	for (const row of captions) await addRef(plan, row.storageKey, seen, `caption ${row.id}`);
	for (const row of previews) await addRef(plan, row.file, seen, `preview ${row.id}`);
	for (const image of plan.listing?.images ?? []) {
		await addRef(plan, image.key, seen, `physical image ${image.key}`);
	}
	for (const row of versions) {
		for (const key of keysInMedia(row.media)) {
			await addRef(plan, key, seen, `version ${row.id}`);
		}
	}
	for (const job of jobs) {
		await addRef(plan, job.outputFileUrl, seen, `job ${job.id} output`);
		if (job.hlsManifestUrl) {
			const masterKey = urlToKey(job.hlsManifestUrl);
			const oldPrefix = masterKey.replace(/\/[^/]+$/, "");
			if (oldPrefix && oldPrefix !== masterKey) {
				const newPrefix = workKeyForMigration(`${oldPrefix}/`, work.id);
				// An already-migrated run prefix maps to itself; adding it would make the
				// Work look unfinished on every pass.
				if (newPrefix && newPrefix !== `${oldPrefix}/`) {
					if (!plan.prefixes.some((p) => p.oldPrefix === `${oldPrefix}/`)) {
						plan.prefixes.push({ oldPrefix: `${oldPrefix}/`, newPrefix });
					}
				}
			}
		}
	}
	return plan;
}

async function planBuildFiles(plan: WorkPlan, seen: Set<string>, workId: number): Promise<void> {
	const rows = await db
		.select({ id: workBuildFiles.id, storageKey: workBuildFiles.storageKey })
		.from(workBuildFiles)
		.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
		.where(eq(workBuilds.workId, workId));
	plan.buildFiles = rows;
	for (const row of rows) await addRef(plan, row.storageKey, seen, `build file ${row.id}`);
}

async function finishPlan(plan: WorkPlan): Promise<void> {
	const seen = new Set(plan.keys.map((k) => k.oldKey));
	await planBuildFiles(plan, seen, plan.work.id);

	// Quarantined objects are still a Work's objects. Their bytes sit at
	// `quarantine/{key}`, so a restore would put them back at the key the row names; both
	// halves move together or the row points at nothing.
	const quarantineRows = await db
		.select({ id: mediaQuarantine.id, originalKey: mediaQuarantine.originalKey })
		.from(mediaQuarantine)
		.where(eq(mediaQuarantine.workId, plan.work.id));
	for (const row of quarantineRows) {
		const newKey = workKeyForMigration(row.originalKey, plan.work.id);
		if (!newKey || newKey === row.originalKey) continue;
		plan.quarantines.push({
			id: row.id,
			oldKey: row.originalKey,
			newKey,
			oldQuarantineKey: `quarantine/${row.originalKey}`,
			newQuarantineKey: `quarantine/${newKey}`,
		});
	}

	// The scan ledger is keyed by the exact object key, so a moved object's row moves with
	// it; otherwise the Work would read as unscanned and a re-scan would be queued on bytes
	// already answered for.
	const keys = [...plan.keys.map((m) => m.oldKey), ...plan.quarantines.map((q) => q.oldKey)];
	if (keys.length > 0) {
		plan.scans = await db
			.select({ id: mediaScans.id, storageKey: mediaScans.storageKey })
			.from(mediaScans)
			.where(inArray(mediaScans.storageKey, keys));
	}
}

/** Expand a prefix move into the exact objects storage holds under it. */
async function expandPrefixes(plan: WorkPlan): Promise<void> {
	for (const prefix of plan.prefixes) {
		const keys = await storage.listKeys(prefix.oldPrefix);
		if (keys.length === 0) {
			plan.warnings.push(`HLS prefix holds no objects: ${prefix.oldPrefix}`);
			continue;
		}
		for (const oldKey of keys) {
			const newKey = `${prefix.newPrefix}${oldKey.slice(prefix.oldPrefix.length)}`;
			if (!plan.keys.some((m) => m.oldKey === oldKey)) {
				plan.keys.push({ oldKey, newKey, oldRef: oldKey, newRef: newKey });
			}
		}
	}
}

async function copyPlan(plan: WorkPlan, apply: boolean, summary: Summary): Promise<boolean> {
	for (const move of plan.keys) {
		if (!apply) continue;
		const copied = await storage.copy(move.oldKey, move.newKey);
		if (!copied) {
			// An earlier run may have copied the object and rewritten some of the rows before
			// it stopped. The target existing is the state this move wants; only a missing
			// target is a failure.
			if (await storage.exists(move.newKey)) {
				summary.objects += 1;
				continue;
			}
			plan.warnings.push(`copy failed: ${move.oldKey} → ${move.newKey}`);
			return false;
		}
		// Size is the cheap proof that the copy is the same bytes; a missing one either side
		// means the source vanished between planning and copying, which is a refusal rather
		// than an empty object.
		const [before, after] = await Promise.all([
			storage.size(move.oldKey),
			storage.size(move.newKey),
		]);
		if (before == null || after == null || before !== after) {
			plan.warnings.push(
				`copy verification failed: ${move.oldKey} (${before ?? "missing"}) → ${move.newKey} (${after ?? "missing"})`,
			);
			return false;
		}
		summary.objects += 1;
	}
	for (const quarantine of plan.quarantines) {
		if (!apply) continue;
		const copied = await storage.copy(quarantine.oldQuarantineKey, quarantine.newQuarantineKey);
		if (!copied) {
			plan.warnings.push(
				`quarantine copy failed: ${quarantine.oldQuarantineKey} → ${quarantine.newQuarantineKey}`,
			);
			return false;
		}
		summary.objects += 1;
	}
	return true;
}

async function rewritePlan(plan: WorkPlan): Promise<void> {
	const byKey = new Map(plan.keys.map((m) => [m.oldKey, m]));
	const newRef = (value: string | null): string | null => {
		if (!value) return value;
		const move = byKey.get(urlToKey(value));
		return move ? move.newRef : value;
	};
	const newKey = (value: string | null): string | null => {
		if (!value) return value;
		const move = byKey.get(urlToKey(value));
		return move ? move.newKey : value;
	};

	await db.transaction(async (tx) => {
		await tx
			.update(works)
			.set({
				sourceKey: newRef(plan.work.sourceKey),
				sourceOriginalKey: newRef(plan.work.sourceOriginalKey),
				thumbnail: newRef(plan.work.thumbnail),
				thumbnailSource: newRef(plan.work.thumbnailSource),
			})
			.where(eq(works.id, plan.work.id));

		if (plan.listing) {
			await tx
				.update(workPhysicalListings)
				.set({
					images: plan.listing.images.map((image) => {
						const move = byKey.get(urlToKey(image.key));
						return move ? { ...image, key: move.newKey } : image;
					}),
					updatedAt: new Date(),
				})
				.where(eq(workPhysicalListings.id, plan.listing.id));
		}

		for (const row of plan.assets) {
			await tx
				.update(workAssets)
				.set({ file: newRef(row.file) ?? row.file })
				.where(eq(workAssets.id, row.id));
		}
		for (const row of plan.sourceFiles) {
			await tx
				.update(workSourceFiles)
				.set({ file: newRef(row.file) ?? row.file })
				.where(eq(workSourceFiles.id, row.id));
		}
		for (const row of plan.pages) {
			await tx
				.update(workPages)
				.set({ file: newRef(row.file) ?? row.file })
				.where(eq(workPages.id, row.id));
		}
		for (const row of plan.sections) {
			await tx
				.update(workSections)
				.set({ file: newRef(row.file) ?? row.file })
				.where(eq(workSections.id, row.id));
		}
		for (const row of plan.sectionAssets) {
			await tx
				.update(workSectionAssets)
				.set({ file: newRef(row.file) ?? row.file })
				.where(eq(workSectionAssets.id, row.id));
		}
		for (const row of plan.captions) {
			await tx
				.update(workCaptionTracks)
				.set({ storageKey: newKey(row.storageKey) ?? row.storageKey })
				.where(eq(workCaptionTracks.id, row.id));
		}
		for (const row of plan.previews) {
			await tx
				.update(workPreviewMedia)
				.set({ file: newRef(row.file) ?? row.file })
				.where(eq(workPreviewMedia.id, row.id));
		}
		for (const row of plan.buildFiles) {
			await tx
				.update(workBuildFiles)
				.set({ storageKey: newKey(row.storageKey) ?? row.storageKey })
				.where(eq(workBuildFiles.id, row.id));
		}
		for (const row of plan.versions) {
			await tx
				.update(workMediaVersions)
				.set({ media: rewriteVersionMedia(row.media, newKey) })
				.where(eq(workMediaVersions.id, row.id));
		}
		for (const row of plan.jobs) {
			await tx
				.update(workTranscodingJobs)
				.set({
					hlsManifestUrl: newRef(row.hlsManifestUrl) ?? row.hlsManifestUrl ?? "",
					outputFileUrl: newRef(row.outputFileUrl) ?? row.outputFileUrl ?? "",
				})
				.where(eq(workTranscodingJobs.id, row.id));
		}
		for (const row of plan.scans) {
			const move = byKey.get(urlToKey(row.storageKey));
			if (!move) continue;
			await tx.update(mediaScans).set({ storageKey: move.newKey }).where(eq(mediaScans.id, row.id));
		}
		for (const quarantine of plan.quarantines) {
			await tx
				.update(mediaQuarantine)
				.set({
					originalKey: quarantine.newKey,
					quarantineKey: quarantine.newQuarantineKey,
				})
				.where(eq(mediaQuarantine.id, quarantine.id));
		}
	});
}

/** Rewrite every key a version manifest carries, preserving its shape. */
function rewriteVersionMedia(
	media: (typeof workMediaVersions.$inferSelect)["media"],
	newKey: (value: string | null) => string | null,
): (typeof workMediaVersions.$inferSelect)["media"] {
	const mapFile = <T extends { file: string }>(file: T): T => ({
		...file,
		file: newKey(file.file) ?? file.file,
	});
	if (media.kind === "source") return { ...media, file: mapFile(media.file) };
	if (media.kind === "set") return { ...media, files: media.files.map(mapFile) };
	return {
		...media,
		assets: media.assets.map(mapFile),
		webBuilds: media.webBuilds.map((build) => ({
			...build,
			files: build.files.map((file) => ({
				...file,
				storageKey: newKey(file.storageKey) ?? file.storageKey,
			})),
		})),
	};
}

async function deleteOld(plan: WorkPlan, summary: Summary): Promise<void> {
	for (const move of plan.keys) {
		// Only the publisher's own prefix is safe to delete. A foreign key was copied into
		// the Work's namespace, but the object it came from belongs to somebody else.
		const safe = plan.work.creatorId != null && isKeyUnder(move.oldKey, plan.work.creatorId);
		if (!safe) {
			plan.warnings.push(`old object left in place (not the publisher's): ${move.oldKey}`);
			continue;
		}
		try {
			await storage.delete(move.oldKey);
			summary.deleted += 1;
		} catch (err) {
			plan.warnings.push(
				`delete failed for ${move.oldKey}: ${err instanceof Error ? err.message : "unknown"}`,
			);
		}
	}
	for (const prefix of plan.prefixes) {
		const safe = plan.work.creatorId != null && isKeyUnder(prefix.oldPrefix, plan.work.creatorId);
		if (!safe) continue;
		try {
			// The exact keys were deleted above; this removes the now-empty directory and any
			// orphan the run wrote that no row ever named.
			await storage.deletePrefix(prefix.oldPrefix);
		} catch (err) {
			plan.warnings.push(
				`prefix delete failed for ${prefix.oldPrefix}: ${err instanceof Error ? err.message : "unknown"}`,
			);
		}
	}
	for (const quarantine of plan.quarantines) {
		try {
			await storage.delete(quarantine.oldQuarantineKey);
			summary.deleted += 1;
		} catch (err) {
			plan.warnings.push(
				`quarantine delete failed for ${quarantine.oldQuarantineKey}: ${err instanceof Error ? err.message : "unknown"}`,
			);
		}
	}
}

/** True when every Work-media reference already names the Work's namespace. */
function isMigrated(plan: WorkPlan): boolean {
	return plan.keys.length === 0 && plan.prefixes.length === 0 && plan.quarantines.length === 0;
}

async function main(): Promise<void> {
	const argv = new Set(process.argv.slice(2));
	const apply = argv.has("--apply");
	const check = argv.has("--check");
	const abortSessions = argv.has("--abort-open-sessions");
	const single = process.argv.indexOf("--work");
	const workId = single >= 0 ? Number(process.argv[single + 1]) : null;
	const limitAt = process.argv.indexOf("--limit");
	const limit = limitAt >= 0 ? Number(process.argv[limitAt + 1]) : null;
	const reportAt = process.argv.indexOf("--report");
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const reportPath =
		reportAt >= 0 ? process.argv[reportAt + 1] : `cache/work-media-migration-${stamp}.json`;

	const summary: Summary = {
		stamp,
		apply,
		works: 0,
		skipped: 0,
		objects: 0,
		prefixes: 0,
		deleted: 0,
		warnings: [],
		failures: [],
		openSessions: 0,
	};

	const rows = await db
		.select()
		.from(works)
		.where(workId != null ? eq(works.id, workId) : undefined)
		.orderBy(works.id)
		.limit(limit != null && Number.isFinite(limit) ? limit : 100000);

	const openSessions = await db
		.select({ id: mediaUploadSessions.id, key: mediaUploadSessions.key })
		.from(mediaUploadSessions)
		.where(eq(mediaUploadSessions.status, "open"));
	summary.openSessions = openSessions.length;
	const legacySessions = openSessions.filter((s) => s.key.startsWith("creators/"));
	if (legacySessions.length > 0) {
		summary.warnings.push(
			`${legacySessions.length} open upload session(s) still target a creator prefix; ${
				abortSessions ? "aborting them" : "run with --abort-open-sessions to abort"
			}`,
		);
		if (apply && abortSessions) {
			for (const session of legacySessions) {
				await db
					.update(mediaUploadSessions)
					.set({ status: "aborted" })
					.where(eq(mediaUploadSessions.id, session.id));
			}
		}
	}

	for (const work of rows) {
		const plan = await planWork(work);
		await finishPlan(plan);
		await expandPrefixes(plan);
		summary.works += 1;
		if (check) {
			if (plan.keys.length === 0 && plan.quarantines.length === 0) {
				summary.skipped += 1;
				continue;
			}
			console.log(
				`work ${work.id}: ${plan.keys.length} object(s), ${plan.prefixes.length} prefix(es), ${plan.quarantines.length} quarantined`,
			);
			for (const warning of plan.warnings) console.log(`  ⚠ ${warning}`);
			continue;
		}
		if (isMigrated(plan)) {
			summary.skipped += 1;
			continue;
		}
		console.log(
			`work ${work.id} (“${work.title ?? ""}”): ${plan.keys.length} object(s), ${plan.prefixes.length} prefix(es), ${plan.quarantines.length} quarantined`,
		);
		const copied = await copyPlan(plan, apply, summary);
		summary.prefixes += plan.prefixes.length;
		if (!copied) {
			summary.failures.push({ workId: work.id, reason: plan.warnings.join("; ") });
			continue;
		}
		if (apply) {
			await rewritePlan(plan);
			await deleteOld(plan, summary);
		}
		summary.warnings.push(...plan.warnings.map((w) => `work ${work.id}: ${w}`));
	}

	await mkdir(dirname(reportPath), { recursive: true });
	await writeFile(
		reportPath,
		JSON.stringify({ summary, note: apply ? "applied" : "dry run — nothing written" }, null, 2),
	);
	console.log(
		`\n${apply ? "applied" : "dry run — nothing written"}: ${summary.works} Work(s) inspected, ` +
			`${summary.skipped} already migrated, ${money(summary.objects)} object(s) copied, ` +
			`${summary.prefixes} prefix(es), ${money(summary.deleted)} old object(s) deleted, ` +
			`${summary.failures.length} failure(s)`,
	);
	if (summary.failures.length > 0) {
		for (const failure of summary.failures) {
			console.error(`  ✗ work ${failure.workId}: ${failure.reason}`);
		}
		process.exitCode = 1;
	}
	console.log(`report: ${reportPath}`);
	process.exit(0);
}

await main();
