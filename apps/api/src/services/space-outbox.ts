// SPDX-License-Identifier: Apache-2.0
/**
 * The transactional outbox that carries a reader's state into their own space.
 *
 * 🚨 **The rule this module exists to keep: a row clears only after a verified read-back.**
 * `putRecord` answering 200 says the server accepted the call. It does not say the record is
 * at the address and CID the caller was handed, that the repo's commit moved, or that the
 * oplog carries the operation. All four are checked here, and any disagreement leaves the row
 * and its payload in place for the next drain. A failure that retried forever would be bad; a
 * failure that quietly cleared would be the reader's shelf silently not existing.
 *
 * ⭐ **Every row is absolute state rather than an increment**, which is what makes the retry
 * safe: the record carries the whole entry (its hidden flag, its order), so writing it again
 * converges instead of stacking. A delete supersedes a queued put at the same key because the
 * pending row is replaced rather than queued behind.
 *
 * ⚠️ **One row per write, claimed with `SKIP LOCKED`.** Two workers can drain at once without
 * either taking the other's row, and an in-flight row's payload is never rewritten underneath
 * it: the partial unique index covers only pending rows, so a newer write to the same key
 * queues beside it. That newer row wins the next drain, which is the correct order.
 */

import { isDeepStrictEqual } from "node:util";
import { db } from "@anthers/db";
import { type SpaceOutboxOp, type SpaceOutboxStatus, spaceOutbox } from "@anthers/db/schema";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { SpaceRequestError } from "./atproto-space.js";
import { projectLibraryItem, removeProjectedLibraryItem } from "./space-projection.js";
import {
	type LibraryItemState,
	libraryItemRecord,
	libraryItemRkey,
	parseLibraryItemRecord,
	USER_SPACE_COLLECTIONS,
} from "./space-records.js";
import { ensureUserSpace, type RegistryOptions, registeredSpace } from "./space-registry.js";
import {
	hostedSpaceSession,
	type ResolveSpaceSession,
	type SpaceSession,
	type SpaceWriteRef,
	type SpaceWriter,
	spaceWriterFor,
} from "./space-writer.js";

/** The payload a queued write carries. */
export interface SpaceWriteIntent {
	userId: number;
	did: string;
	spaceUri: string;
	collection: string;
	rkey: string;
	op: SpaceOutboxOp;
	/** The complete record for a `put`; null for a `delete`. */
	record?: Record<string, unknown> | null;
}

type Tx = Pick<typeof db, "insert" | "update" | "select">;

/**
 * Queue a write, in the caller's transaction when there is one.
 *
 * 🚨 **The caller passes its transaction so the intent and the row it describes commit
 * together.** A queue written after the request's commit would be lost by a crash in between;
 * a queue written before it, in the same transaction, is exactly the durability the outbox
 * is for.
 *
 * ⚠️ **An existing pending row is replaced, not duplicated.** Last write wins is the right
 * rule for absolute state, and it is also what keeps an idle account's backlog at one row per
 * subject.
 */
export async function queueSpaceWrite(intent: SpaceWriteIntent, tx: Tx = db): Promise<number> {
	const now = new Date();
	const values = {
		userId: intent.userId,
		did: intent.did,
		spaceUri: intent.spaceUri,
		collection: intent.collection,
		rkey: intent.rkey,
		op: intent.op,
		record: intent.record ?? null,
		status: "pending" as SpaceOutboxStatus,
		availableAt: now,
		lastError: null,
		updatedAt: now,
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		const [inserted] = await tx
			.insert(spaceOutbox)
			.values(values)
			.onConflictDoNothing()
			.returning({ id: spaceOutbox.id });
		if (inserted) return inserted.id;

		// A pending row already exists: replace its payload. If it went in flight between the
		// insert and here, the update finds nothing and the next attempt inserts beside it.
		const [updated] = await tx
			.update(spaceOutbox)
			.set(values)
			.where(
				and(
					eq(spaceOutbox.userId, intent.userId),
					eq(spaceOutbox.collection, intent.collection),
					eq(spaceOutbox.rkey, intent.rkey),
					eq(spaceOutbox.status, "pending"),
				),
			)
			.returning({ id: spaceOutbox.id });
		if (updated) return updated.id;
	}

	throw new Error(`could not queue ${intent.collection}/${intent.rkey} for user ${intent.userId}`);
}

