// SPDX-License-Identifier: Apache-2.0
/**
 * The reader-state cutover: Postgres rows to user-space records, with a switch that goes back.
 *
 * 🚨 **The migration is reversible because nothing is deleted.** The backfill reads every row
 * into the outbox, drains it through the verified write path, and only then flips
 * `users.reader_state_home` to `space`. The rows stay current through the transition, so a
 * rollback flips the flag back to `db` and the database is canonical again; the space keeps a
 * snapshot rather than the truth. Flipping forward again re-runs the backfill over whatever the
 * rows say now, which is how a rollback becomes a retry rather than a second migration.
 *
 * ⚠️ **The flag flips only after the outbox is empty for this account.** A failed read-back
 * leaves its row in place, the migration reports `outbox_not_cleared`, and the account stays on
 * the database. A cutover that ignored that would make the space look canonical while a write
 * was still owed to it.
 *
 * ⭐ **During the transition both copies are written.** The request still writes the row (so
 * the Library answers immediately and a rollback loses nothing), and the worker writes the
 * space and re-projects. Removing the direct row write is the end of the migration, once the
 * projection is proven; it is deliberately not part of the cutover, because the failure mode
 * of removing it too early is a Save that shows up nowhere.
 */
import { db } from "@anthers/db";
import {
	libraryItems,
	readingPositions,
	spaceOutbox,
	users,
	workSaves,
	works,
} from "@anthers/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drainSpaceOutbox, enqueueLibraryItem, queueSpaceWrite } from "./space-outbox.js";
import {
	type LibraryItemState,
	readingPositionRecord,
	readingPositionRkey,
	USER_SPACE_COLLECTIONS,
	workSaveRecord,
	workSaveRkey,
} from "./space-records.js";
import { ensureUserSpace, registeredSpace } from "./space-registry.js";
import type { ResolveSpaceSession } from "./space-writer.js";

export interface ReaderStateReport {
	library: number;
	positions: number;
	saves: number;
	cleared: number;
	remaining: number;
	failures: number;
}

export interface ReaderStateOptions {
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
	now?: Date;
}

export type ReaderStateMigration =
	| { ok: true; report: ReaderStateReport }
	| { ok: false; reason: string; report?: ReaderStateReport };

/** Which copy is canonical for this account. */
export async function readerStateHome(userId: number): Promise<"db" | "space"> {
	const [row] = await db
		.select({ readerStateHome: users.readerStateHome })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row?.readerStateHome === "space" ? "space" : "db";
}

/**
 * Backfill this account's reader state into its space and flip the cutover.
 *
 * The outbox is drained in bounded passes so a large Library does not hold one request or job
 * forever; the caller sees the count that remained and can run it again.
 */
export async function migrateReaderState(
	userId: number,
	opts: ReaderStateOptions = {},
): Promise<ReaderStateMigration> {
	let space = await registeredSpace(userId);
	if (!space) {
		// ⭐ **The cutover is what creates the Library space for an account that has never
		// written one.** Every other caller reaches `ensureUserSpace` after a write has been
		// queued; this is the first operation on a fresh account, so waiting for a row would
		// leave the operator's one command unable to start. A genuine failure to create still
		// reports the registry's own reason rather than a bare `no_space`.
		const ensured = await ensureUserSpace(userId, opts);
		if (!ensured.space) return { ok: false, reason: ensured.reason ?? "no_space" };
		space = ensured.space;
	}

	const [library, positions, saves] = await Promise.all([
		db.select().from(libraryItems).where(eq(libraryItems.userId, userId)),
		db.select().from(readingPositions).where(eq(readingPositions.userId, userId)),
		db.select().from(workSaves).where(eq(workSaves.userId, userId)),
	]);

	const workIds = [
		...library.map((row) => row.workId),
		...positions.map((row) => row.workId),
		...saves.map((row) => row.workId),
	].filter((id): id is number => id != null);
	const uris = await workUris(workIds);

	for (const row of library) {
		const subject = librarySubject(row);
		if (!subject) continue;
		const state: LibraryItemState = {
			subject: { ...subject, uri: subject.kind === "work" ? (uris.get(subject.id) ?? null) : null },
			hidden: row.hidden,
			sortOrder: row.sortOrder,
			savedAt: row.savedAt,
		};
		await enqueueLibraryItem(userId, state);
	}

	for (const row of positions) {
		const record = readingPositionRecord({
			workId: row.workId,
			workUri: uris.get(row.workId) ?? null,
			progress: row.progress,
			position: row.position,
			updatedAt: row.updatedAt,
		});
		await queueSpaceWrite({
			userId,
			did: space.did,
			spaceUri: space.spaceUri,
			collection: USER_SPACE_COLLECTIONS.readingPosition,
			rkey: readingPositionRkey(row.workId),
			op: "put",
			record,
		});
	}

	for (const row of saves) {
		const record = workSaveRecord({
			workId: row.workId,
			workUri: uris.get(row.workId) ?? null,
			save: row.blob,
			runtime: row.runtime,
			note: row.note,
			byteSize: row.byteSize,
			updatedAt: row.updatedAt,
		});
		await queueSpaceWrite({
			userId,
			did: space.did,
			spaceUri: space.spaceUri,
			collection: USER_SPACE_COLLECTIONS.workSave,
			rkey: workSaveRkey(row.workId),
			op: "put",
			record,
		});
	}

	const report: ReaderStateReport = {
		library: library.length,
		positions: positions.length,
		saves: saves.length,
		cleared: 0,
		remaining: 0,
		failures: 0,
	};

	for (let pass = 0; pass < 20; pass++) {
		const drained = await drainSpaceOutbox({ ...opts, limit: 50 });
		report.cleared += drained.cleared;
		report.failures += drained.failures.length;
		if (drained.claimed === 0) break;
	}

	// Every cleared row is deleted, so any row left for this account is a write still owed.
	const [remaining] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(spaceOutbox)
		.where(eq(spaceOutbox.userId, userId));
	report.remaining = Number(remaining?.n ?? 0);

	// A pending or failed row for this account means a write is still owed; leave the flag on
	// the database and say so.
	if (report.remaining > 0) {
		return { ok: false, reason: "outbox_not_cleared", report };
	}

	await db.update(users).set({ readerStateHome: "space" }).where(eq(users.id, userId));
	return { ok: true, report };
}

