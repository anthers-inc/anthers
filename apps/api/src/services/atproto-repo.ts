// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Writing a Work's public listing into an AT Protocol repository.
 *
 * `atproto-records.ts` decides what a record *says* and writes nothing. This module is the
 * other half: it decides whether a record should be created, replaced or removed, and it is
 * the only place that writes an `org.anthers.work` record.
 *
 * 🚨 **A record is public the moment it is written, and deleting one does not unsay it.**
 * Creating a record broadcasts it to everybody listening; a later deletion broadcasts only
 * the identifier of the thing removed, so anyone who kept a copy keeps this one. That
 * asymmetry is why {@link planWorkRecord} is a pure function with its own tests rather than
 * a branch inside the call that talks to the network — the decision to publish has to be
 * checkable without a server, and it has to fail closed.
 *
 * ⚠️ **The writer is an interface rather than a client, and that seam is load-bearing.**
 * There are two implementations and they hold different credentials: `hosted-repo-writer.ts`
 * opens a session on an identity Anthers hosts, and `oauth-repo-writer.ts` carries a DPoP
 * OAuth grant a creator made over one held elsewhere. Same three calls either way, and
 * `repo-writer.ts` chooses. Keeping the seam here means the record logic never learns which
 * one it is talking to, and it is why this module imports no network client at all.
 */
import { workRecord } from "@anthers/shared/lexicons";
import {
	type PublishableWork,
	type UnpublishableReason,
	unpublishableReason,
	type WorkRecord,
	workToRecord,
} from "./atproto-records.js";

/** The collection every Work listing lives in. */
export const WORK_COLLECTION = "org.anthers.work";

/** What a repository hands back when it has written a record. */
export interface RecordRef {
	uri: string;
	cid: string;
}

/**
 * The three operations writing a listing needs, and nothing else.
 *
 * Deliberately not an `AtpAgent`: this is the whole surface the record logic is allowed to
 * reach, which is what lets an implementation over an OAuth session satisfy it without anything
 * here changing.
 */
export interface RepoWriter {
	/** The repository being written to, as a DID. */
	readonly did: string;
	createRecord(collection: string, record: object): Promise<RecordRef>;
	putRecord(collection: string, rkey: string, record: object): Promise<RecordRef>;
	deleteRecord(collection: string, rkey: string): Promise<void>;
}

/**
 * The repository refused the credentials rather than the record.
 *
 * 🚨 **Worth its own type because it is the one failure that must not be retried.** Every other
 * way a write can fail — the server is down, the record is malformed, the network blinked — is
 * answered by trying again, and this one is answered by asking the creator for permission
 * again. A retry loop against a revoked grant achieves nothing except hiding the revocation
 * from the person who could fix it.
 *
 * ⚠️ **Only a writer whose credentials somebody can take back should raise this.** The hosted
 * writer holds a password Anthers itself issued, so a refusal there means the hub is broken
 * rather than that permission was withdrawn, and it stays an ordinary error that retries.
 */
export class RepoAuthError extends Error {
	constructor(
		message: string,
		readonly did: string,
	) {
		super(message);
		this.name = "RepoAuthError";
	}
}

/**
 * What should happen to a Work's record, decided without touching the network.
 *
 * `invalid` is a refusal rather than an error: a Catalog sweep meeting one bad row should
 * report it and carry on, and neither of the two things that produce it may be resolved by
 * guessing. See {@link planWorkRecord}.
 */
export type WorkRecordPlan =
	| { action: "create"; record: WorkRecord }
	| { action: "replace"; rkey: string; record: WorkRecord }
	| { action: "delete"; rkey: string; reason: UnpublishableReason }
	| { action: "none"; reason: UnpublishableReason }
	| { action: "invalid"; problem: string };

/**
 * The `rkey` inside an `at://did/collection/rkey`, or null when the value is not one.
 *
 * The DID is deliberately not checked against the writer's: a Work's stored URI names the
 * repository the record actually went into, and if those two ever disagree the answer is to
 * look rather than to overwrite somebody else's repository.
 */