export type EnqueueResult =
	| { queued: true; id: number; spaceUri: string }
	| { queued: false; reason: "no_registry_row" };

/**
 * Queue a shelf entry's write, which is what a Save, a hide or an unsave becomes.
 *
 * ⚠️ **This does not create the space.** Creation needs a PDS call and belongs to the worker;
 * an account with no registered space answers `no_registry_row` and the caller decides
 * whether that is a reason to ask for one (`ensureUserSpace`) or to keep the database hot.
 */
export async function enqueueLibraryItem(
	userId: number,
	state: LibraryItemState | { subject: LibraryItemState["subject"]; removed: true },
	tx: Tx = db,
): Promise<EnqueueResult> {
	const space = await registeredSpace(userId);
	if (!space) return { queued: false, reason: "no_registry_row" };

	const rkey = libraryItemRkey(state.subject);
	const id = await queueSpaceWrite(
		{
			userId,
			did: space.did,
			spaceUri: space.spaceUri,
			collection: USER_SPACE_COLLECTIONS.libraryItem,
			rkey,
			op: "removed" in state ? "delete" : "put",
			record: "removed" in state ? null : libraryItemRecord(state),
		},
		tx,
	);
	return { queued: true, id, spaceUri: space.spaceUri };
}

/** Why a row could not be written. The kind is what tells an operator where to look. */
export type OutboxFailureKind = "session" | "space" | "request" | "verification" | "projection";

export interface OutboxFailure {
	rowId: number;
	userId: number;
	collection: string;
	rkey: string;
	attempts: number;
	kind: OutboxFailureKind;
	error: string;
	/** The account has nowhere left to retry: the row is `failed` rather than pending. */
	terminal: boolean;
}

export interface DrainOptions extends RegistryOptions {
	limit?: number;
	now?: Date;
	/** Injected by tests and by the worker's own alerting; the default logs. */
	alert?: (failure: OutboxFailure) => void | Promise<void>;
	/** How many attempts before a row is parked as failed rather than retried. */
	maxAttempts?: number;
	/** The session resolver, defaulting to the hosted route. */
	resolveSession?: ResolveSpaceSession;
}

export interface DrainReport {
	claimed: number;
	cleared: number;
	failed: number;
	failures: OutboxFailure[];
}

/**
 * Take the due rows and carry them out.
 *
 * Deliberately sequential: the row is a small write and the PDS's limits are per account,
 * so a drain that fanned out would spend the login budget to gain seconds.
 */
export async function drainSpaceOutbox(opts: DrainOptions = {}): Promise<DrainReport> {
	const now = opts.now ?? new Date();
	const limit = opts.limit ?? 20;
	const maxAttempts = opts.maxAttempts ?? 10;
	const alert = opts.alert ?? defaultAlert;
	const resolve = opts.resolveSession ?? hostedSpaceSession({ fetchImpl: opts.fetchImpl });

	const claimed = await claimRows(limit, now);
	const report: DrainReport = { claimed: claimed.length, cleared: 0, failed: 0, failures: [] };

	for (const row of claimed) {
		try {
			await carryOut(row, { ...opts, now, resolveSession: resolve });
			await db
				.delete(spaceOutbox)
				.where(and(eq(spaceOutbox.id, row.id), eq(spaceOutbox.status, "inflight")));
			report.cleared++;
		} catch (error) {
			const failure = await park(row, error, { now, maxAttempts });
			report.failures.push(failure);
			if (failure.terminal) report.failed++;
			await alert(failure);
		}
	}

	return report;
}

/** Claim up to `limit` due rows and mark them in flight, in one statement. */
async function claimRows(limit: number, now: Date) {
	return db.transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(spaceOutbox)
			.where(and(eq(spaceOutbox.status, "pending"), lte(spaceOutbox.availableAt, now)))
			.orderBy(asc(spaceOutbox.availableAt), asc(spaceOutbox.id))
			.limit(limit)
			.for("update", { skipLocked: true });
		if (rows.length === 0) return rows;
		await tx
			.update(spaceOutbox)
			.set({ status: "inflight", claimedAt: now, updatedAt: now })
			.where(
				inArray(
					spaceOutbox.id,
					rows.map((row) => row.id),
				),
			);
		return rows;
	});
}

