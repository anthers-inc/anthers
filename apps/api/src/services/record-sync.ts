// SPDX-License-Identifier: Apache-2.0
/**
 * Bringing one row's record into line with the row, for every kind of record Anthers writes on
 * somebody's behalf apart from a Work's listing.
 *
 * `atproto-record-plan.ts` decides and carries out; `creator-record-listing.ts` and
 * `reader-record-listing.ts` read the rows. This is the part the six kinds share — plan, open a
 * repository only if the plan writes, carry it out, remember the address — so that the order of
 * those steps and what a failure means are decided once.
 *
 * 🚨 **The row is re-read by the caller rather than being told what changed.** Publishability
 * turns on state several services write, and a version taking "what happened" as an argument
 * would need every one of those call sites to describe its transition correctly and for ever.
 * **The enqueue is a hint that something moved, never a description of what**, which is what
 * makes a duplicate harmless and a late job still correct.
 *
 * ⚠️ **A Work's listing is deliberately not here.** Its row is canonical and its planner predates
 * this one; see `work-listing.ts`.
 */
import {
	carryOutPlan,
	planNeedsWriter,
	planRecord,
	type RecordKind,
	type RecordPlan,
} from "./atproto-record-plan.js";
import { RepoAuthError } from "./atproto-repo.js";
import {
	type AccountWriterResult,
	type NoAccountWriterReason,
	writerForAccount,
} from "./repo-writer.js";

/** Every kind of record the sync queue carries. */
export type RecordSyncKind = "post" | "project" | "comment" | "review" | "vote" | "follow";

export const RECORD_SYNC_KINDS: readonly RecordSyncKind[] = [
	"post",
	"project",
	"comment",
	"review",
	"vote",
	"follow",
];

/** What syncing one row's record did. */
export type RecordSyncResult<R, Reason extends string> =
	/** The plan was carried out — including the plans that write nothing. */
	| { status: "synced"; plan: RecordPlan<R, Reason>; uri: string | null }
	/** A write was needed and could not be attempted, for a reason retrying will not change. */
	| { status: "skipped"; reason: NoAccountWriterReason | "no_row" | "no_owner" }
	/** Something worth retrying went wrong. The job wrapper decides what to do about it. */
	| { status: "failed"; error: string };

/**
 * Plan one row's record, and write only if the plan says to.
 *
 * ⭐ **The writer is opened AFTER planning, and only for a plan that writes.** Opening a hosted
 * writer is a `createSession` against the account's server, which the reference PDS limits to
 * thirty in five minutes and three hundred a day per account — so a draft, a kept record, or a
 * collection whose schema is not yet published must cost none of them.
 *
 * ⚠️ **`storeUri` is called only when the address changed**, and a kept or invalid plan hands
 * back the address it was given, so a record Anthers has stopped rewriting is never forgotten.
 *
 * `openWriter` is injectable so a suite can prove the ordering without a server.
 */
export async function syncOwnedRecord<Input, R extends object, Reason extends string>(args: {
	/** Whose repository the record belongs in. Null on a tombstoned row. */
	ownerId: number | null;
	kind: RecordKind<Input, R, Reason>;
	input: Input;
	existingUri: string | null;
	storeUri(uri: string | null): Promise<void>;
	fetchImpl?: typeof fetch;
	openWriter?: (
		userId: number,
		opts: { collections: readonly string[]; fetchImpl?: typeof fetch },
	) => Promise<AccountWriterResult>;
}): Promise<RecordSyncResult<R, Reason>> {
	const plan = planRecord(args.kind, args.input, args.existingUri);
	if (!planNeedsWriter(plan))
		return { status: "synced", plan, uri: uriAfter(plan, args.existingUri) };

	// Unreachable while every kind refuses a row with no owner and keeps rather than deletes its
	// record, and checked so that staying true is enforced rather than assumed.
	if (args.ownerId === null) return { status: "skipped", reason: "no_owner" };

	const open = args.openWriter ?? writerForAccount;
	const opened = await open(args.ownerId, {
		collections: [args.kind.collection],
		fetchImpl: args.fetchImpl,
	});
	if (!opened.writer) return { status: "skipped", reason: opened.reason };

	try {
		const outcome = await carryOutPlan(opened.writer, args.kind.collection, plan, args.existingUri);
		if (outcome.uri !== args.existingUri) await args.storeUri(outcome.uri);
		return { status: "synced", plan: outcome.plan, uri: outcome.uri };
	} catch (error) {
		// 🚨 **A refused credential is a skip, never a failure, because a failure is retried.**
		// Trying again cannot succeed until the owner grants permission again, and a retry loop
		// against a revoked grant achieves nothing except hiding the revocation from the person
		// who could fix it. The stored address is left alone: a record already out there is still
		// one Anthers must be able to find after a re-grant.
		//
		// ⚠️ The grant column is deliberately NOT cleared, unlike `syncWorkListing`. A grant is per
		// collection, so a refusal here says nothing about the owner's other collections, and the
		// next writer to open reads the token itself.
		if (error instanceof RepoAuthError) {
			console.warn(`[record-sync] the grant for ${error.did} was refused — ${error.message}`);
			return { status: "skipped", reason: "grant_lost" };
		}
		// The stored address stays as it was. If a write failed we do not know what landed, and
		// forgetting where a record might be is how a retry creates a duplicate.
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/** The address a plan that wrote nothing leaves the row holding. */
function uriAfter(plan: RecordPlan<unknown, string>, existingUri: string | null): string | null {
	return plan.action === "none" ? null : existingUri;
}

/**
 * Ask for one row's record to be brought back into line, soon.
 *
 * ⭐ **Call this whenever publishability MIGHT have moved, without working out whether it did.**
 * The job re-reads and decides, so a spurious enqueue costs one database read and no network at
 * all. Under-calling is the expensive mistake here, not over-calling.
 *
 * ⚠️ **Never throws.** Every caller is in the middle of something a person asked for, and a
 * comment must not fail to post because a queue was briefly unavailable. A missed enqueue is
 * caught by the reconciling sweep.
 */
export async function queueRecordSync(kind: RecordSyncKind, id: number): Promise<void> {
	try {
		const { queue, QUEUES, JOB_OPTIONS } = await import("../jobs/queue.js");
		await queue.send(
			QUEUES.SYNC_ATPROTO_RECORD,
			{ kind, id },
			JOB_OPTIONS[QUEUES.SYNC_ATPROTO_RECORD],
		);
	} catch (error) {
		console.error(
			`[record-sync] could not enqueue a sync for ${kind} ${id}: ` +
				`${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