export function rkeyFromAtUri(uri: string, collection: string): string | null {
	const match = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri);
	if (!match) return null;
	const [, , foundCollection, rkey] = match;
	return foundCollection === collection ? rkey : null;
}

/**
 * Decide what to do with a Work's listing, given whatever record it already has.
 *
 * 🚨 **The delete branch is the one worth reading twice.** A Work that stops being publicly
 * listed — withdrawn, taken down, quarantined, or returned to private — must have its record
 * *removed*, not merely skipped. Skipping leaves a listing on the network advertising
 * something the creator has withdrawn, which is precisely what withdrawing was meant to
 * undo. That makes "unpublishable" two different outcomes depending on whether a record
 * exists, and conflating them is the bug this shape exists to prevent.
 *
 * ⚠️ **A record is validated against its own Lexicon here, before anything is sent.** The
 * generated validator is the same schema a consumer would check against, so this catches a
 * malformed record while it is still local — the one moment it is free to catch.
 */
export function planWorkRecord(
	work: PublishableWork,
	opts: { baseUrl: string; existingUri?: string | null },
): WorkRecordPlan {
	const existingUri = opts.existingUri ?? null;
	const rkey = existingUri ? rkeyFromAtUri(existingUri, WORK_COLLECTION) : null;

	// An unreadable stored URI is refused rather than treated as "no record". Treating it as
	// absent would create a second listing and orphan the first, and a duplicate public
	// record is far harder to clean up than a row somebody has to look at.
	if (existingUri && rkey === null) {
		return { action: "invalid", problem: `unreadable atproto_uri: ${existingUri}` };
	}

	const reason = unpublishableReason(work);
	if (reason !== null) {
		return rkey ? { action: "delete", rkey, reason } : { action: "none", reason };
	}

	const record = workToRecord(work, { baseUrl: opts.baseUrl });
	// Unreachable while `unpublishableReason` is the only thing that makes the mapper return
	// null, and checked rather than asserted so the two staying in step is enforced instead
	// of assumed.
	if (!record) return { action: "invalid", problem: "mapper produced no record" };

	const parsed = workRecord.safeParse(record);
	if (!parsed.success) {
		return { action: "invalid", problem: `record fails its own Lexicon: ${parsed.error}` };
	}

	return rkey ? { action: "replace", rkey, record } : { action: "create", record };
}

/** What a sync did, and the value `works.atproto_uri` should now hold. */
export interface WorkRecordOutcome {
	plan: WorkRecordPlan;
	/** The record's address, or null when the Work has no record any more. */
	uri: string | null;
}

/**
 * Carry out {@link planWorkRecord} against a repository.
 *
 * Returns the URI the caller should store rather than writing it, because the row and the
 * record are updated by different owners: this module owns the record, and the Work's row
 * belongs to whatever is releasing or withdrawing it.
 */
export async function syncWorkRecord(
	writer: RepoWriter,
	work: PublishableWork,
	opts: { baseUrl: string; existingUri?: string | null },
): Promise<WorkRecordOutcome> {
	const plan = planWorkRecord(work, opts);

	switch (plan.action) {
		case "create": {
			const ref = await writer.createRecord(WORK_COLLECTION, plan.record);
			return { plan, uri: ref.uri };
		}
		case "replace": {
			const ref = await writer.putRecord(WORK_COLLECTION, plan.rkey, plan.record);
			return { plan, uri: ref.uri };
		}
		case "delete": {
			await writer.deleteRecord(WORK_COLLECTION, plan.rkey);
			return { plan, uri: null };
		}
		case "none":
			return { plan, uri: null };
		case "invalid":
			// Deliberately leaves the stored URI alone. The two things that produce `invalid`
			// are a URI nobody can parse and a record that fails its own schema, and neither is
			// improved by this function also forgetting where the record was.
			return { plan, uri: opts.existingUri ?? null };
	}
}
