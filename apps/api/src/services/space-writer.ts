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
			// would otherwise hold the worker forever, and a shelf beyond this many records is a
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

/** Re-exported for callers that read bytes; the outbox does not, the backup does. */
export type { SpaceBytes };
