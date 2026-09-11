// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The ATProto OAuth client, built on `@atproto/oauth-client` — the runtime-agnostic core
 * of the official SDK — with Bun-native crypto and Postgres-backed stores.
 *
 * 🚨 We deliberately do NOT use `@atproto/oauth-client-node`. It fails to import under Bun
 * with `webidl.util.markAsUncloneable is not a function`, raised from
 * `@atproto-labs/fetch-node`, which expects Node's real `undici` where Bun ships a shim
 * that lacks that function. The failure is at import time, so nothing downstream runs.
 *
 * That package turns out to be about fifty lines of glue over the core: a runtime
 * implementation built from `node:crypto`, a `node:dns` handle resolver, and a small store
 * wrapper that serializes the DPoP key. All three are reproduced below against Web Crypto
 * and DNS-over-HTTPS, both of which Bun has natively. Everything load-bearing — PAR, PKCE,
 * DPoP, nonce handling, token refresh, session management, identity resolution — comes
 * from the SDK, which is the point: this file is glue, not protocol.
 *
 * ⚠️ Anything imported here must be checked to IMPORT under Bun, not merely to install.
 * `bun add` reported success for `oauth-client-node` and it was broken.
 */

import { db } from "@anthers/db";
import { atprotoOauthState, atprotoSessions } from "@anthers/db/schema";
import { JoseKey } from "@atproto/jwk-jose";
import {
	AtprotoDohHandleResolver,
	atprotoLoopbackClientMetadata,
	buildAtprotoLoopbackClientId,
	OAuthClient,
} from "@atproto/oauth-client";
import { eq, lt } from "drizzle-orm";
import { publicOrigin } from "../lib/deployment.js";
import { WORK_COLLECTION } from "./atproto-repo.js";

/** How long a half-finished authorization stays resumable. */
const STATE_TTL_MS = 60 * 60 * 1000;

/**
 * The SDK hands its stores a live `Key` object and expects one back. Only the private JWK
 * is serializable, so both stores round-trip through it. Lifted from
 * `@atproto/oauth-client-node`'s `toDpopKeyStore`, which is the whole of what it adds.
 */
function withDpopKey<
	T extends {
		get: (k: string) => Promise<any>;
		set: (k: string, v: any) => Promise<void>;
		del: (k: string) => Promise<void>;
	},
>(store: T) {
	return {
		async set(key: string, { dpopKey, ...data }: any) {
			const dpopJwk = dpopKey.privateJwk;
			if (!dpopJwk) throw new Error("Private DPoP JWK is missing.");
			await store.set(key, { ...data, dpopJwk });
		},
		async get(key: string) {
			const found = await store.get(key);
			if (!found) return undefined;
			const { dpopJwk, ...data } = found;
			return { ...data, dpopKey: await JoseKey.fromJWK(dpopJwk) };
		},
		del: (key: string) => store.del(key),
	};
}

/**
 * Pending authorizations, keyed by the OAuth `state` parameter. Replaces an in-process
 * `Map` that lost every in-flight flow on restart and broke outright the moment a callback
 * landed on a different instance than the initiation.
 */
export const oauthStateStore = withDpopKey({
	async get(key: string) {
		const [row] = await db
			.select()
			.from(atprotoOauthState)
			.where(eq(atprotoOauthState.key, key))
			.limit(1);
		if (!row) return undefined;
		// An expired row is treated as absent rather than deleted here, so a `get` stays a
		// read; the sweep below is the only writer that removes them.
		if (Date.now() - row.createdAt.getTime() > STATE_TTL_MS) return undefined;
		return row.state as Record<string, unknown>;
	},
	async set(key: string, value: unknown) {
		await db
			.insert(atprotoOauthState)
			.values({ key, state: value as object })
			.onConflictDoUpdate({ target: atprotoOauthState.key, set: { state: value as object } });
	},
	async del(key: string) {
		await db.delete(atprotoOauthState).where(eq(atprotoOauthState.key, key));
	},
});

/** Drop authorizations nobody came back for. Called opportunistically on each initiation. */
export async function sweepExpiredOauthState(): Promise<void> {
	await db
		.delete(atprotoOauthState)
		.where(lt(atprotoOauthState.createdAt, new Date(Date.now() - STATE_TTL_MS)));
}

/**
 * Live sessions, keyed by DID. The SDK addresses this by token subject and knows nothing
 * about Anthers accounts, which is why the row can exist before the account does; the
 * caller reconciles `userId` afterwards via `attachSessionToUser`.
 */
