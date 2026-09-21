// SPDX-License-Identifier: Apache-2.0
/**
 * A {@link RepoWriter} over an identity Anthers hosts.
 *
 * ⭐ **This is the route that needs nobody's permission.** A record belongs in the creator's
 * own repository, and for an account that took a handle here the credential is in
 * `hosted_accounts`, sealed, and the hub can open it — so there is nothing to ask for and
 * nothing that can be taken back.
 *
 * ⚠️ **It is one of two routes, and `not_hosted` is no longer the end of the story.**
 * `oauth-repo-writer.ts` covers a creator whose identity lives elsewhere and who has granted
 * Anthers a narrow `repo:` permission over the one collection; `repo-writer.ts` is what
 * chooses between them. So `not_hosted` below means "ask the other route", and the two must
 * not be confused: a hosted credential that will not open is a fault in Anthers' own hub and
 * is deliberately NOT routed around, because writing the record by another means would leave
 * nobody with a reason to look at the hub.
 *
 * 🚨 **Built on `nodeCall` rather than `@atproto/api`, deliberately.** `scripts/atproto-writer.ts`
 * uses that package and its docblock says plainly that it must stay a devDependency — putting a
 * second protocol client in the deployed image for three XRPC calls is the cost it was avoiding.
 * These are the same three calls the script makes, over the same fetch helper every other
 * conversation with the node already goes through.
 *
 * ⚠️ **`validate: false` is now an open question rather than a settled one, and the two writers
 * disagree about it.** The flag asks the server to resolve the record's Lexicon, which was
 * pointless while none was published; `org.anthers.work` has been published since 2026-09-10,
 * so the reason has expired. `oauth-repo-writer.ts` omits the flag — the spelling the scope
 * probe's successful write used — and this one still sends `false`. Either way the record is
 * validated locally against the generated validator, the same schema a consumer would use, so
 * nothing unchecked goes out. **What turning it on would buy is hearing about a disagreement
 * between our validator and a server's**, which is worth having and is a deliberate change to
 * make rather than a flag to flip in passing.
 */
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type { RecordRef, RepoWriter } from "./atproto-repo.js";
import { hostedPdsUrl, nodeCall } from "./hosted-accounts.js";
import { clearHostedSession, sessionForHostedAccount } from "./hosted-session-store.js";
import { open } from "./secret-box.js";

/** Why no writer could be made. Every one of these is ordinary rather than an error. */
export type NoWriterReason =
	/** This account's identity lives on a server other than Anthers' node — ordinary, and not a problem. */
	| "not_hosted"
	/** The credential exists and this deployment's key cannot open it. */
	| "credential_unopenable"
	/** The node did not answer, or refused the session. Worth retrying. */
	| "node_unreachable"
	/**
	 * No identity server this process may write to is configured: `HOSTED_PDS_URL` is unset, or
	 * names a server on the real network from a machine that is not a public deployment.
	 */
	| "no_node";

export type HostedWriterResult = { writer: RepoWriter } | { writer: null; reason: NoWriterReason };

/**
 * Open a writer onto the repository of the identity this account holds.
 *
 * 🚨 **A creator whose identity Anthers does not host is an ORDINARY case and must stay that
 * way.** Somebody who signed up with Bluesky holds their identity elsewhere, so this answers
 * `not_hosted` and every caller carries on — publishing a Work must not behave differently, fail,
 * or warn because its creator's identity lives on another server. The day that stops being true
 * is the day Anthers has quietly made a hosted identity a requirement.
 */
