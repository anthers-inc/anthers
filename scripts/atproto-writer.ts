// SPDX-License-Identifier: Apache-2.0
/**
 * A {@link RepoWriter} backed by an ordinary session on a server we control.
 *
 * This is the implementation Anthers uses to write into **its own** repository — publishing
 * a schema, or a listing for a Work that Anthers itself owns. Writing into a *creator's*
 * repository is a different problem with the same three calls: it needs an OAuth session
 * carrying DPoP. ⭐ **The scope for that is narrow and available** — a `repo:` permission
 * naming one collection was confirmed honored on bsky.social on 2026-09-11 by
 * `scripts/atproto-scope-probe.ts` — so the eventual implementation is built on
 * `@atproto/oauth-client`, which the app already depends on, rather than waiting on the
 * protocol. This stays in `scripts/` because nothing in the running application writes
 * records yet.
 *
 * ⚠️ **`@atproto/api` is a devDependency and must stay one.** Adding it to the API's
 * dependencies would put a second protocol client in the deployed image for a code path that
 * does not exist there. The Bun compatibility trap that bit `@atproto/oauth-client-node`
 * does not apply to this package — it was verified by *importing* it, not by installing it,
 * which is the distinction that failure taught.
 */
import { AtpAgent } from "@atproto/api";
import type { RecordRef, RepoWriter } from "../apps/api/src/services/atproto-repo.js";

export interface SessionOptions {
	/** The server to talk to, e.g. `http://localhost:3000` or `https://bsky.social`. */
	service: string;
	/** A handle, DID or email. */
	identifier: string;
	password: string;
}

/**
 * Log in and return a writer bound to that account's repository.
 *
 * ⚠️ **`validate: false` is now an open question rather than a settled one.** It was
 * deliberate while no schema was published: server-side validation asks the server to
 * resolve the record's Lexicon, and asking for it on an unpublished schema fails on a record
 * that is perfectly correct. `org.anthers.work` has been published since 2026-09-10, so a
 * server can resolve it now, and the flag has outlived its reason. The record is still
 * validated locally against the generated validator — the same schema a consumer would use —
 * so nothing unchecked goes out either way. **What turning it on would buy is hearing about a
 * disagreement between our validator and a server's**, which is worth having and is a
 * deliberate change to make rather than a flag to flip in passing.
 */
export async function sessionWriter(opts: SessionOptions): Promise<RepoWriter> {
	const agent = new AtpAgent({ service: opts.service });
	await agent.login({ identifier: opts.identifier, password: opts.password });

	const did = agent.did;
	if (!did) throw new Error("logged in but the session carries no DID");

	return {
		did,
		async createRecord(collection: string, record: object): Promise<RecordRef> {
			const res = await agent.com.atproto.repo.createRecord({
				repo: did,
				collection,
				record: record as Record<string, unknown>,
				validate: false,
			});
			return { uri: res.data.uri, cid: res.data.cid };
		},
		async putRecord(collection: string, rkey: string, record: object): Promise<RecordRef> {
			const res = await agent.com.atproto.repo.putRecord({
				repo: did,
				collection,
				rkey,
				record: record as Record<string, unknown>,
				validate: false,
			});
			return { uri: res.data.uri, cid: res.data.cid };
		},
		async deleteRecord(collection: string, rkey: string): Promise<void> {
			await agent.com.atproto.repo.deleteRecord({ repo: did, collection, rkey });
		},
	};
}

/** Read a record back, for a caller checking what actually landed. */
export async function readRecord(
	opts: SessionOptions & { collection: string; rkey: string },
): Promise<unknown> {
	const agent = new AtpAgent({ service: opts.service });
	await agent.login({ identifier: opts.identifier, password: opts.password });
	const res = await agent.com.atproto.repo.getRecord({
		repo: agent.did as string,
		collection: opts.collection,
		rkey: opts.rkey,
	});
	return res.data.value;
}