/**
 * Write one row and verify it.
 *
 * Throws on anything that is not a verified outcome, which is what makes the caller's single
 * catch the one place a row is parked. The failure kind is attached at the point it is known
 * rather than guessed later.
 */
async function carryOut(
	row: typeof spaceOutbox.$inferSelect,
	opts: DrainOptions & { now: Date; resolveSession: ResolveSpaceSession },
): Promise<void> {
	const resolved = await opts.resolveSession(row.userId);
	if (!resolved.session) throw new OutboxError("session", resolved.reason);
	const session: SpaceSession = resolved.session;

	// The registry is the address of record. A row queued against an address the registry no
	// longer agrees with is written to the registry's, because a repaired or moved row is the
	// newer fact and the queued copy is only what the producer knew.
	const registered = await ensureUserSpace(row.userId, {
		fetchImpl: opts.fetchImpl,
		now: opts.now,
		resolveSession: async () => ({ session }),
	});
	if (!registered.space) throw new OutboxError("space", registered.reason);
	const spaceUri = registered.space.spaceUri;

	const writer = spaceWriterFor(session, spaceUri, { fetchImpl: opts.fetchImpl });
	// ⭐ **A space has no repo until its first write**, so the "before" commit is allowed to be
	// absent. The branch answers `RepoNotFound` for a space nothing has been written into yet,
	// and treating that as a failure would make the very first shelf entry undeliverable. Any
	// other failure is real and stops the row here.
	const previous = await writer.commit().catch((error) => {
		if (error instanceof SpaceRequestError && error.error === "RepoNotFound") return null;
		throw error;
	});

	const written: SpaceWriteRef | null =
		row.op === "delete" ? null : await writer.put(row.collection, row.rkey, row.record ?? {});
	if (row.op === "delete") await writer.remove(row.collection, row.rkey);

	await verifyWrite(writer, row, written, previous?.rev ?? null);

	if (row.collection === USER_SPACE_COLLECTIONS.libraryItem && row.op === "put") {
		const parsed = parseLibraryItemRecord(row.record);
		if ("problem" in parsed) throw new OutboxError("projection", parsed.problem);
		const projected = await projectLibraryItem(row.userId, parsed.item);
		if (typeof projected === "object") throw new OutboxError("projection", projected.problem);
	}
	if (row.collection === USER_SPACE_COLLECTIONS.libraryItem && row.op === "delete") {
		// The space no longer has the entry, so the read model drops it too. A subject deleted
		// locally has already taken its row by cascade, and removing an absent row is a no-op.
		const subject = subjectFromRkey(row.rkey);
		if (subject) await removeProjectedLibraryItem(row.userId, subject);
	}
}

/**
 * The four checks that make a write verified: address, CID, value, and a commit and oplog
 * that agree about it.
 */
async function verifyWrite(
	writer: SpaceWriter,
	row: typeof spaceOutbox.$inferSelect,
	written: SpaceWriteRef | null,
	previousRev: string | null,
): Promise<void> {
	if (row.op === "delete") {
		const read = await writer.get(row.collection, row.rkey);
		if (read !== null) {
			throw new OutboxError("verification", "the record is still there after a delete");
		}
	} else {
		const read = await writer.get(row.collection, row.rkey);
		if (!read) throw new OutboxError("verification", "the record is not there after the write");
		if (!written) throw new OutboxError("verification", "the write returned no address");
		if (read.uri !== written.uri) {
			throw new OutboxError("verification", `read-back uri ${read.uri} is not ${written.uri}`);
		}
		if (read.cid !== written.cid) {
			throw new OutboxError("verification", `read-back cid ${read.cid} is not ${written.cid}`);
		}
		if (!isDeepStrictEqual(read.value, row.record)) {
			throw new OutboxError("verification", "read-back value is not the record that was sent");
		}
	}

	const commit = await writer.commit();
	if (previousRev !== null && commit.rev <= previousRev) {
		throw new OutboxError("verification", `commit did not advance past ${previousRev}`);
	}

	const oplog = await writer.ops(previousRev ? { since: previousRev } : {});
	const op = oplog.ops.find(
		(entry) => entry.collection === row.collection && entry.rkey === row.rkey,
	);
	if (!op) throw new OutboxError("verification", "the oplog has no operation for the record");
	const expectedCid = row.op === "delete" ? null : (written as { cid: string }).cid;
	if ((op.cid ?? null) !== expectedCid) {
		throw new OutboxError(
			"verification",
			`oplog cid ${op.cid ?? "null"} is not ${expectedCid ?? "null"}`,
		);
	}
}

