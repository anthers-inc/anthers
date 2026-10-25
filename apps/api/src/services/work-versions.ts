// SPDX-License-Identifier: Apache-2.0
/**
 * A Work's media versions — the one writer of `work_media_versions`.
 *
 * ⭐ **A version is history, never the current media.** The live deliverable stays on the
 * Work row, the source set and the build tables, because every reader, pipeline and listing
 * already reads it there. An archived version holds only the ORIGINAL bytes a replacement
 * retired: no HLS ladder, no remuxed MP4, no MP3, no rendered page, no reflow section. Its
 * manifest names storage keys so the purge and storage-usage enumerations can see them.
 *
 * 🚨 **The archive is written before the caller sweeps.** `archiveCurrentMedia` returns the
 * keys the version keeps; a caller that sweeps the prior media with `purgeReplacedWorkMedia`
 * passes those keys as `keep`, or it deletes the very original it just archived. That is why
 * the function returns a `Set` rather than a row alone.
 *
 * ⚠️ **A version's name and date are public; nothing else is.** The release build is the
 * baseline rather than the first entry, because it was uploaded while the Work was still
 * being made. `publicWorkVersions` returns every version added at or after the Work's first
 * release, as a name and a date — never a file, a size, a storage key or a download. Every
 * other read here is owner-scoped by its route.
 */

import {
	assets,
	db,
	type WorkVersionFile,
	type WorkVersionMedia,
	webBuildFiles,
	webBuilds,
	workMediaVersions,
	workSourceFiles,
	type works,
} from "@anthers/db";
import { hasSourceSet } from "@anthers/shared/content";
import { and, desc, eq, gte, ne } from "drizzle-orm";
import { storage } from "./storage/index.js";
import { isKeyUnder, urlToKey } from "./storage/keys.js";

type WorkRow = typeof works.$inferSelect;
type SourceFileRow = typeof workSourceFiles.$inferSelect;
type AssetRow = typeof assets.$inferSelect;
type WebBuildRow = typeof webBuilds.$inferSelect;
type WebBuildFileRow = typeof webBuildFiles.$inferSelect;
export type WorkMediaVersionRow = typeof workMediaVersions.$inferSelect;

/** The subset of the database a transaction and the module-level client both satisfy. */
type Executor = Pick<typeof db, "insert" | "select">;

/** The summary a creator's Versions list reads — filenames and sizes, never keys. */
export interface WorkVersionSummary {
	id: number;
	uploadedAt: string;
	versionLabel: string;
	archivedAt: string;
	kind: WorkVersionMedia["kind"];
	fileCount: number;
	totalBytes: number;
	files: { filename: string; fileSize: number | null }[];
	/**
	 * These bytes are preserved: Anthers keeps this version indefinitely.
	 *
	 * ⭐ **The version's own flag, not the Work's.** Preservation is granted to the bytes
	 * Anthers actually holds, and a Work's bytes are its versions' — so the record names
	 * the version, and the flag moves with it when a replace retires it.
	 */
	preserved: boolean;
}

/**
 * One version as a reader sees it — its name and the date it was added, and no more.
 *
 * The release build is deliberately absent from the list this type describes: it is the
 * baseline the reader is already looking at, and it was uploaded while the Work was being
 * made rather than after the Work was released.
 */
export interface PublicWorkVersion {
	versionLabel: string;
	addedAt: string;
}

/** A version's stored original, as a download has to name it. */
export interface WorkVersionStoredFile {
	filename: string;
	file: string;
}

function keyOf(value: string): string {
	return urlToKey(value);
}

function filenameOf(key: string): string {
	const name = key.split("/").pop() ?? "";
	return name || "original";
}

/** One file entry, filling a missing size from storage where the caller has only a key. */
async function sourceFileEntry(value: string): Promise<WorkVersionFile> {
	const file = keyOf(value);
	let fileSize: number | null = null;
	try {
		fileSize = await storage.size(file);
	} catch {
		fileSize = null;
	}
	return { file, filename: filenameOf(file), fileSize, mimeType: "" };
}

function setFileEntry(row: SourceFileRow): WorkVersionFile {
	const file = keyOf(row.file);
	return {
		file,
		filename: row.filename || filenameOf(file),
		fileSize: row.fileSize ?? null,
		mimeType: row.mimeType || "",
	};
}

function assetEntry(row: AssetRow) {
	return {
		file: keyOf(row.file),
		filename: row.filename,
		fileSize: row.fileSize ?? null,
		mimeType: row.mimeType ?? "",
		platform: row.platform ?? "",
		version: row.version ?? "",
		isPrimary: row.isPrimary ?? false,
	};
}

