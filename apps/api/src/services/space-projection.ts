// SPDX-License-Identifier: Apache-2.0
/**
 * The Library projection: `library_items` rebuilt from the reader's space.
 *
 * 🚨 **The space is the record and this table is the read model.** That is why a rebuild can
 * delete a local row: if the shelf does not contain the entry, the reader's own space — the
 * one place the keep actually lives — does not either. The table still exists because every
 * list, count and access check on Anthers reads a local row in one query, and a page that
 * listed a space to draw a shelf would put a PDS in the path of every render.
 *
 * ⚠️ **A subject that has been deleted locally is skipped, not resurrected.** A Work removed
 * from Anthers leaves a record in the space pointing at an id nothing answers to; inserting
 * that row would fail on the foreign key, and inventing a placeholder would be worse. The
 * report names it so a sweep can retract the record once the deletion flow owns that job.
 */
import { db } from "@anthers/db";
import { libraryItems, posts, projects, works } from "@anthers/db/schema";
import { and, eq } from "drizzle-orm";
import {
	type LibraryItemState,
	type LibrarySubject,
	parseLibraryItemRecord,
	USER_SPACE_COLLECTIONS,
} from "./space-records.js";
import { registeredSpace } from "./space-registry.js";
import { hostedSpaceSession, type ResolveSpaceSession, spaceWriterFor } from "./space-writer.js";

/** What a rebuild changed, and everything it could not project. */
export interface ProjectionReport {
	spaceUri: string;
	scanned: number;
	inserted: number;
	updated: number;
	unchanged: number;
	removed: number;
	skipped: Array<{ rkey: string; reason: string }>;
}

export interface ProjectionOptions {
	resolveSession?: ResolveSpaceSession;
	fetchImpl?: typeof fetch;
}

/** The column a subject's id lives in. A map, so a fourth kind is a compile error. */
const SUBJECT_COLUMNS = {
	work: libraryItems.workId,
	project: libraryItems.projectId,
	post: libraryItems.postId,
} as const;

/** The table a subject lives in, for the existence check and the rebuild's skip report. */
const SUBJECT_TABLES = { work: works, project: projects, post: posts } as const;

/**
 * Apply one shelf entry from the space.
 *
 * Returns what happened rather than throwing on a missing subject: the worker projecting one
 * verified record should not fail its whole drain because the Work it points at was deleted
 * between the write and the projection.
 */
export async function projectLibraryItem(
	userId: number,
	item: LibraryItemState,
): Promise<"inserted" | "updated" | "unchanged" | { problem: string }> {
	const column = SUBJECT_COLUMNS[item.subject.kind];
	if (!(await subjectExists(item.subject))) {
		return { problem: `${item.subject.kind} ${item.subject.id} no longer exists` };
	}

	const [existing] = await db
		.select({ id: libraryItems.id, hidden: libraryItems.hidden, sortOrder: libraryItems.sortOrder })
		.from(libraryItems)
		.where(and(eq(libraryItems.userId, userId), eq(column, item.subject.id)))
		.limit(1);

	if (existing) {
		if (existing.hidden === item.hidden && existing.sortOrder === item.sortOrder) {
			return "unchanged";
		}
		await db
			.update(libraryItems)
			.set({ hidden: item.hidden, sortOrder: item.sortOrder })
			.where(eq(libraryItems.id, existing.id));
		return "updated";
	}

	await db.insert(libraryItems).values({
		userId,
		...subjectColumnValue(item.subject),
		hidden: item.hidden,
		sortOrder: item.sortOrder,
		savedAt: item.savedAt,
	});
	return "inserted";
}

/** Remove one projected shelf entry, by subject. Absent is a no-op. */
export async function removeProjectedLibraryItem(
	userId: number,
	subject: Pick<LibrarySubject, "kind" | "id">,
): Promise<void> {
	const column = SUBJECT_COLUMNS[subject.kind];
	await db.delete(libraryItems).where(and(eq(libraryItems.userId, userId), eq(column, subject.id)));
}

/**
 * Rebuild the whole Library from the space's `listRecords`.
 *
 * ⚠️ **A row the space does not carry is deleted, and that is the rebuild's meaning.** It is
 * safe because the space is the source: the row was either never projected or was retracted
 * in the space by the reader's own app, and keeping either would make the read model disagree
 * with the record it exists to mirror.
 */
