// SPDX-License-Identifier: Apache-2.0
/**
 * The space writer: which session an account's space is written with, and the narrow calls the
 * outbox needs over it.
 *
 * ⭐ **Two layers, split on purpose.** {@link hostedSpaceSession} answers *whose* space and
 * *with what credential*; {@link spaceWriterFor} turns an already-resolved session into the
 * handful of calls the worker makes. The worker takes the resolver as a dependency, so a test
 * can drive the whole outbox against a fake PDS without a hosted identity, and the production
 * path is the same code with the hosted resolver.
 *
 * 🚨 **Only the hosted route exists today, and that is a statement about the deployment
 * rather than about the design.** A reader whose identity lives elsewhere writes their space
 * with their own OAuth grant, whose scope has to include `space:org.anthers.userSpace…`; the
 * app's OAuth and its published permission sets are switched together with the production
 * image, deliberately, because today's authorization server rejects the `space` resource.
 * Until then this answers `not_hosted` for those accounts, exactly as `repo-writer.ts` does
 * for a public-repository write, and the caller treats it as an ordinary skip.
 */

import { isDeepStrictEqual } from "node:util";
import type { SpaceBytes, SpaceCommit, SpaceRecord, SpaceRepoOp } from "./atproto-space.js";
import { SpaceClient, SpaceRequestError } from "./atproto-space.js";
import { hostedPdsUrl } from "./hosted-accounts.js";
import { hostedTokenFor, type NoWriterReason } from "./hosted-repo-writer.js";

/** Why an account's space cannot be written right now. All of these are ordinary. */
export type NoSpaceSessionReason = NoWriterReason;

/** Everything a space call needs: the owner's DID, the server, and a bearer token. */
export interface SpaceSession {
	did: string;
	/** The PDS origin, with no trailing slash. */
	pdsUrl: string;
	token: string;
}

export type SpaceSessionResult =
	| { session: SpaceSession }
	| { session: null; reason: NoSpaceSessionReason };

/** Resolve an account to the session its space is written with. */
export type ResolveSpaceSession = (userId: number) => Promise<SpaceSessionResult>;

/**
 * The hosted route: an identity Anthers holds the credential for.
 *
 * The same login-budget rule as the public-repository writer, through the same helper — one
 * `createSession` per account rather than one per write.
 */
export function hostedSpaceSession(opts: { fetchImpl?: typeof fetch } = {}): ResolveSpaceSession {
	return async (userId) => {
		const token = await hostedTokenFor(userId, opts);
		if (!token.ok) return { session: null, reason: token.reason };
		return {
			session: { did: token.did, pdsUrl: hostedPdsUrl(), token: token.token },
		};
	};
}

/** The raw client for a session, for the calls that are not record writes. */
export function spaceClientFor(
	session: SpaceSession,
	opts: { fetchImpl?: typeof fetch } = {},
): SpaceClient {
	return new SpaceClient({
		baseUrl: session.pdsUrl,
		token: session.token,
		fetch: opts.fetchImpl
			? (input, init) => opts.fetchImpl?.(input.toString(), init) as Promise<Response>
			: undefined,
	});
}

/** A record address as the write returned it. */
export interface SpaceWriteRef {
	uri: string;
	cid: string;
}

/**
 * The calls the outbox and the projection make, and nothing else.
 *
 * ⚠️ **`get` answers null for a record that is not there, and throws for anything else.** The
 * difference is the whole verification: a delete is verified by finding null, and a read that
 * failed because the node was down must never be mistaken for one.
 */
export interface SpaceWriter {
	readonly did: string;
	readonly space: string;
	put(collection: string, rkey: string, record: Record<string, unknown>): Promise<SpaceWriteRef>;
	remove(collection: string, rkey: string): Promise<void>;
	get(collection: string, rkey: string): Promise<SpaceRecord | null>;
	list(collection: string): Promise<SpaceRecord[]>;
	commit(): Promise<SpaceCommit>;
	ops(opts?: { since?: string; limit?: number }): Promise<{
		ops: SpaceRepoOp[];
		commit?: SpaceCommit;
	}>;
}

/** The record-not-found error names the branch's space endpoints use. */
const MISSING_RECORD_CODES = new Set(["RecordNotFound", "NotFound"]);

/**
 * A space writer over a session, at one space address.
 *
 * The space is fixed at construction because an account has one of each type and every call
 * this path makes is into that one; a caller that needs another space builds another writer.
 */
