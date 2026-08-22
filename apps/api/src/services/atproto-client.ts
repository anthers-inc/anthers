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
 * one origin there, with `/api` ingress-routed. In development they do not share an
 * origin, so the API's own port is used instead.
 */
export function getBaseUrl(): string {
	const explicit = process.env.BASE_URL;
	if (explicit) return explicit.replace(/\/+$/, "");

	if (process.env.NODE_ENV === "production") {
		const frontend = process.env.FRONTEND_URL?.replace(/\/+$/, "");
		// Fail loudly rather than emit a client identity that cannot work. A missing value
		// must never be the thing that quietly degrades a protocol identity into a local one.
		if (!frontend?.startsWith("https://")) {
			throw new Error(
				"ATProto OAuth needs an https origin: set BASE_URL, or FRONTEND_URL to the public site.",
			);
		}
		return frontend;
	}

	return "http://localhost:8000";
}

/**
 * Client metadata, served at `/api/atproto/client-metadata.json` and fetched by every
 * authorization server we talk to. `client_id` MUST be the URL this document is served
 * from — that is what makes the client discoverable without registration.
 *
 * ⚠️ `scope` is identity-only on purpose. Writing records into someone's repository needs
 * more, and as of 2026-08-21 `bsky.social` advertises only the coarse `transition:*`
 * scopes — so the write scope is `transition:generic`, which is App-Password-equivalent
 * access to a creator's entire account. That is asked for progressively, at the moment a
 * creator opts into publishing, and never at sign-in.
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
				buildAtprotoLoopbackClientId({ redirect_uris: [redirectUri], scope: "atproto" }),
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
		scope: "atproto",
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