export async function rebuildLibraryProjection(
	userId: number,
	opts: ProjectionOptions = {},
): Promise<ProjectionReport | { reason: string }> {
	const row = await registeredSpace(userId);
	if (!row) return { reason: "no_registry_row" };

	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });
	const resolved = await resolve(userId);
	if (!resolved.session) return { reason: resolved.reason };

	const writer = spaceWriterFor(resolved.session, row.spaceUri, { fetchImpl: opts.fetchImpl });
	const records = await writer.list(USER_SPACE_COLLECTIONS.libraryItem);

	const report: ProjectionReport = {
		spaceUri: row.spaceUri,
		scanned: records.length,
		inserted: 0,
		updated: 0,
		unchanged: 0,
		removed: 0,
		skipped: [],
	};

	const present = new Set<string>();
	const bySubject = new Map<string, LibraryItemState>();
	for (const record of records) {
		const rkey = record.rkey ?? rkeyOf(record.uri) ?? record.cid;
		const result = parseLibraryItemRecord(record.value);
		if ("problem" in result) {
			report.skipped.push({ rkey, reason: result.problem });
			continue;
		}
		// A stale duplicate of the same subject loses to the newest `savedAt`; the space holds
		// one record per subject by construction, and this is the guard for a hand-written one.
		const key = subjectKey(result.item.subject);
		const earlier = bySubject.get(key);
		if (earlier && earlier.savedAt > result.item.savedAt) continue;
		bySubject.set(key, result.item);
	}

	const parsed = [...bySubject.entries()].map(([key, item]) => ({ key, item }));
	for (const entry of parsed) present.add(entry.key);

	const existing = await db
		.select({
			id: libraryItems.id,
			workId: libraryItems.workId,
			projectId: libraryItems.projectId,
			postId: libraryItems.postId,
			hidden: libraryItems.hidden,
			sortOrder: libraryItems.sortOrder,
		})
		.from(libraryItems)
		.where(eq(libraryItems.userId, userId));

	await db.transaction(async (tx) => {
		for (const { key, item } of parsed) {
			if (!(await subjectExists(item.subject, tx))) {
				report.skipped.push({ rkey: key, reason: `${item.subject.kind} is gone locally` });
				continue;
			}
			const current = existing.find((entry) => subjectIdOf(entry) === key);
			if (!current) {
				await tx.insert(libraryItems).values({
					userId,
					...subjectColumnValue(item.subject),
					hidden: item.hidden,
					sortOrder: item.sortOrder,
					savedAt: item.savedAt,
				});
				report.inserted++;
				continue;
			}
			if (current.hidden === item.hidden && current.sortOrder === item.sortOrder) {
				report.unchanged++;
				continue;
			}
			await tx
				.update(libraryItems)
				.set({ hidden: item.hidden, sortOrder: item.sortOrder })
				.where(eq(libraryItems.id, current.id));
			report.updated++;
		}

		for (const entry of existing) {
			if (present.has(subjectIdOf(entry))) continue;
			await tx.delete(libraryItems).where(eq(libraryItems.id, entry.id));
			report.removed++;
		}
	});

	return report;
}

/** Whether the subject row still exists, so a record cannot violate the foreign key. */
async function subjectExists(
	subject: LibrarySubject,
	tx: Pick<typeof db, "select"> = db,
): Promise<boolean> {
	const table = SUBJECT_TABLES[subject.kind];
	const [row] = await tx
		.select({ id: table.id })
		.from(table)
		.where(eq(table.id, subject.id))
		.limit(1);
	return !!row;
}

function subjectColumnValue(subject: LibrarySubject): {
	workId?: number;
	projectId?: number;
	postId?: number;
} {
	switch (subject.kind) {
		case "work":
			return { workId: subject.id };
		case "project":
			return { projectId: subject.id };
		case "post":
			return { postId: subject.id };
	}
}

/** `work:12`, the stable identity of a shelf entry across a rebuild. */
function subjectIdOf(row: {
	workId: number | null;
	projectId: number | null;
	postId: number | null;
}): string {
	if (row.workId != null) return `work:${row.workId}`;
	if (row.projectId != null) return `project:${row.projectId}`;
	return `post:${row.postId}`;
}

function subjectKey(subject: LibrarySubject): string {
	return `${subject.kind}:${subject.id}`;
}

/**
 * The record key at the end of an address.
 *
 * A space record nests under its space: `at://spaceDid/space/type/skey/author/collection/rkey`.
 * The last segment is the key in both that form and an ordinary `at://did/collection/rkey`.
 */
function rkeyOf(uri: string | undefined): string | null {
	if (!uri) return null;
	const segment = uri.split("/").filter(Boolean).at(-1);
	return segment && segment !== uri ? segment : null;
}