/** A failure with the kind already known. */
class OutboxError extends Error {
	constructor(
		readonly kind: OutboxFailureKind,
		message: string,
	) {
		super(message);
		this.name = "OutboxError";
	}
}

/**
 * Put a failed row back with backoff, or park it.
 *
 * ⚠️ **`failed` is not deletion.** A parked row keeps its payload and its last error, and the
 * sweep or an operator can requeue it with `status = 'pending'`. What it stops doing is
 * retrying forever against a reason nobody is going to look at.
 */
async function park(
	row: typeof spaceOutbox.$inferSelect,
	error: unknown,
	opts: { now: Date; maxAttempts: number },
): Promise<OutboxFailure> {
	const kind = error instanceof OutboxError ? error.kind : kindOfRequest(error);
	const message = error instanceof Error ? error.message : String(error);
	const attempts = row.attempts + 1;
	const terminal = attempts >= opts.maxAttempts;
	const delayMs = Math.min(5_000 * 2 ** row.attempts, 5 * 60_000);
	const availableAt = new Date(opts.now.getTime() + delayMs);

	await db
		.update(spaceOutbox)
		.set({
			status: terminal ? "failed" : "pending",
			attempts,
			availableAt,
			lastError: message,
			updatedAt: opts.now,
		})
		.where(eq(spaceOutbox.id, row.id));

	return {
		rowId: row.id,
		userId: row.userId,
		collection: row.collection,
		rkey: row.rkey,
		attempts,
		kind,
		error: message,
		terminal,
	};
}

/** A request failure the node named is the node's; an unnamed one is the transport's. */
function kindOfRequest(error: unknown): OutboxFailureKind {
	return error instanceof SpaceRequestError ? "request" : "request";
}

/** The default alert: a line an operator can find, with nothing sensitive in it. */
function defaultAlert(failure: OutboxFailure): void {
	console.error(
		`[space-outbox] ${failure.terminal ? "PARKED" : "retrying"} ` +
			`${failure.collection}/${failure.rkey} for user ${failure.userId} ` +
			`(${failure.kind}, attempt ${failure.attempts}): ${failure.error}`,
	);
}

/**
 * How much is waiting, for the readiness gate's backlog alert.
 *
 * A `failed` count above zero is the number that matters: it means rows have stopped moving
 * and a person has not seen the line yet.
 */
export async function outboxBacklog(now: Date = new Date()): Promise<{
	pending: number;
	inflight: number;
	failed: number;
	overdue: number;
}> {
	const [row] = await db
		.select({
			pending: sql<number>`count(*) filter (where ${spaceOutbox.status} = 'pending')`,
			inflight: sql<number>`count(*) filter (where ${spaceOutbox.status} = 'inflight')`,
			failed: sql<number>`count(*) filter (where ${spaceOutbox.status} = 'failed')`,
			overdue: sql<number>`count(*) filter (where ${spaceOutbox.status} = 'pending' and ${spaceOutbox.availableAt} < ${now.toISOString()}::timestamptz)`,
		})
		.from(spaceOutbox);
	return {
		pending: Number(row?.pending ?? 0),
		inflight: Number(row?.inflight ?? 0),
		failed: Number(row?.failed ?? 0),
		overdue: Number(row?.overdue ?? 0),
	};
}

/**
 * The subject a record key names.
 *
 * The key is written as `<kind>-<id>` by `libraryItemRkey`, so the unsave path can find the
 * projected row without a second record read. A key that does not parse is a bug in the
 * producer rather than a reason to fail the canonical write, so the projection delete is
 * skipped and the next rebuild retracts it.
 */
function subjectFromRkey(rkey: string): { kind: "work" | "project" | "post"; id: number } | null {
	const [kind, rawId] = rkey.split("-");
	if (kind !== "work" && kind !== "project" && kind !== "post") return null;
	const id = Number(rawId);
	if (!Number.isInteger(id) || id <= 0) return null;
	return { kind, id };
}