function webBuildEntry(row: WebBuildRow, files: WebBuildFileRow[]) {
	return {
		label: row.label,
		entryPath: row.entryPath,
		requiresIsolation: row.requiresIsolation,
		files: files.map((file) => ({
			path: file.path,
			storageKey: keyOf(file.storageKey),
			fileSize: file.fileSize ?? null,
			mimeType: file.mimeType ?? "",
		})),
	};
}

/**
 * Snapshot the media a Work currently holds, or null when it holds none this table tracks.
 *
 * Builds are read first because a game can carry both downloadable assets and a hosted web
 * build; a set comes next; a single source is the fallback. A set kind with only the legacy
 * `source_key` becomes a one-file set, the same reading `listSourceFiles` gives it.
 */
async function snapshotMedia(
	work: WorkRow,
	sourceRows: SourceFileRow[],
	assetRows: AssetRow[],
	buildRows: WebBuildRow[],
	buildFileRows: WebBuildFileRow[],
): Promise<WorkVersionMedia | null> {
	if (assetRows.length > 0 || buildRows.length > 0) {
		const filesByBuild = new Map<number, WebBuildFileRow[]>();
		for (const file of buildFileRows) {
			const list = filesByBuild.get(file.buildId) ?? [];
			list.push(file);
			filesByBuild.set(file.buildId, list);
		}
		return {
			kind: "builds",
			assets: assetRows.map(assetEntry),
			webBuilds: buildRows.map((row) => webBuildEntry(row, filesByBuild.get(row.id) ?? [])),
		};
	}
	if (hasSourceSet(work.type) && sourceRows.length > 0) {
		return { kind: "set", files: sourceRows.map(setFileEntry) };
	}
	const source = work.sourceOriginalKey || work.sourceKey;
	if (!source) return null;
	if (hasSourceSet(work.type)) {
		// A legacy set whose rows have not been written yet: it is a one-file set.
		return { kind: "set", files: [await sourceFileEntry(source)] };
	}
	return { kind: "source", file: await sourceFileEntry(source) };
}

/**
 * Archive the Work's current media as a historical version, and report the keys it keeps.
 *
 * The caller passes the row as it stands BEFORE the replacement is written; the executor
 * lets the archive share the replacement's transaction. A Work with no media this table
 * tracks returns null, and there is no version to record.
 */
export async function archiveCurrentMedia(
	work: WorkRow,
	exec: Executor = db,
	options: {
		/**
		 * A build not to snapshot. The hosted-build completion route promotes a build whose
		 * row and files already exist, so the media being retired is everything except it.
		 */
		excludeWebBuildId?: number;
	} = {},
): Promise<{ version: WorkMediaVersionRow; keeps: Set<string> } | null> {
	const [sourceRows, assetRows, buildRows, buildFileRows] = await Promise.all([
		exec.select().from(workSourceFiles).where(eq(workSourceFiles.workId, work.id)),
		exec.select().from(assets).where(eq(assets.workId, work.id)),
		exec.select().from(webBuilds).where(eq(webBuilds.workId, work.id)),
		exec
			.select({ file: webBuildFiles })
			.from(webBuildFiles)
			.innerJoin(webBuilds, eq(webBuildFiles.buildId, webBuilds.id))
			.where(eq(webBuilds.workId, work.id)),
	]);
	const excluded = options.excludeWebBuildId;
	const media = await snapshotMedia(
		work,
		sourceRows,
		assetRows,
		excluded == null ? buildRows : buildRows.filter((row) => row.id !== excluded),
		buildFileRows
			.map((entry) => entry.file)
			.filter((file) => excluded == null || file.buildId !== excluded),
	);
	if (!media) return null;
	const [version] = await exec
		.insert(workMediaVersions)
		.values({
			workId: work.id,
			// The date this media carried as current; the Work's own creation is the
			// fallback for a row that predates the column's backfill.
			uploadedAt: work.versionAddedAt ?? work.createdAt,
			// The name it carried while it was current, so a reader's history keeps it.
			versionLabel: work.versionLabel,
			// ⭐ **The flag moves with the version.** Whatever this media held while it
			// was the one being served, it keeps — preservation marks the bytes Anthers
			// undertook to keep, and those bytes are these.
			preserved: work.preserved,
			media,
		})
		.returning();
	if (!version) return null;
	return { version, keeps: keysInMedia(media) };
}