export function spaceWriterFor(
	session: SpaceSession,
	space: string,
	opts: { fetchImpl?: typeof fetch } = {},
): SpaceWriter {
	const client = spaceClientFor(session, opts);
	const { did } = session;

	return {
		did,
		space,
		async put(collection, rkey, record) {
			const result = await client.putRecord({
				space,
				repo: did,
				collection,
				rkey,
				record,
				validate: false,
			});
			return { uri: result.uri, cid: result.cid };
		},
		async remove(collection, rkey) {
			await client.deleteRecord({ space, repo: did, collection, rkey });
		},
		async get(collection, rkey) {
			try {
				return await client.getRecord({ space, repo: did, collection, rkey });
			} catch (error) {
				if (error instanceof SpaceRequestError && MISSING_RECORD_CODES.has(error.error ?? "")) {
					return null;
				}
				throw error;
			}
		},
		async list(collection) {
			const records: SpaceRecord[] = [];
			let cursor: string | undefined;
			// A cap rather than a `while (true)`: a server that kept returning the same cursor
			// would otherwise hold the worker forever, and a Library beyond this many records is a
			// report to read, not a loop to keep spinning.
			for (let page = 0; page < 100; page++) {
				const answer = await client.listRecords({
					space,
					repo: did,
					collection,
					limit: 100,
					cursor,
				});
				records.push(...answer.records);
				if (!answer.cursor) return records;
				cursor = answer.cursor;
			}
			throw new Error(`listRecords(${collection}) did not finish within 100 pages`);
		},
		async commit() {
			const answer = await client.getLatestCommit({ space, repo: did });
			return answer.commit;
		},
		async ops(opts = {}) {
			return client.listRepoOps({ space, repo: did, limit: 50, ...opts });
		},
	};
}

/**
 * A write that answered 200 but did not survive a read-back.
 *
 * The check is named because the difference matters to whoever reads the log: a bad CID and an
 * unchanged commit are different failures, and the outbox reports the first by kind while an
 * operator reads the second as a server that accepted the call without applying it.
 */
export class SpaceVerificationError extends Error {
	constructor(
		readonly check: "read" | "uri" | "cid" | "value" | "commit" | "oplog",
		message: string,
	) {
		super(message);
		this.name = "SpaceVerificationError";
	}
}

/**
 * The checks that make a space write verified: address, CID, value, and a commit and oplog
 * that agree about it.
 *
 * ⭐ **One implementation for every writer.** The outbox and the creator-space sync make the
 * same promise — a record is not believed until it has been read back at the address and CID
 * the server returned, the commit moved, and the oplog carries the operation — and two copies
 * of that promise would be free to drift apart. A delete is verified by finding nothing.
 *
 * A space with no repo yet answers `RepoNotFound` for the "before" commit; the caller passes
 * `previousRev: null` for that case rather than treating it as a failure.
 */
export async function verifySpaceWrite(
	writer: SpaceWriter,
	input: {
		collection: string;
		rkey: string;
		op: "put" | "delete";
		record?: Record<string, unknown> | null;
		written: SpaceWriteRef | null;
		previousRev: string | null;
	},
): Promise<void> {
	if (input.op === "delete") {
		const read = await writer.get(input.collection, input.rkey);
		if (read !== null) {
			throw new SpaceVerificationError("read", "the record is still there after a delete");
		}
	} else {
		const read = await writer.get(input.collection, input.rkey);
		if (!read) throw new SpaceVerificationError("read", "the record is not there after the write");
		if (!input.written) throw new SpaceVerificationError("read", "the write returned no address");
		if (read.uri !== input.written.uri) {
			throw new SpaceVerificationError(
				"uri",
				`read-back uri ${read.uri} is not ${input.written.uri}`,
			);
		}
		if (read.cid !== input.written.cid) {
			throw new SpaceVerificationError(
				"cid",
				`read-back cid ${read.cid} is not ${input.written.cid}`,
			);
		}
		if (!isDeepStrictEqual(read.value, input.record)) {
			throw new SpaceVerificationError("value", "read-back value is not the record that was sent");
		}
	}

	const commit = await writer.commit();
	if (input.previousRev !== null && commit.rev <= input.previousRev) {
		throw new SpaceVerificationError("commit", `commit did not advance past ${input.previousRev}`);
	}

	const oplog = await writer.ops(input.previousRev ? { since: input.previousRev } : {});
	const op = oplog.ops.find(
		(entry) => entry.collection === input.collection && entry.rkey === input.rkey,
	);
	if (!op) throw new SpaceVerificationError("oplog", "the oplog has no operation for the record");
	const expectedCid = input.op === "delete" ? null : (input.written as { cid: string }).cid;
	if ((op.cid ?? null) !== expectedCid) {
		throw new SpaceVerificationError(
			"oplog",
			`oplog cid ${op.cid ?? "null"} is not ${expectedCid ?? "null"}`,
		);
	}
}

/**
 * Put one record and verify it, for a caller that has no outbox row.
 *
 * ⚠️ **A space has no repo until its first write**, so the "before" commit is allowed to be
 * absent; treating `RepoNotFound` as a failure would make the very first creator-space record
 * undeliverable.
 */
export async function putVerifiedSpaceRecord(
	writer: SpaceWriter,
	collection: string,
	rkey: string,
	record: Record<string, unknown>,
): Promise<SpaceWriteRef> {
	const previous = await writer.commit().catch((error) => {
		if (error instanceof SpaceRequestError && error.error === "RepoNotFound") return null;
		throw error;
	});
	const written = await writer.put(collection, rkey, record);
	await verifySpaceWrite(writer, {
		collection,
		rkey,
		op: "put",
		record,
		written,
		previousRev: previous?.rev ?? null,
	});
	return written;
}

/** Re-exported for callers that read bytes; the outbox does not, the backup does. */
export type { SpaceBytes };
