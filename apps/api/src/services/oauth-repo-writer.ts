// SPDX-License-Identifier: Apache-2.0
/**
 * A {@link RepoWriter} over an identity Anthers does **not** host.
 *
 * ⭐ **This is the half `hosted-repo-writer.ts` could not reach.** A record belongs in the
 * creator's own repository, and for a creator who took their handle somewhere else Anthers
 * holds no credential for it — so for a long time nothing was written for them, and the only
 * permission the network offered was broad enough to act as their entire account. That stopped
 * being true: a `repo:` permission naming one collection was confirmed honored on bsky.social
 * on 2026-09-11 (`scripts/atproto-scope-probe.ts`), so a creator can grant Anthers exactly the
 * right to keep their Work listings and nothing else.
 *
 * 🚨 **Holding no grant is the ORDINARY case and must stay that way.** Nobody is asked for this
 * to publish on Anthers, nothing about releasing a Work changes without it, and a creator who
 * never grants it is never told they are missing anything. `no_identity` and `not_granted`
 * below are both answered quietly for that reason — the day one of them starts reading as a
 * problem is the day Anthers has quietly made a network permission a condition of publishing.
 *
 * ⚠️ **The stored scope is a gate, and the authorization server is the authority.** What the
 * column says is checked first because it costs nothing and skips a round trip for the majority
 * who granted nothing; what the token says is checked after, because a column can be stale and
 * a token cannot. They disagree rarely, and when they do the token wins and the column is
 * corrected.
 */
import { db } from "@anthers/db";
import { users } from "@anthers/db/schema";
import { TokenInvalidError, TokenRevokedError } from "@atproto/oauth-client";
import { eq } from "drizzle-orm";
import { getAtprotoClient, grantedScopeFor, recordGrantedScope } from "./atproto-client.js";
import { type RecordRef, RepoAuthError, type RepoWriter } from "./atproto-repo.js";
import { missingRepoActions, scopeAllowsWriting } from "./atproto-scope.js";

/** Why no writer could be made over a creator's own grant. */
export type NoOauthWriterReason =
	/** This creator has linked no identity at all — the common case, and not a problem. */
	| "no_identity"
	/** They hold an identity and have not granted Anthers permission to publish into it. */
	| "not_granted"
	/** They granted it and the authorization server now refuses. Asking again is the fix. */
	| "grant_lost"
	/** The authorization server would not answer. Worth retrying. */
	| "session_unusable";

export type OauthWriterResult =
	| { writer: RepoWriter }
	| { writer: null; reason: NoOauthWriterReason };

/**
 * Open a writer onto the repository of the identity this account has linked.
 *
 * 🚨 **The grant is checked against the collections the caller is about to write, never against
 * a fixed one.** A creator's permission is per collection, and a writer opened on the strength
 * of a grant over Work listings would sail past this gate for a post, be refused by the creator's
 * own server, and be read as the creator having withdrawn a permission they never gave. The
 * caller names every collection it will touch, and a grant missing any of them is `not_granted`.
 *
 * ⚠️ **A revoked grant is forgotten here rather than merely reported.** The column exists to
 * tell the Studio whether publishing is on, so leaving it saying "granted" after the server has
 * said otherwise would show a creator a working state and give them nothing to press.
 */