/**
 * Archive a source SET about to be replaced. The set rows are the truth for the paged kinds
 * and the image gallery; the caller reads them before `syncFromSourceKey` deletes them and
 * passes the date the set carried as current.
 */
export async function archiveSourceSet(
	work: WorkRow,
	rows: SourceFileRow[],
	uploadedAt: Date,
	exec: Executor = db,
): Promise<{ version: WorkMediaVersionRow; keeps: Set<string> } | null> {
	const real = rows.filter((row) => row.id !== 0);
	if (real.length === 0) return null;
	const files = real.map(setFileEntry);
	const [version] = await exec
		.insert(workMediaVersions)
		.values({
			workId: work.id,
			uploadedAt,
			versionLabel: work.versionLabel,
			preserved: work.preserved,
			media: { kind: "set", files },
		})
		.returning();
	if (!version) return null;
	return { version, keeps: new Set(files.map((file) => file.file)) };
}

/**
 * Archive a legacy set's single source — the `works.source_key` shape an old client or a
 * raw attach leaves before the source-set table has a row. It is the same one-file set
 * `listSourceFiles` reads, and its original is the creator's uploaded file.
 */
export async function archiveLegacySource(
	work: WorkRow,
	source: string,
	uploadedAt: Date,
	exec: Executor = db,
): Promise<{ version: WorkMediaVersionRow; keeps: Set<string> } | null> {
	const file = await sourceFileEntry(source);
	const [version] = await exec
		.insert(workMediaVersions)
		.values({
			workId: work.id,
			uploadedAt,
			versionLabel: work.versionLabel,
			preserved: work.preserved,
			media: { kind: "set", files: [file] },
		})
		.returning();
	if (!version) return null;
	return { version, keeps: new Set([file.file]) };
}

/** Every storage key a version manifest owns. */
export function keysInMedia(media: WorkVersionMedia): Set<string> {
	if (media.kind === "source") return new Set([media.file.file]);
	if (media.kind === "set") return new Set(media.files.map((file) => file.file));
	return new Set([
		...media.assets.map((asset) => asset.file),
		...media.webBuilds.flatMap((build) => build.files.map((file) => file.storageKey)),
	]);
}

/** The creator's archived versions, newest first. */
export async function listWorkVersions(workId: number): Promise<WorkMediaVersionRow[]> {
	return db
		.select()
		.from(workMediaVersions)
		.where(eq(workMediaVersions.workId, workId))
		.orderBy(desc(workMediaVersions.uploadedAt), desc(workMediaVersions.id));
}

/**
 * Every version a reader may see — the ones added at or after the Work was released.
 *
 * The current version is a row on `works`, not in the archive, so it is assembled here
 * beside the archived rows. Both halves are filtered by `releasedAt`: a version uploaded
 * while the Work was still being made is the baseline, not an entry. `releasedAt` is
 * stamped on the first release and never moved, so withdrawing and releasing the Work
 * again does not retroactively hide what it gained during its first public life.
 *
 * ⚠️ **Names and dates only.** No file list, size or download rides this shape; the
 * archive's originals stay behind the owner-only routes.
 */
export async function publicWorkVersions(work: WorkRow): Promise<PublicWorkVersion[]> {
	if (!work.releasedAt) return [];
	const releasedAt = work.releasedAt.getTime();
	const rows = await db
		.select({
			uploadedAt: workMediaVersions.uploadedAt,
			versionLabel: workMediaVersions.versionLabel,
		})
		.from(workMediaVersions)
		.where(
			and(
				eq(workMediaVersions.workId, work.id),
				gte(workMediaVersions.uploadedAt, work.releasedAt),
			),
		);
	const entries: PublicWorkVersion[] = rows.map((row) => ({
		versionLabel: row.versionLabel,
		addedAt: row.uploadedAt.toISOString(),
	}));
	if (work.versionAddedAt.getTime() >= releasedAt) {
		entries.push({
			versionLabel: work.versionLabel,
			addedAt: work.versionAddedAt.toISOString(),
		});
	}
	return entries.sort((a, b) => a.addedAt.localeCompare(b.addedAt));
}

