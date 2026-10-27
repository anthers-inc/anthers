// SPDX-License-Identifier: Apache-2.0
/**
 * Session arithmetic for the hosted repository writer: how many session calls a burst of writes
 * costs, and what a dead one reports.
 *
 * 🚨 **The numbers are the subject.** The reference PDS limits `createSession` to thirty in five
 * minutes and three hundred a day per account, and before `sealed_session` existed every write
 * opened one — a busy user's pooled writes exhausted their OWN login budget, after which
 * everything they did failed. ⭐ **Since the password fallback went, the write path spends no
 * `createSession` at all**: the session comes from sign-up or from a sign-in, and the store only
 * reads, renews or clears it. So each case below asserts how many times a spy fetch was asked for
 * a session endpoint, over a fake node that answers them, using the real database the same way
 * the other suites do.
 *
 * ⭐ **Tokens are minted here as `header.payload.signature` strings.** The store only decodes
 * the payload's `exp` claim and never verifies a signature — that is the node's job on the
 * other end of the fetch — so the signature need only be base64url-shaped.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { hostedAccounts } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import { hostedWriterFor } from "../services/hosted-repo-writer.js";
import { clearHostedSession, sessionForHostedAccount } from "../services/hosted-session-store.js";
import { open, seal } from "../services/secret-box.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const RUN = `hs${Date.now().toString(36)}`;
const PDS_URL = "https://node.invalid";

const TOUCHED = ["FRONTEND_URL", "HOSTED_PDS_URL", "HOSTED_ACCOUNT_KEY"] as const;
const saved = new Map<string, string | undefined>();

// A hosted identity against `https://node.invalid`, which the write guard treats as local —
// and every network call goes through the suite's injected fetch, so nothing leaves the box.
beforeAll(() => {
	for (const key of TOUCHED) saved.set(key, process.env[key]);
	delete process.env.FRONTEND_URL;
	process.env.HOSTED_PDS_URL = PDS_URL;
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterAll(() => {
	for (const key of TOUCHED) {
		const value = saved.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** A JWT whose payload carries `exp`; the signature is shape rather than security. */
function mintJwt(expSeconds: number, tag = "tok"): string {
	const b64 = (obj: object) =>
		Buffer.from(JSON.stringify(obj)).toString("base64url").replace(/=+$/, "");
	return `${b64({ alg: "ES256K" })}.${b64({ exp: expSeconds })}.${Buffer.from(tag).toString("base64url")}`;
}

/** An access token with an hour of life, and its refresh companion. */
function freshPair(tag: string): { accessJwt: string; refreshJwt: string } {
	return {
		accessJwt: mintJwt(Math.floor(Date.now() / 1000) + 3600, `${tag}-access`),
		refreshJwt: mintJwt(Math.floor(Date.now() / 1000) + 86400, `${tag}-refresh`),
	};
}

/** An access token already past its life, so the store must renew rather than reuse it. */
function expiredPair(tag: string): { accessJwt: string; refreshJwt: string } {
	return {
		accessJwt: mintJwt(Math.floor(Date.now() / 1000) - 60, `${tag}-access`),
		refreshJwt: mintJwt(Math.floor(Date.now() / 1000) + 86400, `${tag}-refresh`),
	};
}

/** What one endpoint should answer; a missing route throws, so an unexpected call fails loudly. */
/** A route answers synchronously, or — to hold a gate open for the mutex test — with a promise. */
type Route = (
	body: Record<string, unknown>,
	auth: string | null,
) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;

/**
 * A fetch against the fake node that routes by XRPC method and records each call — method,
 * bearer token (which is how refresh is told from login), and body.
 */
