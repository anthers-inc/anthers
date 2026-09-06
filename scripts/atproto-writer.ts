// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A {@link RepoWriter} backed by an ordinary session on a server we control.
 *
 * This is the implementation Anthers uses to write into **its own** repository — publishing
 * a schema, or a listing for a Work that Anthers itself owns. Writing into a *creator's*
 * repository is a different problem with the same three calls: it needs an OAuth session
 * carrying DPoP, and the only scope the network offers for it today is broad enough to act
 * as that person's whole account. That is why this lives in `scripts/` rather than in the
 * API's services — nothing in the running application writes records yet, and the eventual
 * one will be built on `@atproto/oauth-client`, which the app already depends on.
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
 * 🚨 **`validate: false` is deliberate and is not a shortcut.** Server-side validation asks
 * the server to resolve the record's Lexicon, and `org.anthers.work` has never been
 * published — so there is nothing on the network for it to resolve, and asking for
 * validation fails on a schema that is correct. The record is validated locally against the
 * generated validator before it ever gets here, which is a stronger check than the server
 * could perform anyway: it is the same schema a consumer would use. **When the Lexicon is
 * published this should be revisited**, because at that point the server can check it and a
 * disagreement between the two would be worth hearing about.
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