export async function oauthWriterFor(
	userId: number,
	collections: readonly string[],
): Promise<OauthWriterResult> {
	const [row] = await db
		.select({ did: users.atprotoDid })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const did = row?.did;
	if (!did) return { writer: null, reason: "no_identity" };

	// The cheap gate. Most accounts will never have granted this, and answering them costs one
	// column read rather than a conversation with somebody else's authorization server.
	const stored = await grantedScopeFor(did);
	if (!collections.every((collection) => scopeAllowsWriting(stored, collection))) {
		return { writer: null, reason: "not_granted" };
	}

	let session: Awaited<ReturnType<ReturnType<typeof getAtprotoClient>["restore"]>>;
	try {
		session = await getAtprotoClient().restore(did);
	} catch (err) {
		// 🚨 **Two failures that look alike and mean opposite things.** A revoked or invalid
		// token is the creator having taken the permission back, which no amount of retrying
		// will undo; anything else is somebody's server having a bad moment, and clearing the
		// grant over one would make an outage look like a withdrawal.
		if (err instanceof TokenRevokedError || err instanceof TokenInvalidError) {
			await recordGrantedScope(did, null);
			return { writer: null, reason: "grant_lost" };
		}
		console.error(
			`[oauth-repo-writer] could not restore the session for ${did}: ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
		return { writer: null, reason: "session_unusable" };
	}

	// What the token itself says, which outranks the column. A grant narrowed since it was
	// recorded — a later sign-in replacing the session is the way that happens — is corrected
	// here rather than discovered as a refusal three calls later.
	const granted = await session.getTokenInfo().then(
		(info) => info.scope as string | undefined,
		() => undefined,
	);
	if (granted !== undefined) {
		await recordGrantedScope(did, granted);
		for (const collection of collections) {
			const missing = missingRepoActions(granted, collection);
			if (missing.length > 0) {
				console.log(
					`[oauth-repo-writer] ${did}: the stored grant no longer covers ` +
						`${missing.join(", ")} in ${collection}`,
				);
				return { writer: null, reason: "not_granted" };
			}
		}
	}

	return { writer: writerOver(session) };
}

/** The shape of an XRPC answer, as far as this module cares. */
interface XrpcBody {
	uri?: unknown;
	cid?: unknown;
	error?: unknown;
	message?: unknown;
}

/**
 * The three calls, over a session the SDK keeps fresh.
 *
 * ⚠️ **These throw rather than returning a result, which the interface requires.**
 * `syncWorkRecord` assumes a write either happened or raised, and a writer that returned a
 * quiet failure would let a sync report success and store a URI for a record that does not
 * exist. What this adds over the hosted writer is the *kind* of throw: a refusal of the
 * credentials is a {@link RepoAuthError}, which the caller treats as a withdrawn permission
 * instead of something to try again.
 *
 * ⭐ **`validate` is not sent, where the hosted writer sends `false`.** The flag asks the server
 * to resolve the record's Lexicon, and `org.anthers.work` has been published since 2026-09-10,
 * so a server on the public network can resolve it and its opinion is worth hearing. Omitting
 * the flag is also exactly what the scope probe did on the write that proved this path works,
 * which makes it the spelling with evidence behind it rather than the one with an argument.
 */
function writerOver(session: {
	did: string;
	fetchHandler: (pathname: string, init?: RequestInit) => Promise<Response>;
}): RepoWriter {
	const did = session.did;

	const call = async (method: string, body: object): Promise<XrpcBody> => {
		const res = await session.fetchHandler(`/xrpc/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const parsed = ((await res.json().catch(() => null)) ?? {}) as XrpcBody;
		if (res.ok) return parsed;

		const error = typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`;
		const detail = typeof parsed.message === "string" ? ` — ${parsed.message}` : "";
		// 401 is a token that is no longer good; 403 is a token that was never allowed to do
		// this. Both are answered by asking the creator again rather than by trying again.
		if (res.status === 401 || res.status === 403) {
			throw new RepoAuthError(`${method}: ${error}${detail}`, did);
		}
		throw new Error(`${method}: ${error}${detail}`);
	};

	return {
		did,
		async createRecord(collection: string, record: object): Promise<RecordRef> {
			return refFrom(
				await call("com.atproto.repo.createRecord", { repo: did, collection, record }),
			);
		},
		async putRecord(collection: string, rkey: string, record: object): Promise<RecordRef> {
			return refFrom(
				await call("com.atproto.repo.putRecord", { repo: did, collection, rkey, record }),
			);
		},
		async deleteRecord(collection: string, rkey: string): Promise<void> {
			await call("com.atproto.repo.deleteRecord", { repo: did, collection, rkey });
		},
	};
}

/**
 * Read the address back out of what the repository answered.
 *
 * ⚠️ **Checked rather than cast**, for the reason `hosted-repo-writer.ts` gives: a missing URI
 * stored as `undefined` would look like a Work that has no record, and the next sync would
 * create a second one.
 */
function refFrom(body: XrpcBody): RecordRef {
	const { uri, cid } = body;
	if (typeof uri !== "string" || typeof cid !== "string") {
		throw new Error("the repository wrote a record but answered without its address");
	}
	return { uri, cid };
}