export const oauthSessionStore = withDpopKey({
	async get(did: string) {
		const [row] = await db
			.select()
			.from(atprotoSessions)
			.where(eq(atprotoSessions.did, did))
			.limit(1);
		return (row?.session as Record<string, unknown>) ?? undefined;
	},
	async set(did: string, value: unknown) {
		await db
			.insert(atprotoSessions)
			.values({ did, session: value as object })
			.onConflictDoUpdate({
				target: atprotoSessions.did,
				set: { session: value as object, updatedAt: new Date() },
			});
	},
	async del(did: string) {
		await db.delete(atprotoSessions).where(eq(atprotoSessions.did, did));
	},
});

/** Point a stored session at the Anthers account it belongs to. */
export async function attachSessionToUser(did: string, userId: number): Promise<void> {
	await db
		.update(atprotoSessions)
		.set({ userId, updatedAt: new Date() })
		.where(eq(atprotoSessions.did, did));
}

/**
 * Write down what the authorization server actually granted for this DID.
 *
 * 🚨 **Called on EVERY callback, not only the one that asked for something.** The column
 * describes the session stored beside it, and a session is replaced wholesale by each new
 * authorization — so a sign-in after a publishing grant leaves an identity-only token, and a
 * column that was only written by the publishing flow would go on claiming a permission the
 * token no longer carries. Every caller passing what it was told is what keeps it honest.
 *
 * ⚠️ **Best-effort, and a failure is not the caller's problem.** This runs in the middle of
 * signing somebody in; a column that failed to update is a creator who has to grant publishing
 * again, which is a far smaller harm than a sign-in that failed over bookkeeping.
 */