function nodeFetch(routes: Record<string, Route>) {
	const calls: { method: string; auth: string | null; body: Record<string, unknown> }[] = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = url.pathname.replace("/xrpc/", "");
		const headers = (init?.headers ?? {}) as Record<string, string>;
		const auth = headers.Authorization?.replace(/^Bearer /, "") ?? null;
		// 🚨 **The node refuses a body on `refreshSession`, and the fake has to as well.** It is a
		// procedure with no input; the real PDS answers "A request body was provided when none was
		// expected" as a 400, which the store would read as a revoked session — a bug this suite
		// missed while the fake accepted anything. Pinned here so it cannot come back.
		if (method === "com.atproto.server.refreshSession" && init?.body) {
			return {
				ok: false,
				status: 400,
				json: async () => ({
					error: "InvalidRequest",
					message: "A request body was provided when none was expected",
				}),
			} as unknown as Response;
		}
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		calls.push({ method, auth, body });
		const route = routes[method];
		if (!route) throw new Error(`unexpected call to ${method}`);
		const { status = 200, body: answer = {} } = await route(body, auth);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => answer,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

const SESSION_ENDPOINTS = ["com.atproto.server.createSession", "com.atproto.server.refreshSession"];

/** Just the session traffic — the writes are not what this suite counts. */
function sessionCalls(calls: { method: string }[]) {
	return calls.filter((c) => SESSION_ENDPOINTS.includes(c.method));
}

const dids: string[] = [];

afterAll(async () => {
	// Keyed on the DID rather than the user row, because `purgeAccountsCreatedHere` may delete
	// the users first (hook order), and then there would be nothing left to select by.
	if (dids.length) await db.delete(hostedAccounts).where(inArray(hostedAccounts.did, dids));
});

/**
 * A hosted account whose credential opens under THIS suite's key, so a refusal under test is
 * about the node's answer rather than the seal. Tracks the user for the account sweep above
 * (the hosted_accounts rows go now, for the one-writer bookkeeping).
 */
async function hostedCreator(tag: string): Promise<{ userId: number; did: string }> {
	const account = await createAccount(`${RUN}${tag}`);
	dids.push(account.did);
	await db
		.update(hostedAccounts)
		.set({ sealedSession: null })
		.where(eq(hostedAccounts.did, account.did));
	return { userId: account.userId, did: account.did };
}

/** Store a session on the account, the way a previous open would have. */
async function seedSession(
	did: string,
	pair: { accessJwt: string; refreshJwt: string },
	expiresAt: number,
): Promise<void> {
	await db
		.update(hostedAccounts)
		.set({
			sealedSession: seal(
				JSON.stringify({
					accessJwt: pair.accessJwt,
					refreshJwt: pair.refreshJwt,
					expiresAt,
				}),
			),
		})
		.where(eq(hostedAccounts.did, did));
}

/** What the store has on file for a DID, opened, or null. For asserting persistence. */
async function storedSession(
	did: string,
): Promise<{ accessJwt: string; refreshJwt: string; expiresAt: number } | null> {
	const [row] = await db
		.select({ sealedSession: hostedAccounts.sealedSession })
		.from(hostedAccounts)
		.where(eq(hostedAccounts.did, did))
		.limit(1);
	if (!row?.sealedSession) return null;
	return JSON.parse(open(row.sealedSession));
}

describe("the hosted session store", () => {
	// 🚨 The case the whole module exists for: a busy user's writes must not each spend a login.
	// ⭐ Since the password fallback went, they spend *none at all* — the session is written when
	// the identity is created and replaced when the person signs in, and nothing in the write path
	// can open a new one.
	it("spends no session call at all on a burst of opens for one account", async () => {
		const { userId, did } = await hostedCreator("burst");
		await seedSession(did, freshPair("burst"), Date.now() + 3_600_000);
		const node = nodeFetch({
			"com.atproto.repo.putRecord": () => ({
				body: { uri: "at://did/x/y", cid: "bafy" },
			}),
		});
		// ⚠️ New fetch per open, as production does — `hostedWriterFor` reuses the STORE, not
		// the transport. A shared spy is what would accidentally make the counting trivial.
		for (let i = 0; i < 4; i++) {
			const opened = await hostedWriterFor(userId, { fetchImpl: node.impl });
			expect(opened).toHaveProperty("writer.did");
			if (opened.writer) {
				await opened.writer.putRecord("org.anthers.post", `r${i}`, {});
			}
		}
		expect(sessionCalls(node.calls)).toEqual([]);
	});

	it("asks the node for NOTHING when a live access token is on file", async () => {
		const { userId, did } = await hostedCreator("live");
		const pair = freshPair("live");
		await seedSession(did, pair, Date.now() + 3_600_000);
		const node = nodeFetch({
			"com.atproto.repo.putRecord": () => ({ body: { uri: "at://did/x/y", cid: "bafy" } }),
		});
		const opened = await hostedWriterFor(userId, { fetchImpl: node.impl });
		expect(opened).toHaveProperty("writer.did");
		if (opened.writer) await opened.writer.putRecord("org.anthers.post", "r", {});
		expect(sessionCalls(node.calls)).toEqual([]);
	});

	it("renews an expired access token with refreshSession alone (no login)", async () => {
		const { did, userId } = await hostedCreator("refresh");
		const old = expiredPair("refresh");
		const rotated = freshPair("refresh-new");
		await seedSession(did, old, Date.now() - 60_000);
		const node = nodeFetch({
			"com.atproto.server.refreshSession": () => ({ body: { ...rotated } }),
			"com.atproto.repo.putRecord": () => ({ body: { uri: "at://did/x/y", cid: "bafy" } }),
		});
		const opened = await hostedWriterFor(userId, { fetchImpl: node.impl });
		expect(opened).toHaveProperty("writer.did");
		expect(sessionCalls(node.calls)).toEqual([
			expect.objectContaining({
				method: "com.atproto.server.refreshSession",
				// The refresh token goes as the bearer, per the protocol.
				auth: old.refreshJwt,
			}),
		]);
		// ⚠️ The ROTATED pair is what's on file now — the node invalidates the refresh token it
		// just consumed, so persisting the old one would leave the next open refreshing with a
		// token that is already dead.
		const stored = await storedSession(did);
		expect(stored).toMatchObject({
			accessJwt: rotated.accessJwt,
			refreshJwt: rotated.refreshJwt,
		});
	});

	// 🚨 **A refused refresh is final now.** The node's considered 4xx means the pair is dead, and
	// with no stored password there is nothing to log in with — so this reports a lost
	// authorization rather than spending a call that could only fail.
	it("reports a refused refresh as a lost authorization, and spends no login", async () => {
		const { did } = await hostedCreator("refused");
		const old = expiredPair("refused");
		await seedSession(did, old, Date.now() - 60_000);
		const node = nodeFetch({
			"com.atproto.server.refreshSession": () => ({
				status: 401,
				body: { error: "ExpiredToken", message: "refresh revoked" },
			}),
		});
		const result = await sessionForHostedAccount(did, { fetchImpl: node.impl });
		expect(result).toEqual({ token: null, error: "authorization_lost", authorizationLost: true });
		expect(sessionCalls(node.calls)).toEqual([
			expect.objectContaining({ method: "com.atproto.server.refreshSession" }),
		]);
		// And the dead pair is gone rather than left to be retried.
		expect(await storedSession(did)).toBeNull();
	});

	// ⚠️ **An outage is not a lost authorization**, and the difference decides whether a job
	// retries: a node that could not answer is worth trying again, and the session stays on file.
	it("reports an unreachable refresher as an outage, keeping the pair", async () => {
		const { did } = await hostedCreator("down");
		await seedSession(did, expiredPair("down"), Date.now() - 60_000);
		const node = nodeFetch({
			"com.atproto.server.refreshSession": () => {
				throw new Error("connection refused");
			},
		});
		const result = await sessionForHostedAccount(did, { fetchImpl: node.impl });
		expect(result.token).toBeNull();
		expect(result.token === null && result.error).toContain("refreshSession");
		expect(result.token === null && result.authorizationLost).toBeUndefined();
		expect(await storedSession(did), "an outage must not discard the pair").not.toBeNull();
	});

	it("runs two concurrent opens through ONE refresh (the per-DID mutex)", async () => {
		const { did } = await hostedCreator("race");
		const pair = freshPair("race");
		await seedSession(did, expiredPair("race-old"), Date.now() - 60_000);
		let renewResolver: (() => void) | null = null;
		const node = nodeFetch({
			"com.atproto.server.refreshSession": () => {
				// Hold the gate until BOTH opens have arrived at the store; without the mutex the
				// second open would block on this route too — and the test would hang, not count.
				return new Promise<{ body: object }>((resolve) => {
					renewResolver = () => resolve({ body: { ...pair } });
				});
			},
		});
		const first = sessionForHostedAccount(did, { fetchImpl: node.impl });
		const second = sessionForHostedAccount(did, { fetchImpl: node.impl });
		// Let both callers reach the store before the node answers.
		await new Promise((r) => setTimeout(r, 50));
		renewResolver!();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toEqual({ token: pair.accessJwt });
		expect(b).toEqual({ token: pair.accessJwt });
		expect(sessionCalls(node.calls)).toEqual([
			expect.objectContaining({ method: "com.atproto.server.refreshSession" }),
		]);
	});

	it("clears the stored session on a mid-session 401, and the next open says what it is", async () => {
		const { userId, did } = await hostedCreator("mid401");
		const dead = freshPair("mid401-dead");
		const fresh = freshPair("mid401-new");
		await seedSession(did, dead, Date.now() + 3_600_000);
		const node = nodeFetch({
			"com.atproto.repo.putRecord": (_body, auth) => {
				if (auth === dead.accessJwt) {
					return { status: 401, body: { error: "ExpiredToken", message: "token died" } };
				}
				return { body: { uri: "at://did/x/y", cid: "bafy" } };
			},
			"com.atproto.server.createSession": () => ({ body: { ...fresh } }),
		});

		// First write with the dead token: still THROWS (throw-to-retry is the contract), ...
		const opened = await hostedWriterFor(userId, { fetchImpl: node.impl });
		expect(opened).toHaveProperty("writer.did");
		if (opened.writer) {
			await expect(opened.writer.putRecord("org.anthers.post", "r", {})).rejects.toThrow(
				/putRecord: ExpiredToken/,
			);
		}
		// ... but the dead session is gone from the store.
		expect(await storedSession(did)).toBeNull();

		// 🚨 **The NEXT open reports a lost authorization rather than logging in.** There is no
		// second credential to present, so the honest answer is that the person has to sign in
		// again — not a silent `createSession` that would fail against the same dead account.
		const reopened = await hostedWriterFor(userId, { fetchImpl: node.impl });
		expect(reopened).toEqual({ writer: null, reason: "authorization_lost" });
		expect(sessionCalls(node.calls)).toEqual([]);
	});

	it("maps a row with no session onto the writer's own reason", async () => {
		const { userId, did } = await hostedCreator("nosession");
		// ⚠️ No fetch route at all: a row with nothing sealed must not reach the network.
		const node = nodeFetch({});
		const result = await sessionForHostedAccount(did, { fetchImpl: node.impl });
		expect(result).toEqual({ token: null, error: "authorization_lost", authorizationLost: true });

		const opened = await hostedWriterFor(userId, { fetchImpl: node.impl });
		expect(opened).toEqual({ writer: null, reason: "authorization_lost" });
		expect(node.calls).toEqual([]);
	});
});

describe("clearHostedSession", () => {
	it("removes what the store persisted", async () => {
		const { did } = await hostedCreator("clear");
		await seedSession(did, freshPair("clear"), Date.now() + 3_600_000);
		expect(await storedSession(did)).not.toBeNull();
		await clearHostedSession(did);
		expect(await storedSession(did)).toBeNull();
	});
});