export async function hostedWriterFor(
	userId: number,
	opts: { fetchImpl?: typeof fetch } = {},
): Promise<HostedWriterResult> {
	const doFetch = opts.fetchImpl ?? fetch;

	const [row] = await db
		.select({ did: hostedAccounts.did, sealedPassword: hostedAccounts.sealedPassword })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.userId, userId))
		.limit(1);
	if (!row) return { writer: null, reason: "not_hosted" };
	// Checked before the credential is opened, so a refused server is reported as what it is
	// rather than as a node that did not answer.
	if (!hostedPdsUrl()) return { writer: null, reason: "no_node" };

	// `open` throws on a value this deployment's key cannot open, which is a real state — see
	// `signup-probe.anthers.social` in the runbook. Retrying never opens it.
	let password: string;
	try {
		password = open(row.sealedPassword);
	} catch {
		console.error(`[repo-writer] cannot open the credential for ${row.did}`);
		return { writer: null, reason: "credential_unopenable" };
	}

	// ⭐ **One login per account, not one per write.** The store reuses the session already on
	// file and renews it with `refreshSession`; `createSession` — the call the node limits —
	// happens only when there is no session or the node refused the refresh.
	const session = await sessionForHostedAccount(row.did, password, { fetchImpl: doFetch });
	if (!session.token) return { writer: null, reason: "node_unreachable" };

	return {
		writer: writerOver(row.did, session.token, doFetch, {
			// A write the node answered 401 means the token just died out from under us. Drop the
			// stored session so the NEXT open logs in fresh once, then still throw — the caller's
			// retry machinery is what should drive the recovery, not a silent in-writer retry.
			onAuthFailure: () => clearHostedSession(row.did),
		}),
	};
}

/**
 * The three calls, over a session that is already open.
 *
 * ⚠️ **These throw rather than returning a result, which is the opposite of everything else in
 * this module and is required by the interface.** `RepoWriter` is what `syncWorkRecord` talks
 * to, and that function's whole shape assumes a write either happened or raised — a writer that
 * returned a quiet failure would let a sync report success and store a URI for a record that
 * does not exist. The caller's job wrapper is what turns a throw back into a retry.
 */
/**
 * The node's codes for "this token is dead". `AuthenticationRequired` and `InvalidToken` are
 * the 401 answers; `ExpiredToken` is the reference PDS's considered refusal of an expired
 * access token. Branching on the CODE rather than the prose for the same reason
 * `hosted-accounts.ts` does: the prose is upstream's wording and moves between versions.
 */
const AUTH_FAILURE_CODES = new Set(["AuthenticationRequired", "InvalidToken", "ExpiredToken"]);

function writerOver(
	did: string,
	token: string,
	doFetch: typeof fetch,
	opts: { onAuthFailure?: () => void | Promise<void> } = {},
): RepoWriter {
	const call = async (path: string, body: object): Promise<Record<string, unknown>> => {
		const res = await nodeCall(
			path,
			{ method: "POST", token, body: JSON.stringify(body) },
			doFetch,
		);
		if (!res.ok) {
			// A non-retryable Authentication failure is the node saying this token is dead. The
			// stored session goes so the next open logs in once; the THROW is unchanged, because
			// callers rely on throw-to-retry and a write retried silently here would be a second
			// attempt nobody asked for.
			if (!res.retryable && AUTH_FAILURE_CODES.has(res.error) && opts.onAuthFailure) {
				await opts.onAuthFailure();
			}
			throw new Error(`${path}: ${res.error}${res.message ? ` — ${res.message}` : ""}`);
		}
		return res.body;
	};

	return {
		did,
		async createRecord(collection: string, record: object): Promise<RecordRef> {
			const body = await call("/xrpc/com.atproto.repo.createRecord", {
				repo: did,
				collection,
				record,
				validate: false,
			});
			return refFrom(body);
		},
		async putRecord(collection: string, rkey: string, record: object): Promise<RecordRef> {
			const body = await call("/xrpc/com.atproto.repo.putRecord", {
				repo: did,
				collection,
				rkey,
				record,
				validate: false,
			});
			return refFrom(body);
		},
		async deleteRecord(collection: string, rkey: string): Promise<void> {
			await call("/xrpc/com.atproto.repo.deleteRecord", { repo: did, collection, rkey });
		},
	};
}

/**
 * Read the address back out of what the node answered.
 *
 * ⚠️ **Checked rather than cast.** The URI is what gets stored against the Work and is how the
 * record is found again to replace or delete it; a missing one stored as `undefined` would look
 * like a Work that has no record, and the next sync would create a second.
 */
function refFrom(body: Record<string, unknown>): RecordRef {
	const uri = body.uri;
	const cid = body.cid;
	if (typeof uri !== "string" || typeof cid !== "string") {
		throw new Error("the node wrote a record but answered without its address");
	}
	return { uri, cid };
}
