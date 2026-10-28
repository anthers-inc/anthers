// SPDX-License-Identifier: Apache-2.0
/**
 * The storage ladder's meter — snapshot what each account holds against its allowance.
 *
 * One row per (account, cycle) in `user_cycles`, recomputed daily and idempotent per
 * cycle: the upsert is keyed on (userId, billingCycle), so a repeated run rewrites the
 * in-flight month's row in place and never duplicates. The cycle's last snapshot is the
 * figure billing reads — a running estimate that solidifies at settlement, the same
 * posture `GET /earnings` takes (`settled: true|false` rather than a second kind of
 * number).
 *
 * 🚨 **Bytes are counted from the database rows, never from walking the bucket's
 * `creators/{id}/` prefix.** The schema doc on `user_cycles` carries the full
 * reasoning: the DB is the authority billing reads, a bucket walk would
 * sweep avatars and display chrome the ladder never prices, and a paginated
 * `ListObjectsV2` per account per night is an API bill paid to measure figures grouped
 * queries answer. The surfaces and how each is reached:
 *
 * - **Assets and build files carry their own sizes** — `work_assets.file_size` and
 *   `work_build_files.file_size`, summed per account in grouped queries; the same
 *   authority the top-up line prices from, so the invoice and this meter cannot
 *   disagree about a creator's catalog.
 * - **The Work record's own media** — `works.source_key`, `works.source_original_key`
 *   and `works.thumbnail` — are the columns whose size is carried nowhere in the
 *   database, so they are this job's one per-row `size()` cost: up to three heads per
 *   Work, once a day, on rows a whole-table sweep reaches anyway.
 * - **HLS output** — a transcoding job's manifest key names its rendition prefix (the
 *   read `media-purge.ts` already established: master key minus its file). One
 *   `prefixSize` per job row — narrow, per-Work, exactly the priced population.
 * - **Inline images** — a creator's post body images, no table carries their size, so
 *   one `prefixSize` per creator prefix. These are body content rather than display
 *   chrome, which is what puts this prefix on the metered side of the line
 *   `aclForMediaType` draws: the ladder's catalog purpose is where body images bill.
 * - **Paged derived storage** — a paged Work's rendered pages and a reflow ebook's
 *   ladder, all under `creators/{id}/ebook/` (the prefix `media-purge.ts` sweeps), so
 *   one `prefixSize` per creator with paged Works, on the inline-images pattern.
 * - **Cloud saves** — `work_saves.byte_size`, attributed to the *player's* account: the
 *   blob charges the player's floor like anything else they keep.
 *
 * 🚨 **Preserved bytes are counted for nobody.** They are the program's cost
 * (`services/preservation.ts`), so each query reads the flag on the version it counts:
 * the current version's on `works.preserved`, an archived one's on
 * `work_media_versions.preserved`. A saved Work's media does not draw its creator's
 * allowance, and no buyer draws a share of it either. Two figures cannot be attributed per Work —
 * the creator-level inline-image prefix, which is post body content with no Work link,
 * and a Work's preview objects, whose keys carry no Work id — so previews are subtracted
 * one preserved row at a time and inline images stay where they are. Both are display and
 * body bytes rather than a Work's own media, and saying so is more honest than pretending
 * the exclusion is total.
 *
 * Attribution is per-purpose (`catalog`, `cloud-saves`) under one summed figure, because
 * the allowance is combined but the reading a creator sees is per-purpose.
 */

