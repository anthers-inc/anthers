// SPDX-License-Identifier: Apache-2.0
/**
 * What a user-space record says, and what a read of one must contain before it is believed.
 *
 * ⚠️ **These are draft record shapes, not a published Lexicon.** The collection names are
 * settled (Parker, 2026-10-23: `org.anthers.libraryItem` in `org.anthers.userSpace`) and the
 * field names are not, because nothing may publish an `org.anthers.*` Lexicon without review.
 * So this module is the one place the shape exists: the writer builds a record through it, the
 * projection reads one back through it, and a future Lexicon replaces the parser rather than
 * being discovered to disagree with three call sites.
 *
 * 🚨 **The local id travels beside the canonical address, and both are deliberate.** A record
 * is the reader's pointer to a Work, and the address is what makes the pointer portable — but
 * a Work that was never published has no address, and a saved Work whose listing was
 * withdrawn still has to project. The id is Anthers' own handle on the subject; the address,
 * when present, is preferred on the way back in and is what another client would follow.
 */

/** The collections the user space declares. Only the Library's is written by this build. */
export const USER_SPACE_COLLECTIONS = {
	libraryItem: "org.anthers.libraryItem",
	readingPosition: "org.anthers.readingPosition",
	workSave: "org.anthers.workSave",
	receipt: "org.anthers.receipt",
} as const;

/** What a shelf entry points at. The one-of rule is enforced by the table's shape. */
export type LibrarySubjectKind = "work" | "project" | "post";

export interface LibrarySubject {
	kind: LibrarySubjectKind;
	/** Anthers' id for the subject, as `library_items` holds it. */
	id: number;
	/** The subject's canonical record address, when it has one. */
	uri: string | null;
}

/**
 * One `org.anthers.libraryItem` record.
 *
 * The `Record<string, unknown>` half is what makes it a JSON object at the boundary: the
 * space client and the outbox take plain records, and a closed interface would not be one.
 */
export type LibraryItemRecord = {
	$type: typeof USER_SPACE_COLLECTIONS.libraryItem;
	subject: {
		kind: LibrarySubjectKind;
		id: number;
		uri?: string;
	};
	hidden: boolean;
	sortOrder: number;
	/** When the reader kept it, as an ISO datetime. */
	savedAt: string;
} & Record<string, unknown>;

/** The fields the record is built from — `library_items`' own columns, minus the row id. */
export interface LibraryItemState {
	subject: LibrarySubject;
	hidden: boolean;
	sortOrder: number;
	savedAt: Date;
}

/**
 * The record key for a shelf entry, derived from the subject so a re-save lands on the same
 * record rather than creating a second one.
 *
 * ⚠️ **The row id is deliberately not the key.** `library_items.id` changes if the shelf is
 * ever rebuilt from the space, which would make every rebuilt entry a new record; the subject
 * is the stable identity, and a reader keeps one entry per subject.
 */
export function libraryItemRkey(subject: Pick<LibrarySubject, "kind" | "id">): string {
	return `${subject.kind}-${subject.id}`;
}

/** Build the record for a shelf entry. */
export function libraryItemRecord(state: LibraryItemState): LibraryItemRecord {
	return {
		$type: USER_SPACE_COLLECTIONS.libraryItem,
		subject: {
			kind: state.subject.kind,
			id: state.subject.id,
			...(state.subject.uri ? { uri: state.subject.uri } : {}),
		},
		hidden: state.hidden,
		sortOrder: state.sortOrder,
		savedAt: state.savedAt.toISOString(),
	};
}

/** What a read-back produced, or why it could not be read as a shelf entry. */
export type ParsedLibraryItem = { item: LibraryItemState } | { problem: string };
const SUBJECT_KINDS = new Set<LibrarySubjectKind>(["work", "project", "post"]);

/**
 * Read a record back into the state the projection needs.
 *
 * 🚨 **Malformed is a result, not an exception.** A record in the space may have been written
 * by a newer build or by the reader's own app, and a projection that threw on the first one
 * would stop rebuilding the whole shelf. What it may never do is guess: an unknown subject
 * kind, a non-integer id or a missing `savedAt` is refused by name so the report says which
 * record to look at.
 */