export async function recordGrantedScope(did: string, scope: string | null): Promise<void> {
	try {
		await db
			.update(atprotoSessions)
			.set({ scope, updatedAt: new Date() })
			.where(eq(atprotoSessions.did, did));
	} catch (err) {
		console.error(
			`[atproto] could not record the granted scope for ${did}: ` +
				`${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Read what the stored session for this DID was granted, as an unparsed string.
 *
 * ⚠️ **Null means nothing is known, never that nothing was granted.** A row written before the
 * column existed answers the same way as one whose token would not report itself, and both
 * have to be treated as "no permission on file" — the alternative is a caller that tries a
 * write it has no reason to believe will work.
 */
export async function grantedScopeFor(did: string): Promise<string | null> {
	const [row] = await db
		.select({ scope: atprotoSessions.scope })
		.from(atprotoSessions)
		.where(eq(atprotoSessions.did, did))
		.limit(1);
	return row?.scope ?? null;
}

/**
 * The API's own public origin, which is what an authorization server will fetch client
 * metadata from and redirect back to.
 *
 * 🚨 `BASE_URL` is declared nowhere in `.do/app.yaml`, so in production it is unset — and
 * the previous code fell straight back to `http://localhost:8000`. Production therefore
 * advertised `client_id: http://localhost:8000/api/atproto/client-metadata.json`, which no
 * authorization server would accept. This flow could never have worked in production, and
 * nothing said so, because nothing in the UI called it.
 *
 * `FRONTEND_URL` is set in production and is the right answer: the SPA and the API share
 * one origin there, with `/api` ingress-routed (`${APP_URL}`, which resolves to the PRIMARY
 * domain — `https://anthers.org`). In development they do not share an origin, so the API's
 * own port is used instead.
 *
 * 🚨 **The `FRONTEND_URL` fallback was gated on `NODE_ENV === "production"` until
 * 2026-08-22, and `NODE_ENV` IS SET NOWHERE IN `.do/app.yaml`.** So the guard was false in
 * production, the fallback never ran, and production went on serving the loopback identity
 * the fix was written to remove — verified by curling the live metadata document minutes
 * after the deploy. The fix reproduced the bug it was fixing, one level up: the first
 * version read the wrong variable, the second read the right one behind a condition nobody
 * had checked.
 *
 * ⭐ **So the shape of the answer is "detect the thing itself, never a proxy for it".** An
 * https `FRONTEND_URL` *is* what "we are deployed somewhere public" means; `NODE_ENV` is a
 * label somebody has to remember to set, and nobody did. The environment is now inferred
 * from the origin rather than asserted alongside it, and there is no configuration whose
 * absence silently downgrades a protocol identity.
 *
 * ⭐ **That test generalized on 2026-08-23**, when the CORS/CSRF allowlist and both cookie
 * writers were found asking `NODE_ENV` the same question and getting the same wrong answer.
 * `publicOrigin()` in `lib/deployment.ts` is where it lives now, so the API has one
 * definition of "public" rather than four descriptions of it that can drift.
 */
export function getBaseUrl(): string {
	const explicit = process.env.BASE_URL;
	if (explicit) return explicit.replace(/\/+$/, "");

	// Any https origin means this is deployed and reachable, whatever NODE_ENV says.
	const frontend = publicOrigin();
	if (frontend) return frontend;

	// Only a declared production environment is an ERROR — that combination means somebody
	// meant to deploy and gave us nothing usable, which must fail loudly rather than emit a
	// client identity no authorization server will accept.
	if (process.env.NODE_ENV === "production") {
		throw new Error(
			"ATProto OAuth needs an https origin: set BASE_URL, or FRONTEND_URL to the public site.",
		);
	}

	return "http://localhost:8000";
}

/**
 * The narrow scope that grants read access to the account's address, and nothing else.
 *
 * ⚠️ It lives here rather than in `services/atproto.ts` because the client metadata below
 * has to declare it, and that module imports THIS one — the other direction would be a
 * cycle.
 */
export const EMAIL_SCOPE = "transition:email";

/**
 * The permission to keep a creator's Work listings in their own repository, and nothing else.
 *
 * ⭐ **It names one collection and three actions, which is the whole of what publishing a
 * listing needs.** `create` puts a listing up, `update` keeps it in step with the Work, and
 * `delete` takes it down — and that last one is the reason the set cannot be trimmed further:
 * a grant that could publish but not withdraw would leave listings advertising Works their
 * creators had taken back, which is the failure the whole listing design is shaped around.
 *
 * ⚠️ **The three actions are spelled out although they are also the default, and that is
 * deliberate.** Proposal 0011 reads an absent `action` parameter as *every* action, so the bare
 * `repo:org.anthers.work` is the wider request of the two and would silently widen again if the
 * vocabulary ever grew. Naming them pins the grant to what Anthers actually does.
 *
 * 🚨 **What comes back will not be spelled this way.** The same proposal's formatter drops any
 * parameter equal to its default, so a grant of all three is answered as a bare
 * `repo:org.anthers.work`. Nothing may compare granted against requested as strings —
 * `services/atproto-scope.ts` is what reads one, and it is the only thing that should.
 *
 * Confirmed honored rather than merely accepted on bsky.social on 2026-09-11 by
 * `scripts/atproto-scope-probe.ts`, which wrote a real record with a narrower version of it.
 */
export const PUBLISH_SCOPE = `repo:${WORK_COLLECTION}?action=create&action=update&action=delete`;

/**
 * Every scope this client may EVER request, in one string.
 *
 * 🚨 **Client metadata's `scope` is the SUPERSET a client is allowed to ask for — not what
 * it asks for on any given flow.** It declared `atproto` alone until 2026-08-22, so the
 * signup intent's `atproto transition:email` was refused by the authorization server with
 * `invalid_scope: Scope "transition:email" is not declared in the client metadata`. The
 * per-flow scope is the `scope` argument to `authorize()`, and that is where the narrowing
 * belongs; this is the registration.
 *
 * ⚠️ **Declaring a scope here does NOT put it on anybody's consent screen.** The screen
 * renders what the *authorization request* asks for, so signing in still shows identity
 * alone — the property the old value was trying to protect, protected in the right place.
 *
 * 🚨 **`transition:generic` must never appear here.** It is App-Password-equivalent access
 * to a creator's whole account, and declaring it would let any future call request it
 * without a second thought. A test asserts its absence.
 *
 * ⭐ **{@link PUBLISH_SCOPE} joined it on 2026-09-11, and adding it changed no consent screen.**
 * Declaring a scope only makes it *askable*; signing in still asks for `atproto` alone and
 * still shows identity alone. This is the registration that has to happen first, because an
 * undeclared scope is refused at the authorization server with `invalid_scope` — which is how
 * `transition:email` failed on 2026-08-22, and the same mistake was available here.
 */
const DECLARED_SCOPE = `atproto ${EMAIL_SCOPE} ${PUBLISH_SCOPE}`;

/**
 * Client metadata, served at `/api/atproto/client-metadata.json` and fetched by every
 * authorization server we talk to. `client_id` MUST be the URL this document is served
 * from — that is what makes the client discoverable without registration.
 */
export function buildClientMetadata() {
	const baseUrl = getBaseUrl();

	// 🚨 An authorization server accepts exactly two shapes of `client_id`, and a plain
	// `http://localhost:8000/...` URL is NEITHER — it is not a discoverable https client and
	// not a well-formed loopback client. The SDK's own validator rejects it, which is how
	// this was found; before that, dev would have failed at the authorization server with a
	// far less obvious error. Production is https and takes the discoverable path.
	if (baseUrl.startsWith("http://")) {
		// Loopback clients are identified by a fixed origin carrying their parameters in the
		// query string, and their redirect must be a literal loopback IP — `localhost` is
		// not accepted as a redirect host.
		const port = new URL(baseUrl).port || "8000";
		const redirectUri = `http://127.0.0.1:${port}/api/atproto/callback`;
		return {
			...atprotoLoopbackClientMetadata(
				buildAtprotoLoopbackClientId({ redirect_uris: [redirectUri], scope: DECLARED_SCOPE }),
			),
			client_name: "Anthers (dev)",
		};
	}

	const clientId = process.env.ATPROTO_CLIENT_ID ?? `${baseUrl}/api/atproto/client-metadata.json`;
	return {
		client_id: clientId,
		client_name: "Anthers",
		client_uri: baseUrl,
		redirect_uris: [`${baseUrl}/api/atproto/callback`] as [string],
		scope: DECLARED_SCOPE,
		grant_types: ["authorization_code", "refresh_token"] as ["authorization_code", "refresh_token"],
		response_types: ["code"] as ["code"],
		token_endpoint_auth_method: "none" as const,
		application_type: "web" as const,
		dpop_bound_access_tokens: true as const,
	};
}

let client: OAuthClient | undefined;

/**
 * The shared client. Built lazily so importing this module never reaches the network or
 * requires configuration — the same reason `getStripe()` exists rather than a module-level
 * constant, and the same failure it avoids: "are we configured?" becoming a property of
 * the machine the tests happen to run on.
 */
export function getAtprotoClient(): OAuthClient {
	if (client) return client;
	client = new OAuthClient({
		clientMetadata: buildClientMetadata(),
		responseMode: "query",
		// DNS-over-HTTPS rather than `node:dns`, which Bun does not expose the same way and
		// which is the transitive reason the Node client cannot be used here.
		handleResolver: new AtprotoDohHandleResolver({
			dohEndpoint: process.env.ATPROTO_DOH_ENDPOINT ?? "https://cloudflare-dns.com/dns-query",
		}),
		runtimeImplementation: {
			createKey: (algs: string[]) => JoseKey.generate(algs),
			getRandomValues: (length: number) => crypto.getRandomValues(new Uint8Array(length)),
			digest: async (bytes: Uint8Array, alg: { name: string }) =>
				new Uint8Array(
					await crypto.subtle.digest(alg.name.replace("sha", "SHA-"), bytes as BufferSource),
				),
		},
		stateStore: oauthStateStore as never,
		sessionStore: oauthSessionStore as never,
	});
	return client;
}

/** Test seam, mirroring `setStripeClient()`. */
export function setAtprotoClient(next: OAuthClient | undefined): void {
	client = next;
}

/**
 * Tell the authorization server this grant is over. Best-effort, and never throws.
 *
 * 🚨 **Revoke first, delete second, everywhere.** A local row removed without a revocation
 * leaves a live OAuth authorization on somebody's Bluesky account pointing at an Anthers that
 * no longer holds anything — and once the row is gone we cannot even find it to try again.
 * The reverse order fails safely: a revocation that succeeded against a row we then failed to
 * delete leaves a dead row, which the next sign-in overwrites.
 *
 * ⚠️ **The failure is swallowed on purpose, and the reason differs by caller.** At an unlink it
 * is because the server may already consider the grant gone. At an **erasure** it is stronger
 * than that: a revocation that fails must never leave an account undeleted, because somebody
 * asked to be forgotten and a third party's outage is not a reason to refuse them.
 */
export async function revokeAtprotoGrant(did: string): Promise<void> {
	try {
		await getAtprotoClient().revoke(did);
	} catch {
		// Nothing to do about it here. Every caller deletes its local rows regardless.
	}
}