/** The list shape the Versions tab reads. */
export function summarizeVersion(row: WorkMediaVersionRow): WorkVersionSummary {
	const media = row.media;
	const files =
		media.kind === "source"
			? [{ filename: media.file.filename, fileSize: media.file.fileSize }]
			: media.kind === "set"
				? media.files.map((file) => ({ filename: file.filename, fileSize: file.fileSize }))
				: [
						...media.assets.map((asset) => ({
							filename: asset.filename,
							fileSize: asset.fileSize,
						})),
						...media.webBuilds.flatMap((build) =>
							build.files.map((file) => ({
								filename: `${build.label || "build"}/${file.path}`,
								fileSize: file.fileSize,
							})),
						),
					];
	return {
		id: row.id,
		uploadedAt: row.uploadedAt.toISOString(),
		versionLabel: row.versionLabel,
		archivedAt: row.archivedAt.toISOString(),
		kind: media.kind,
		fileCount: files.length,
		totalBytes: files.reduce((sum, file) => sum + (file.fileSize ?? 0), 0),
		files,
		preserved: row.preserved,
	};
}

/** The stored originals a version hands over, in manifest order. */
export function versionFiles(version: WorkMediaVersionRow): WorkVersionStoredFile[] {
	const media = version.media;
	if (media.kind === "source") return [{ filename: media.file.filename, file: media.file.file }];
	if (media.kind === "set") {
		return media.files.map((file) => ({ filename: file.filename, file: file.file }));
	}
	return [
		...media.assets.map((asset) => ({ filename: asset.filename, file: asset.file })),
		...media.webBuilds.flatMap((build) =>
			build.files.map((file) => ({
				// A path's slashes are not a filename; flatten them so the attachment names a
				// file a browser can save.
				filename: `${build.label || "build"}-${file.path.replace(/\//g, "-")}`,
				file: file.storageKey,
			})),
		),
	];
}

/** Everything the current Work still references, so a version never deletes a live key. */
async function keysInUse(work: WorkRow, exceptVersionId: number): Promise<Set<string>> {
	const [sourceRows, assetRows, buildFileRows, otherVersions] = await Promise.all([
		db.select().from(workSourceFiles).where(eq(workSourceFiles.workId, work.id)),
		db.select().from(assets).where(eq(assets.workId, work.id)),
		db
			.select({ file: webBuildFiles })
			.from(webBuildFiles)
			.innerJoin(webBuilds, eq(webBuildFiles.buildId, webBuilds.id))
			.where(eq(webBuilds.workId, work.id)),
		db
			.select({ media: workMediaVersions.media })
			.from(workMediaVersions)
			.where(
				and(
					eq(workMediaVersions.workId, work.id),
					// A version cannot collide with itself; the rows left are the ones a
					// removal must not strand for.
					ne(workMediaVersions.id, exceptVersionId),
				),
			),
	]);
	const keys = new Set<string>();
	for (const value of [work.sourceKey, work.sourceOriginalKey, work.thumbnail]) {
		if (value) keys.add(keyOf(value));
	}
	for (const row of sourceRows) keys.add(keyOf(row.file));
	for (const row of assetRows) keys.add(keyOf(row.file));
	for (const row of buildFileRows) keys.add(keyOf(row.file.storageKey));
	for (const row of otherVersions) for (const key of keysInMedia(row.media)) keys.add(key);
	return keys;
}

/**
 * Remove one archived version and its originals. The current media is never touched, and a
 * key another version or the live Work still references is kept rather than deleted.
 *
 * ⚠️ **A removal edits the public history when the version was added after release**, because
 * the Work page lists that version by name and date. The originals are the creator's and go
 * with the row; the entry on the page goes with it too.
 */
export async function removeWorkVersion(work: WorkRow, versionId: number): Promise<boolean> {
	const [version] = await db
		.select()
		.from(workMediaVersions)
		.where(and(eq(workMediaVersions.id, versionId), eq(workMediaVersions.workId, work.id)))
		.limit(1);
	if (!version) return false;
	const inUse = await keysInUse(work, version.id);
	const owner = work.creatorId;
	const keys = [...keysInMedia(version.media)].filter(
		(key) => !inUse.has(key) && owner != null && isKeyUnder(key, owner),
	);
	await db.delete(workMediaVersions).where(eq(workMediaVersions.id, version.id));
	for (const key of keys) {
		try {
			await storage.delete(key);
		} catch (err) {
			// The row is gone; a stranded object is better than a failed removal.
			console.error(`[work-versions] delete failed for ${key}:`, err);
		}
	}
	return true;
}

/** The version row, or null when it is not this Work's. */
export async function findWorkVersion(
	workId: number,
	versionId: number,
): Promise<WorkMediaVersionRow | null> {
	const [version] = await db
		.select()
		.from(workMediaVersions)
		.where(and(eq(workMediaVersions.id, versionId), eq(workMediaVersions.workId, workId)))
		.limit(1);
	return version ?? null;
}