import { db } from "@anthers/db/client";
import {
	inlineImages,
	userCycles,
	workAssets,
	workBuildFiles,
	workBuilds,
	workMediaVersions,
	workPreviewMedia,
	workSaves,
	workSourceFiles,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { STORAGE_USE_KINDS, type StorageUseKind } from "@anthers/shared/constants";
import { isPaged } from "@anthers/shared/content";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { storage } from "../services/storage/index.js";
import { urlToKey } from "../services/storage/keys.js";
import { keysInMedia } from "../services/work-versions.js";

/**
 * The byte size of one stored object, by key — `null` when absent.
 *
 * Empty keys are `null` by construction (a Work without a source names no object), and a
 * `size()` failure is swallowed into `null` after logging: a reading is best-effort in the
 * same posture `media-purge.ts` takes toward its sweeps, and a missing figure reports as
 * absent rather than as zero — zero would silently *undercount* the account's draw, which
 * for a meter is the one error that hides cost.
 */
async function sizeOfKey(key: string | null | undefined): Promise<number | null> {
	if (!key) return null;
	const storageKey = urlToKey(key);
	if (!storageKey) return null;
	try {
		return await storage.size(storageKey);
	} catch (err) {
		console.error(`[storage-usage] size() failed for ${storageKey}:`, err);
		return null;
	}
}

/**
 * The total bytes under one prefix.
 *
 * A per-Work HLS prefix or a per-creator inline-images prefix — both exactly the priced
 * population, never the broad `creators/{id}/` walk the DB-first rule forbids. Failures
 * log and answer zero: an undercount reported beside the row's other figures, never a run
 * lost to one prefix.
 */
async function prefixBytes(prefix: string): Promise<number> {
	try {
		return await storage.prefixSize(prefix);
	} catch (err) {
		console.error(`[storage-usage] prefixSize failed for ${prefix}:`, err);
		return 0;
	}
}

/**
 * A new, empty per-purpose split — every known kind zeroed.
 *
 * Built from the closed set rather than a literal, so a kind declared in
 * `STORAGE_USE_KINDS` but never wired into the sweep's collection shows up in every
 * snapshot as a standing zero — visible — rather than as a key absent from every row —
 * silent.
 */
function emptyPurposes(): Record<StorageUseKind, number> {
	return Object.fromEntries(STORAGE_USE_KINDS.map((k) => [k, 0])) as Record<StorageUseKind, number>;
}

/** Add `bytes` to one kind, as a whole number — sizes can arrive fractional in tests. */
function add(purposes: Record<StorageUseKind, number>, kind: StorageUseKind, bytes: number): void {
	purposes[kind] += Math.max(0, Math.round(bytes ?? 0));
}

/**
 * Snapshot every account's usage for the current cycle and upsert the rows.
 *
 * **The shape is one day's sweep, not one account's question.** The daily job reads the
 * whole population in a handful of grouped queries and per-row `size()` calls bounded by
 * the day, and the per-account reading (`services/storage-reading.ts`) composes its answer
 * from the stored row — it never recomputes, so the route figure is always the figure the
 * meter stored, not a second derivation that could drift from it.
 *
 * The sweep is deliberately quiet on an empty population, `0` like every other job's
 * worker, so a dev session that stored nothing produces no rows and no noise.
 */
export async function runStorageUsageSweep(now = new Date()): Promise<number> {
	const cycle = currentCycleKey(now);

	// Per-account accumulators. Rows enter when the first query that sees the account
	// brings it in; every later query adds onto the same split.
	const byUser = new Map<number, { purposes: Record<StorageUseKind, number> }>();
	const account = (userId: number) => {
		let entry = byUser.get(userId);
		if (!entry) {
			entry = { purposes: emptyPurposes() };
			byUser.set(userId, entry);
		}
		return entry;
	};

	// ── Assets, by the Work's creator ────────────────────────────────────────────
	// The figure the storage top-up prices from. A null-creator Work's rows cannot be
	// attributed and are skipped by the join condition rather than summed into nobody.
	const assetRows = await db
		.select({
			creatorId: works.creatorId,
			total: sql<string>`COALESCE(SUM(${workAssets.fileSize}), 0)`,
		})
		.from(workAssets)
		.innerJoin(works, eq(workAssets.workId, works.id))
		.where(and(sql`${works.creatorId} IS NOT NULL`, eq(works.preserved, false)))
		.groupBy(works.creatorId);
	for (const row of assetRows) {
		if (row.creatorId == null) continue;
		add(account(row.creatorId).purposes, "catalog", Number(row.total));
	}

	// ── Browser build files, through the build and its Work ─────────────────────
	const buildRows = await db
		.select({
			creatorId: works.creatorId,
			total: sql<string>`COALESCE(SUM(${workBuildFiles.fileSize}), 0)`,
		})
		.from(workBuildFiles)
		.innerJoin(workBuilds, eq(workBuildFiles.buildId, workBuilds.id))
		.innerJoin(works, eq(workBuilds.workId, works.id))
		.where(and(sql`${works.creatorId} IS NOT NULL`, eq(works.preserved, false)))
		.groupBy(works.creatorId);
	for (const row of buildRows) {
		if (row.creatorId == null) continue;
		add(account(row.creatorId).purposes, "catalog", Number(row.total));
	}

	// ── HLS output, one prefix read per transcoding job with a manifest ──────────
	const hlsRows = await db
		.select({ creatorId: works.creatorId, manifestKey: workTranscodingJobs.hlsManifestUrl })
		.from(workTranscodingJobs)
		.innerJoin(works, eq(workTranscodingJobs.workId, works.id))
		.where(
			and(
				sql`${works.creatorId} IS NOT NULL AND ${workTranscodingJobs.hlsManifestUrl} <> ''`,
				eq(works.preserved, false),
			),
		);
	for (const row of hlsRows) {
		if (row.creatorId == null) continue;
		// The manifest's key minus its file IS the rendition prefix — the same read
		// `media-purge.ts` established, pasted as the rule it is rather than re-derived.
		const masterKey = urlToKey(row.manifestKey ?? "");
		if (!masterKey) continue;
		const slash = masterKey.lastIndexOf("/");
		if (slash <= 0) continue;
		const prefix = `${masterKey.slice(0, slash)}/`;
		add(account(row.creatorId).purposes, "catalog", await prefixBytes(prefix));
	}

	// ── Inline images, one prefix read per creator ───────────────────────────────
	const imageRows = await db
		.select({ creatorId: inlineImages.creatorId })
		.from(inlineImages)
		.groupBy(inlineImages.creatorId);
	for (const row of imageRows) {
		// The prefix carries the images' keys by construction (`inline_images.image`
		// stores exactly the key under the creator's prefix), and this is the case the
		// DB-first rule bends for: no table carries these sizes, and one prefix read per
		// *creator with images* is a bounded population, not the per-account walk.
		add(
			account(row.creatorId).purposes,
			"catalog",
			await prefixBytes(`creators/${row.creatorId}/inline-images/`),
		);
	}

	// ── The Work record's own media, sized where it is stored ────────────────────
	// Two `size()` heads per Work with a source or thumbnail. This is the one surface
	// the database cannot answer, because these columns' sizes are carried nowhere.
	const mediaRows = await db
		.select({
			creatorId: works.creatorId,
			sourceKey: works.sourceKey,
			sourceOriginalKey: works.sourceOriginalKey,
			thumbnail: works.thumbnail,
		})
		.from(works)
		.where(and(sql`${works.creatorId} IS NOT NULL`, eq(works.preserved, false)));
	for (const row of mediaRows) {
		if (row.creatorId == null) continue;
		const purposes = account(row.creatorId).purposes;
		const source = await sizeOfKey(row.sourceKey);
		if (source != null) add(purposes, "catalog", source);
		// The remux-retained original rides its pointer column, so a Work whose MKV was
		// remuxed in place meters the original's bytes too — the un-metered remnant was
		// the shape the pointer column exists to end.
		const original = await sizeOfKey(row.sourceOriginalKey);
		if (original != null) add(purposes, "catalog", original);
		const thumb = await sizeOfKey(row.thumbnail);
		if (thumb != null) add(purposes, "catalog", thumb);
	}

	// ── A paged Work's source set ────────────────────────────────────────────────
	// Each file is a creator original in its own right, and the set is the row-level
	// truth for the paged kinds — so they enter the account's catalog total here,
	// beside the column-sized media above.
	const setRows = await db
		.select({ creatorId: works.creatorId, file: workSourceFiles.file })
		.from(workSourceFiles)
		.innerJoin(works, eq(workSourceFiles.workId, works.id))
		.where(eq(works.preserved, false));
	for (const row of setRows) {
		if (row.creatorId == null) continue;
		const size = await sizeOfKey(row.file);
		if (size != null) add(account(row.creatorId).purposes, "catalog", size);
	}

	// ── Archived media versions ──────────────────────────────────────────────────
	// A version keeps the original bytes a replacement retired, so it still occupies the
	// creator's storage after it stops being served. Its manifest names the keys; the
	// history is small enough that one size() per archived object is the same bounded
	// read the source set above already pays.
	const versionRows = await db
		.select({ creatorId: works.creatorId, media: workMediaVersions.media })
		.from(workMediaVersions)
		.innerJoin(works, eq(workMediaVersions.workId, works.id))
		// ⭐ Each archived version carries its own flag, so the exclusion reads the
		// version rather than the Work: the bytes preserved are that version's bytes.
		.where(and(isNotNull(works.creatorId), eq(workMediaVersions.preserved, false)));
	for (const row of versionRows) {
		if (row.creatorId == null) continue;
		for (const key of keysInMedia(row.media)) {
			const size = await sizeOfKey(key);
			if (size != null) add(account(row.creatorId).purposes, "catalog", size);
		}
	}

	// ── A paged Work's derived storage, one prefix read per creator ─────────────
	// The rendered pages (and a reflow ebook's ladder sections) live entirely under
	// `creators/{id}/ebook/`, one per-run sub-prefix per render or ingest — the same
	// deterministic prefix `media-purge.ts` sweeps. No table carries these sizes, so
	// this is the inline-images bend again: one prefix read per *creator with paged
	// Works* is a bounded population, and every byte the runs wrote is inside it.
	const pagedWorks = await db
		.selectDistinct({ creatorId: works.creatorId, type: works.type })
		.from(works)
		.where(and(isNotNull(works.creatorId), eq(works.preserved, false)));
	for (const row of pagedWorks) {
		if (row.creatorId == null || !isPaged(row.type)) continue;
		const bytes = await prefixBytes(`creators/${row.creatorId}/ebook/`);
		if (bytes > 0) add(account(row.creatorId).purposes, "catalog", bytes);
	}
	// ⚠️ **The prefix is per creator, so a preserved Work's run sits inside the figure
	// above.** Its own sub-prefix IS per Work, so it can be taken back exactly — the
	// opposite of the preview case, where the keys carry no Work id.
	const preservedPaged = await db
		.selectDistinct({ id: works.id, creatorId: works.creatorId, type: works.type })
		.from(works)
		.where(and(isNotNull(works.creatorId), eq(works.preserved, true)));
	for (const row of preservedPaged) {
		if (row.creatorId == null || !isPaged(row.type)) continue;
		const bytes = await prefixBytes(`creators/${row.creatorId}/ebook/${row.id}/`);
		if (bytes <= 0) continue;
		const purposes = account(row.creatorId).purposes;
		purposes.catalog = Math.max(0, purposes.catalog - bytes);
	}

	// ── Preview media, one prefix read per creator, less what the program holds ──
	// A Work's storefront screenshots, trailer and trailer captions all live under
	// `creators/{id}/previews/` by construction, and no row carries the images' byte
	// sizes — the inline-images bend again, bounded to creators who have previews.
	// ⚠️ **The prefix is creator-wide and its keys carry no Work id**, so a preserved
	// Work's previews cannot be excluded from the walk. They are subtracted instead, one
	// preserved row at a time: a `size()` per object, which is the same bounded read the
	// Work record's own media already pays, and only for Works the program holds.
	const previewCreators = await db
		.selectDistinct({ creatorId: works.creatorId })
		.from(workPreviewMedia)
		.innerJoin(works, eq(workPreviewMedia.workId, works.id))
		.where(isNotNull(works.creatorId));
	for (const row of previewCreators) {
		if (row.creatorId == null) continue;
		const bytes = await prefixBytes(`creators/${row.creatorId}/previews/`);
		if (bytes > 0) add(account(row.creatorId).purposes, "catalog", bytes);
	}
	const preservedPreviewRows = await db
		.select({ creatorId: works.creatorId, file: workPreviewMedia.file })
		.from(workPreviewMedia)
		.innerJoin(works, eq(workPreviewMedia.workId, works.id))
		.where(and(isNotNull(works.creatorId), eq(works.preserved, true)));
	for (const row of preservedPreviewRows) {
		if (row.creatorId == null) continue;
		const size = await sizeOfKey(row.file);
		if (size == null) continue;
		const purposes = account(row.creatorId).purposes;
		// `add` floors at zero by design (a sum of sizes is never negative); a
		// subtraction is the one place that floor would swallow the correction.
		purposes.catalog = Math.max(0, purposes.catalog - size);
	}

	// ── Cloud saves, by the player ───────────────────────────────────────────────
	const saveRows = await db
		.select({
			userId: workSaves.userId,
			total: sql<string>`COALESCE(SUM(${workSaves.byteSize}), 0)`,
		})
		.from(workSaves)
		.groupBy(workSaves.userId);
	for (const row of saveRows) {
		add(account(row.userId).purposes, "cloud-saves", Number(row.total));
	}

	// ── Upsert, one row per account with any bytes at all ────────────────────────
	// An account with zero bytes across every kind writes no row: an empty reading is
	// indistinguishable from "not yet metered", and a row of zeros per idle account is
	// noise the reading surface would have to filter.
	let written = 0;
	for (const [userId, entry] of byUser) {
		const total = STORAGE_USE_KINDS.reduce((sum, k) => sum + entry.purposes[k], 0);
		if (total === 0) continue;
		await db
			.insert(userCycles)
			.values({
				userId,
				billingCycle: cycle,
				bytes: total,
				purposes: { ...entry.purposes },
				// The upsert carries this run's stamp: one row per (user, cycle), and
				// sampled_at names when the current figure was taken. A row the settlement
				// side wrote keeps its money columns untouched.
				sampledAt: new Date(),
			})
			.onConflictDoUpdate({
				target: [userCycles.userId, userCycles.billingCycle],
				set: {
					bytes: sql`excluded.bytes`,
					purposes: sql`excluded.purposes`,
					sampledAt: sql`excluded.sampled_at`,
				},
			});
		written += 1;
	}
	return written;
}