/**
 * Return this account to the database copy.
 *
 * Nothing is deleted and no record is removed: the space keeps the last verified snapshot, and
 * the rows are already current because the transition writes both.
 */
export async function rollbackReaderState(userId: number): Promise<{ ok: true }> {
	await db.update(users).set({ readerStateHome: "db" }).where(eq(users.id, userId));
	return { ok: true };
}

// ── The forward path: queue a change when the space is canonical ───────────────
//
// These run after the request has written the row. The flag decides whether the space is also
// written; an account on `db` queues nothing, which is what makes the rollback take effect for
// the next request rather than only for the backfill.

/** Queue one Library entry by its row id, if this account is on the space copy. */
export async function queueLibraryEntry(userId: number, itemId: number): Promise<void> {
	if ((await readerStateHome(userId)) !== "space") return;
	const [row] = await db
		.select()
		.from(libraryItems)
		.where(and(eq(libraryItems.id, itemId), eq(libraryItems.userId, userId)))
		.limit(1);
	if (!row) return;
	const subject = librarySubject(row);
	if (!subject) return;
	const uris = subject.kind === "work" ? await workUris([subject.id]) : new Map<number, string>();
	await enqueueLibraryItem(userId, {
		subject: { ...subject, uri: uris.get(subject.id) ?? null },
		hidden: row.hidden,
		sortOrder: row.sortOrder,
		savedAt: row.savedAt,
	});
}

/** Queue the removal of a Library entry the caller is about to delete. */
export async function queueLibraryRemoval(
	userId: number,
	subject: { kind: "work" | "project" | "post"; id: number },
): Promise<void> {
	if ((await readerStateHome(userId)) !== "space") return;
	await enqueueLibraryItem(userId, { subject: { ...subject, uri: null }, removed: true });
}

/** Queue one reading position. */
export async function queuePosition(userId: number, workId: number): Promise<void> {
	if ((await readerStateHome(userId)) !== "space") return;
	const space = await registeredSpace(userId);
	const [row] = await db
		.select()
		.from(readingPositions)
		.where(and(eq(readingPositions.userId, userId), eq(readingPositions.workId, workId)))
		.limit(1);
	if (!space || !row) return;
	const uris = await workUris([workId]);
	await queueSpaceWrite({
		userId,
		did: space.did,
		spaceUri: space.spaceUri,
		collection: USER_SPACE_COLLECTIONS.readingPosition,
		rkey: readingPositionRkey(workId),
		op: "put",
		record: readingPositionRecord({
			workId,
			workUri: uris.get(workId) ?? null,
			progress: row.progress,
			position: row.position,
			updatedAt: row.updatedAt,
		}),
	});
}

/** Queue one cloud save, inline as the record carries it. */
export async function queueWorkSave(userId: number, workId: number): Promise<void> {
	if ((await readerStateHome(userId)) !== "space") return;
	const space = await registeredSpace(userId);
	const [row] = await db
		.select()
		.from(workSaves)
		.where(and(eq(workSaves.userId, userId), eq(workSaves.workId, workId)))
		.limit(1);
	if (!space || !row) return;
	const uris = await workUris([workId]);
	await queueSpaceWrite({
		userId,
		did: space.did,
		spaceUri: space.spaceUri,
		collection: USER_SPACE_COLLECTIONS.workSave,
		rkey: workSaveRkey(workId),
		op: "put",
		record: workSaveRecord({
			workId,
			workUri: uris.get(workId) ?? null,
			save: row.blob,
			runtime: row.runtime,
			note: row.note,
			byteSize: row.byteSize,
			updatedAt: row.updatedAt,
		}),
	});
}

/** Queue the removal of a cloud save. */
export async function queueWorkSaveRemoval(userId: number, workId: number): Promise<void> {
	if ((await readerStateHome(userId)) !== "space") return;
	const space = await registeredSpace(userId);
	if (!space) return;
	await queueSpaceWrite({
		userId,
		did: space.did,
		spaceUri: space.spaceUri,
		collection: USER_SPACE_COLLECTIONS.workSave,
		rkey: workSaveRkey(workId),
		op: "delete",
		record: null,
	});
}

/** The subject a `library_items` row names, or null when the row names none. */
function librarySubject(row: typeof libraryItems.$inferSelect): {
	kind: "work" | "project" | "post";
	id: number;
} | null {
	if (row.workId != null) return { kind: "work", id: row.workId };
	if (row.projectId != null) return { kind: "project", id: row.projectId };
	if (row.postId != null) return { kind: "post", id: row.postId };
	return null;
}

/** The public record addresses of the Works in play, for the record's optional `uri`. */
async function workUris(ids: number[]): Promise<Map<number, string>> {
	if (ids.length === 0) return new Map();
	const rows = await db
		.select({ id: works.id, atprotoUri: works.atprotoUri })
		.from(works)
		.where(inArray(works.id, [...new Set(ids)]));
	const pairs: Array<[number, string]> = [];
	for (const row of rows) {
		if (row.atprotoUri) pairs.push([row.id, row.atprotoUri]);
	}
	return new Map(pairs);
}
