// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ATProto OAuth: the client builds under Bun, its stores survive a restart, and the
 * signup door stays shut.
 *
 * 🚨 The first test is the load-bearing one and it looks trivial. `@atproto/oauth-client-node`
 * — the package every guide reaches for — throws at IMPORT time under Bun, from a
 * transitive `undici` expectation. Anything that swaps this back to the Node client fails
 * here rather than in production, which is the only reason a bare construction is worth
 * asserting.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoOauthState, atprotoSessions, users } from "@anthers/db/schema";
import { JoseKey } from "@atproto/jwk-jose";
import { eq, like } from "drizzle-orm";
import { createUserFromAtproto, resolveIdentity } from "../services/atproto.js";
import {
	attachSessionToUser,
	buildClientMetadata,
	getAtprotoClient,
	oauthSessionStore,
	oauthStateStore,
	setAtprotoClient,
	sweepExpiredOauthState,
} from "../services/atproto-client.js";

const RUN = `t${Date.now().toString(36)}`;
const testKeys: string[] = [];
const testDids: string[] = [];

afterAll(async () => {
	for (const k of testKeys) await db.delete(atprotoOauthState).where(eq(atprotoOauthState.key, k));
	for (const d of testDids) await db.delete(atprotoSessions).where(eq(atprotoSessions.did, d));
	await db.delete(users).where(like(users.username, `${RUN}%`));
	await db.delete(users).where(like(users.email, `%${RUN}%`));
});

