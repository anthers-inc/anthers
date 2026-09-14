// SPDX-License-Identifier: Apache-2.0
/**
 * A {@link RepoWriter} over a password session, for scripts run by a person.
 *
 * The running application never uses this: it writes into repositories through
 * `hosted-repo-writer.ts` for identities Anthers hosts and `oauth-repo-writer.ts` for a grant
 * over an identity held elsewhere. This is the third way in, for the two things a script does —
 * `atproto-publish-lexicon.ts` publishing schemas into Anthers' own account, and the integration
 * suites writing into a throwaway account on the local network `make pds-up` starts.
 *
 * 🛑 **It refuses to reach a server on the real network unless the caller passes `realNetwork`.**
 * A record there is public the moment it lands, so the safe default is the one that cannot
 * happen by leaving something out: a new script or test built on this reaches only a local
 * server, whatever URL it was handed. The one caller that passes the flag is the Lexicon
 * publisher, and only after a person at a terminal has typed back what it is about to publish.
 * The test for a local server is the hub's own — `apps/api/src/lib/atproto-network.ts`.
 *
 * ⚠️ **`@atproto/api` is a devDependency and must stay one.** Adding it to the API's
 * dependencies would put a second protocol client in the deployed image for a code path that
 * does not exist there. The Bun compatibility trap that bit `@atproto/oauth-client-node`
 * does not apply to this package — it was verified by *importing* it, not by installing it,
 * which is the distinction that failure taught.
 */
import { AtpAgent } from "@atproto/api";
import { isOffNetworkUrl } from "../apps/api/src/lib/atproto-network.js";
import type { RecordRef, RepoWriter } from "../apps/api/src/services/atproto-repo.js";

export interface SessionOptions {
	/** The server to talk to, e.g. `http://localhost:2583`, or `https://bsky.social` with `realNetwork`. */
	service: string;
	/** A handle, DID or email. */
	identifier: string;
	password: string;
	/** Required to reach anything but a local server. See the module note. */
	realNetwork?: boolean;
}

/** A writer that can also read back what it wrote, so a caller can check what actually landed. */
export interface SessionWriter extends RepoWriter {
	/** The record's value, or `null` when there is no such record. */
	getRecord(collection: string, rkey: string): Promise<Record<string, unknown> | null>;
}

/** Throw before any request is made when the target is real and the caller did not say so. */
function refuseUnlessAllowed(opts: SessionOptions): void {
	if (opts.realNetwork || isOffNetworkUrl(opts.service)) return;
	throw new Error(
		`refusing to open a session on ${opts.service}: it is on the real network, and only a ` +
			"caller passing realNetwork may reach it",
	);
}

async function login(opts: SessionOptions): Promise<AtpAgent> {
	refuseUnlessAllowed(opts);
	const agent = new AtpAgent({ service: opts.service });
	await agent.login({ identifier: opts.identifier, password: opts.password });
	return agent;
}

/**
 * Log in and return a writer bound to that account's repository.
 *
 * ⚠️ **`validate: false` is now an open question rather than a settled one.** It was
 * deliberate while no schema was published: server-side validation asks the server to
 * resolve the record's Lexicon, and asking for it on an unpublished schema fails on a record
 * that is perfectly correct. Every `org.anthers.*` schema is published now, so a server can
 * resolve them, and the flag has outlived its reason. The record is still validated locally
 * against the generated validator — the same schema a consumer would use — so nothing
 * unchecked goes out either way. **What turning it on would buy is hearing about a
 * disagreement between our validator and a server's**, which is worth having and is a
 * deliberate change to make rather than a flag to flip in passing.
 */
export async function sessionWriter(opts: SessionOptions): Promise<SessionWriter> {
	const agent = await login(opts);
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
		async getRecord(collection: string, rkey: string) {
			try {
				const res = await agent.com.atproto.repo.getRecord({ repo: did, collection, rkey });
				return res.data.value as Record<string, unknown>;
			} catch (err) {
				// The server answers a missing record with an error rather than an empty body.
				if ((err as { error?: string }).error === "RecordNotFound") return null;
				throw err;
			}
		},
	};
}

/** Read a record back, for a caller checking what actually landed. */
export async function readRecord(
	opts: SessionOptions & { collection: string; rkey: string },
): Promise<unknown> {
	const agent = await login(opts);
	const res = await agent.com.atproto.repo.getRecord({
		repo: agent.did as string,
		collection: opts.collection,
		rkey: opts.rkey,
	});
	return res.data.value;
}