export function parseLibraryItemRecord(value: unknown): ParsedLibraryItem {
	if (!value || typeof value !== "object") return { problem: "record is not an object" };
	const record = value as Record<string, unknown>;

	const subject = record.subject;
	if (!subject || typeof subject !== "object") return { problem: "subject is missing" };
	const { kind, id, uri } = subject as Record<string, unknown>;
	if (typeof kind !== "string" || !SUBJECT_KINDS.has(kind as LibrarySubjectKind)) {
		return { problem: `unknown subject kind ${String(kind)}` };
	}
	if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
		return { problem: `subject id is not a positive integer` };
	}
	if (uri != null && typeof uri !== "string") return { problem: "subject uri is not a string" };

	if (typeof record.hidden !== "boolean") return { problem: "hidden is not a boolean" };
	if (typeof record.sortOrder !== "number" || !Number.isFinite(record.sortOrder)) {
		return { problem: "sortOrder is not a number" };
	}
	if (typeof record.savedAt !== "string") return { problem: "savedAt is missing" };
	const savedAt = new Date(record.savedAt);
	if (Number.isNaN(savedAt.getTime())) return { problem: "savedAt is not a datetime" };

	return {
		item: {
			subject: { kind: kind as LibrarySubjectKind, id, uri: uri ?? null },
			hidden: record.hidden,
			sortOrder: record.sortOrder,
			savedAt,
		},
	};
}

/**
 * The reading-position record: where a reader stopped in one Work.
 *
 * 🚨 **No floating point crosses into the record.** `reading_positions.progress` is a SQL
 * `real`, and the protocol's data model has integers and strings, not floats. The position is
 * stored as basis points in `progressBps`, an integer from 0 to 10,000, which is the same
 * quarter-percent precision the rail draws and compares without a binary-float surprise on
 * another client. The reverse reads `progressBps / 10_000`.
 *
 * The pointer stays opaque: page/panel, a CFI, or nothing at all, and only the client's readers
 * assign its keys meaning.
 */
export type ReadingPositionRecord = {
	$type: typeof USER_SPACE_COLLECTIONS.readingPosition;
	subject: { kind: "work"; id: number; uri?: string };
	progressBps: number;
	position: Record<string, unknown>;
	updatedAt: string;
} & Record<string, unknown>;

export function readingPositionRkey(workId: number): string {
	return `work-${workId}`;
}

export function readingPositionRecord(state: {
	workId: number;
	workUri?: string | null;
	progress: number;
	position: Record<string, unknown>;
	updatedAt: Date;
}): ReadingPositionRecord {
	const clamped = Math.min(1, Math.max(0, state.progress));
	return {
		$type: USER_SPACE_COLLECTIONS.readingPosition,
		subject: {
			kind: "work",
			id: state.workId,
			...(state.workUri ? { uri: state.workUri } : {}),
		},
		progressBps: Math.round(clamped * 10_000),
		position: state.position,
		updatedAt: state.updatedAt.toISOString(),
	};
}

/**
 * The cloud-save record: the bytes a game wrote, inline rather than as a blob.
 *
 * ⚠️ **Inline is a decision, not an omission.** A save is capped small (`SAVE_BLOB_MAX_CHARS`
 * in the route), and a record carries it as a string; the space namespace has no upload, so a
 * blob route would mean the ordinary repository, a `blob:` permission and a ref the restore has
 * to keep in step. A reader's save is text under the cap, so the record is the whole artifact.
 * If a future save grows past a record, it becomes a blob and this shape changes with it.
 */
export type WorkSaveRecord = {
	$type: typeof USER_SPACE_COLLECTIONS.workSave;
	subject: { kind: "work"; id: number; uri?: string };
	save: string;
	runtime: string;
	note: string;
	byteSize: number;
	updatedAt: string;
} & Record<string, unknown>;

export function workSaveRkey(workId: number): string {
	return `work-${workId}`;
}

export function workSaveRecord(state: {
	workId: number;
	workUri?: string | null;
	save: string;
	runtime: string;
	note: string;
	byteSize: number;
	updatedAt: Date;
}): WorkSaveRecord {
	return {
		$type: USER_SPACE_COLLECTIONS.workSave,
		subject: {
			kind: "work",
			id: state.workId,
			...(state.workUri ? { uri: state.workUri } : {}),
		},
		save: state.save,
		runtime: state.runtime,
		note: state.note,
		byteSize: state.byteSize,
		updatedAt: state.updatedAt.toISOString(),
	};
}