describe("client construction under Bun", () => {
	it("builds an OAuthClient without the Node package", () => {
		const client = getAtprotoClient();
		expect(client).toBeDefined();
		expect(client.clientMetadata.client_id).toBeTruthy();
	});

	it("uses the loopback client_id shape in dev and the discoverable one in prod", () => {
		// 🚨 A plain `http://localhost:8000/...` client_id is neither shape and the SDK
		// rejects it. Dev must be a loopback client whose redirect is a literal 127.0.0.1;
		// prod must be the https URL the metadata document is served from.
		const prev = process.env.BASE_URL;
		try {
			process.env.BASE_URL = "http://localhost:8000";
			const dev = buildClientMetadata();
			expect(dev.client_id.startsWith("http://localhost?")).toBe(true);
			expect(dev.redirect_uris[0]).toBe("http://127.0.0.1:8000/api/atproto/callback");

			process.env.BASE_URL = "https://anthers.org";
			const prod = buildClientMetadata();
			expect(prod.client_id).toBe("https://anthers.org/api/atproto/client-metadata.json");
			expect(prod.redirect_uris[0]).toBe("https://anthers.org/api/atproto/callback");
		} finally {
			if (prev === undefined) delete process.env.BASE_URL;
			else process.env.BASE_URL = prev;
		}
	});

	it("refuses to build a production client identity from a non-https origin", () => {
		// 🚨 Production has no BASE_URL, and the old code fell back to localhost — so the
		// metadata document advertised a client_id no authorization server would accept.
		// Failing loudly is the point: a missing value must not degrade a protocol identity.
		const prevBase = process.env.BASE_URL;
		const prevFront = process.env.FRONTEND_URL;
		const prevNode = process.env.NODE_ENV;
		try {
			delete process.env.BASE_URL;
			process.env.NODE_ENV = "production";

			delete process.env.FRONTEND_URL;
			expect(() => buildClientMetadata()).toThrow(/https origin/);

			process.env.FRONTEND_URL = "http://anthers.org";
			expect(() => buildClientMetadata()).toThrow(/https origin/);

			process.env.FRONTEND_URL = "https://anthers.org";
			expect(buildClientMetadata().client_id).toBe(
				"https://anthers.org/api/atproto/client-metadata.json",
			);
		} finally {
			for (const [k, v] of [
				["BASE_URL", prevBase],
				["FRONTEND_URL", prevFront],
				["NODE_ENV", prevNode],
			] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("serves identity-only scope in its client metadata", () => {
		// Writing records needs more than this, and asking for it at sign-in is the thing
		// being guarded against — `transition:generic` is App-Password-equivalent access.
		const prev = process.env.BASE_URL;
		process.env.BASE_URL = "https://anthers.org";
		try {
			expect(buildClientMetadata().scope).toBe("atproto");
			expect(buildClientMetadata().dpop_bound_access_tokens).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.BASE_URL;
			else process.env.BASE_URL = prev;
		}
	});
});

describe("oauth state store", () => {
	it("round-trips a DPoP key through Postgres", async () => {
		const key = `${RUN}-state-1`;
		testKeys.push(key);
		const dpopKey = await JoseKey.generate(["ES256"]);

		await oauthStateStore.set(key, {
			iss: "https://bsky.social",
			dpopKey,
			verifier: "v",
			authMethod: "none",
			appState: JSON.stringify({ intent: "link", userId: 7 }),
		});

		const back = await oauthStateStore.get(key);
		expect(back).toBeDefined();
		// The key must come back as a usable Key, not the JWK it was stored as — that
		// conversion is the whole job of the store wrapper.
		expect(typeof back.dpopKey.privateJwk).toBe("object");
		expect(back.appState).toBe(JSON.stringify({ intent: "link", userId: 7 }));
		expect(back.iss).toBe("https://bsky.social");
	});

	it("survives a process restart, which the previous in-memory Map did not", async () => {
		const key = `${RUN}-state-2`;
		testKeys.push(key);
		await oauthStateStore.set(key, {
			iss: "https://bsky.social",
			dpopKey: await JoseKey.generate(["ES256"]),
			verifier: "v",
			authMethod: "none",
		});
		// Reading it back through a *fresh* read path is the closest a single process gets
		// to "another instance handled the callback": the row is the only carrier.
		const [row] = await db
			.select()
			.from(atprotoOauthState)
			.where(eq(atprotoOauthState.key, key))
			.limit(1);
		expect(row).toBeDefined();
		expect((row.state as Record<string, unknown>).dpopJwk).toBeDefined();
	});

	it("deletes expired rows and keeps fresh ones", async () => {
		const stale = `${RUN}-stale`;
		const fresh = `${RUN}-fresh`;
		testKeys.push(stale, fresh);
		await db.insert(atprotoOauthState).values([
			{ key: stale, state: {}, createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
			{ key: fresh, state: {} },
		]);

		await sweepExpiredOauthState();

		const rows = await db
			.select({ key: atprotoOauthState.key })
			.from(atprotoOauthState)
			.where(like(atprotoOauthState.key, `${RUN}%`));
		const keys = rows.map((r) => r.key);
		expect(keys).toContain(fresh);
		expect(keys).not.toContain(stale);
	});

	it("treats an expired row as absent even before the sweep runs", async () => {
		const key = `${RUN}-expired-read`;
		testKeys.push(key);
		await db
			.insert(atprotoOauthState)
			.values({ key, state: {}, createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) });
		expect(await oauthStateStore.get(key)).toBeUndefined();
	});
});

describe("session store", () => {
	it("is keyed by DID and can precede the account it belongs to", async () => {
		const did = `did:plc:${RUN}sess`;
		testDids.push(did);

		// This is the login-path ordering: the SDK stores the session by token subject
		// before any Anthers account exists to attach it to.
		await oauthSessionStore.set(did, {
			dpopKey: await JoseKey.generate(["ES256"]),
			tokenSet: { sub: did, access_token: "a" },
		});
		const [row] = await db.select().from(atprotoSessions).where(eq(atprotoSessions.did, did));
		expect(row).toBeDefined();
		expect(row.userId).toBeNull();

		const [user] = await db
			.insert(users)
			.values({ username: `${RUN}u`, email: `${RUN}@example.test`, emailVerified: false })
			.returning();
		await attachSessionToUser(did, user.id);

		const [linked] = await db.select().from(atprotoSessions).where(eq(atprotoSessions.did, did));
		expect(linked.userId).toBe(user.id);
	});
});

describe("signup gate", () => {
	const identity = { did: `did:plc:${RUN}new`, handle: "someone.bsky.social", pdsUrl: "https://x" };

	it("refuses to create an account when signup is not explicitly enabled", async () => {
		const prev = process.env.ATPROTO_SIGNUP_ENABLED;
		process.env.ATPROTO_SIGNUP_ENABLED = undefined as never;
		delete process.env.ATPROTO_SIGNUP_ENABLED;
		try {
			const result = await createUserFromAtproto(identity);
			expect(result.error).toBe("signup_disabled");
			expect(result.user).toBeUndefined();
			const rows = await db.select().from(users).where(eq(users.atprotoDid, identity.did));
			expect(rows.length).toBe(0);
		} finally {
			if (prev === undefined) delete process.env.ATPROTO_SIGNUP_ENABLED;
			else process.env.ATPROTO_SIGNUP_ENABLED = prev;
		}
	});

	it('refuses on any value other than the literal "true"', async () => {
		const prev = process.env.ATPROTO_SIGNUP_ENABLED;
		process.env.ATPROTO_SIGNUP_ENABLED = "1";
		try {
			expect((await createUserFromAtproto(identity)).error).toBe("signup_disabled");
		} finally {
			if (prev === undefined) delete process.env.ATPROTO_SIGNUP_ENABLED;
			else process.env.ATPROTO_SIGNUP_ENABLED = prev;
		}
	});
});

describe("identity resolution", () => {
	afterAll(() => setAtprotoClient(undefined));

	it("refuses to store the resolver's handle.invalid sentinel as a handle", async () => {
		setAtprotoClient({
			identityResolver: {
				resolve: async () => ({
					did: "did:plc:abc",
					handle: "handle.invalid",
					didDoc: { service: [] },
				}),
			},
		} as never);
		const identity = await resolveIdentity("did:plc:abc");
		expect(identity.handle).toBe("");
		expect(identity.did).toBe("did:plc:abc");
	});

	it("keeps a handle that did verify", async () => {
		setAtprotoClient({
			identityResolver: {
				resolve: async () => ({
					did: "did:plc:abc",
					handle: "real.bsky.social",
					didDoc: {
						service: [
							{
								id: "#atproto_pds",
								type: "AtprotoPersonalDataServer",
								serviceEndpoint: "https://pds.example",
							},
						],
					},
				}),
			},
		} as never);
		const identity = await resolveIdentity("did:plc:abc");
		expect(identity.handle).toBe("real.bsky.social");
		expect(identity.pdsUrl).toBe("https://pds.example/");
	});
});
