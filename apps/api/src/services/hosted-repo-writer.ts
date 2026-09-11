// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A {@link RepoWriter} over an identity Anthers hosts.
 *
 * ⭐ **This is the piece that made record-writing possible at all.** A record belongs in the
 * creator's own repository, and the only permission the network offers for a repository
 * Anthers does not host is `transition:generic` — App-Password-equivalent power over somebody's
 * whole account, which is not a thing to ask a creator for. Hosting the identity was the
 * unblock Anthers controlled: for an account that took a handle here, the credential is in
 * `hosted_accounts`, sealed, and the hub can open it.
 *
 * 🚨 **Built on `nodeCall` rather than `@atproto/api`, deliberately.** `scripts/atproto-writer.ts`
 * uses that package and its docblock says plainly that it must stay a devDependency — putting a
 * second protocol client in the deployed image for three XRPC calls is the cost it was avoiding.
 * These are the same three calls the script makes, over the same fetch helper every other
 * conversation with the node already goes through.
 *
 * ⚠️ **`validate: false` is carried over for the reason the script gives.** Server-side
 * validation asks the node to resolve the record's Lexicon, and `org.anthers.work` is not
 * published yet — so asking for it fails on a schema that is correct. The record is validated
 * locally against the generated validator before it ever reaches here, which is the same schema
 * a consumer would use. **Revisit this when the Lexicon is published**, because at that point a
 * disagreement between the two would be worth hearing about.
 */
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type { RecordRef, RepoWriter } from "./atproto-repo.js";
import { nodeCall } from "./hosted-accounts.js";
import { open } from "./secret-box.js";

/** Why no writer could be made. Every one of these is ordinary rather than an error. */
export type NoWriterReason =
	/** This creator holds no identity Anthers hosts — the common case, and not a problem. */
	| "not_hosted"
	/** The credential exists and this deployment's key cannot open it. */
	| "credential_unopenable"
	/** The node did not answer, or refused the session. Worth retrying. */
	| "node_unreachable";

export type HostedWriterResult = { writer: RepoWriter } | { writer: null; reason: NoWriterReason };

/**
 * Open a writer onto the repository of the identity this account holds.
 *
 * 🚨 **A creator with no hosted identity is the ORDINARY case and must stay that way.** Nobody
 * is turned away for lacking one, so this answers `not_hosted` and every caller carries on —
 * publishing a Work must not behave differently, fail, or warn because its creator never took
 * a handle. The day that stops being true is the day Anthers has quietly made an identity a
 * requirement.
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

	// `open` throws on a value this deployment's key cannot open, which is a real state — see
	// `signup-probe.anthers.social` in the runbook. Retrying never opens it.
	let password: string;
	try {
		password = open(row.sealedPassword);
	} catch {
		console.error(`[repo-writer] cannot open the credential for ${row.did}`);
		return { writer: null, reason: "credential_unopenable" };
	}

	const session = await nodeCall(
		"/xrpc/com.atproto.server.createSession",
		{ method: "POST", body: JSON.stringify({ identifier: row.did, password }) },
		doFetch,
	);
	if (!session.ok) return { writer: null, reason: "node_unreachable" };
	const token = session.body.accessJwt as string | undefined;
	if (!token) return { writer: null, reason: "node_unreachable" };

	return { writer: writerOver(row.did, token, doFetch) };
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
function writerOver(did: string, token: string, doFetch: typeof fetch): RepoWriter {
	const call = async (path: string, body: object): Promise<Record<string, unknown>> => {
		const res = await nodeCall(
			path,
			{ method: "POST", token, body: JSON.stringify(body) },
			doFetch,
		);
		if (!res.ok) throw new Error(`${path}: ${res.error}${res.message ? ` — ${res.message}` : ""}`);
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
