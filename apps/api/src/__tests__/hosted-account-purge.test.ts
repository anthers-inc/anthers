// SPDX-License-Identifier: Apache-2.0
/**
 * Giving a hosted identity back: what the node is asked, in what order, and what each refusal
 * means for the erasure that called.
 *
 * 🚨 **The outcomes are the subject, not the happy path.** `purgeHostedIdentity` answers four
 * things and the caller does something different with each — and two of them look alike from
 * out here and must not be collapsed. `unreachable` defers an erasure and tries again
 * tomorrow; `unusable` finishes the erasure and shouts. Getting those the wrong way round
 * either blocks somebody's deletion forever on a key nobody can use, or declares an erasure
 * done while their records are still on the server.
 *
 * ⭐ **Order is a behavior here rather than an implementation detail.** A deactivated
 * repository refuses writes, so records have to go before deactivation; if that inverts, the
 * purge silently stops emptying anything and still reports success.
 *
 * ⭐ **And the credential is read from the row, never handed in.** A lifecycle act presents the
 * session the hub already holds as the account's first-party client; there is no parameter a
 * caller could pass a password through, which is the shape that keeps a password out of the
 * erasure path entirely.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";

const PDS_URL = "https://anthers.test";

// 🚨 Restored afterwards, because `bun test` runs every file in one process — left set, these
// open the handle door for the rest of the suite pointed at the real node. Nothing here
// touches the network regardless: every call goes through an injected `fetchImpl`.
const before = {
	url: process.env.HOSTED_PDS_URL,
	key: process.env.HOSTED_ACCOUNT_KEY,
};

beforeAll(async () => {
	await learnHandleDomain(PDS_URL, "anthers.test");
	process.env.HOSTED_PDS_URL = PDS_URL;
	// A key generated here rather than a constant, so nothing in this repository is ever a
	// string shaped like a credential.
	process.env.HOSTED_ACCOUNT_KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
		"hex",
	);
});

afterAll(async () => {
	await db.delete(hostedAccounts).where(eq(hostedAccounts.did, DID));
	restore("HOSTED_PDS_URL", before.url);
	restore("HOSTED_ACCOUNT_KEY", before.key);
});

function restore(key: string, value: string | undefined) {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

const { purgeHostedIdentity } = await import("../services/hosted-accounts.js");
const { seal } = await import("../services/secret-box.js");
const { learnHandleDomain } = await import("./node-fixture.js");
const { db } = await import("@anthers/db");
const { hostedAccounts } = await import("@anthers/db/schema");
const { eq } = await import("drizzle-orm");

const DID = "did:plc:examplehostedidentity";
const PASSWORD = "hunter2";

/**
 * Put a credential on the DID's row, which is the only place the purge can find one.
 *
 * The default is a legacy sealed password, because that is the shape every hosted row had until
 * sessions became the credential — so exercising it here is exercising the migration case as well
 * as the ordinary one.
 */
async function seedSession(): Promise<void> {
	await db
		.update(hostedAccounts)
		.set({
			sealedSession: seal(
				JSON.stringify({
					accessJwt: "EXAMPLE-live-access-token",
					refreshJwt: "EXAMPLE-live-refresh-token",
					expiresAt: Date.now() + 3_600_000,
				}),
			),
		})
		.where(eq(hostedAccounts.did, DID));
}

async function seedCredential(sealedPassword: string = seal(PASSWORD)): Promise<void> {
	await db
		.insert(hostedAccounts)
		.values({ did: DID, handle: "alice.anthers.test", sealedPassword, sealedSession: null })
		.onConflictDoUpdate({
			target: hostedAccounts.did,
			set: { sealedPassword, sealedSession: null },
		});
}

/** What one endpoint should answer. A missing entry is an endpoint the test expects unused. */
type Route = (body: Record<string, unknown>) => { status?: number; body?: unknown };

/**
 * A fetch that routes by the XRPC method name and records the order of the calls.
 *
 * The order is recorded rather than merely the set, because two of the assertions below are
 * entirely about sequence.
 */
function nodeFetch(routes: Record<string, Route>) {
	const calls: { method: string; body: Record<string, unknown> }[] = [];
	const impl = (async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = url.pathname.replace("/xrpc/", "");
		const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
		// The query string carries the arguments of a GET, so fold it in and callers can assert
		// on one shape whichever verb the endpoint uses.
		for (const [k, v] of url.searchParams) body[k] = v;
		calls.push({ method, body });
		const route = routes[method];
		if (!route) throw new Error(`unexpected call to ${method}`);
		const { status = 200, body: answer = {} } = route(body);
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => answer,
		} as unknown as Response;
	}) as unknown as typeof fetch;
	return { impl, calls };
}

// Every case starts from a row holding the credential it is about; the cases that need a
// different one put it back themselves.
beforeEach(seedCredential);

/**
 * The endpoints a clean purge touches, with one record in one collection.
 *
 * ⚠️ **The collection is a made-up NSID rather than a real Bluesky one, deliberately.** The
 * purge does not branch on collection — it deletes whatever `describeRepo` lists, posting
 * lexicons included — so nothing is lost by naming a fixture collection, and naming a real one
 * would trip `scripts/social-posting-guard.test.ts`. That guard is a blunt string scan on
 * purpose, and a fixture is not a reason to blunt it further.
 */
function healthyNode(overrides: Record<string, Route> = {}) {
	let listed = false;
	return nodeFetch({
		"com.atproto.repo.describeRepo": () => ({
			body: { did: DID, handle: "alice.anthers.test", collections: ["com.example.note"] },
		}),
		"com.atproto.server.createSession": () => ({ body: { did: DID, accessJwt: "test-access" } }),
		"com.atproto.repo.listRecords": () => {
			if (listed) return { body: { records: [] } };
			listed = true;
			return { body: { records: [{ uri: `at://${DID}/com.example.note/abc123` }] } };
		},
		"com.atproto.repo.applyWrites": () => ({ body: {} }),
		"com.atproto.identity.updateHandle": () => ({ body: {} }),
		"com.atproto.server.updateEmail": () => ({ body: {} }),
		"com.atproto.server.deactivateAccount": () => ({ body: {} }),
		...overrides,
	});
}

describe("purgeHostedIdentity", () => {
	it("empties the repository, then renames, readdresses and deactivates", async () => {
		const { impl, calls } = healthyNode();
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome).toEqual({ status: "purged" });

		const order = calls.map((c) => c.method);
		// 🚨 The write has to land before the deactivation, because a deactivated repository
		// refuses writes — an inverted order empties nothing and still answers "purged".
		expect(order.indexOf("com.atproto.repo.applyWrites")).toBeLessThan(
			order.indexOf("com.atproto.server.deactivateAccount"),
		);
		expect(order).toContain("com.atproto.identity.updateHandle");
		expect(order).toContain("com.atproto.server.updateEmail");

		const deleted = calls.find((c) => c.method === "com.atproto.repo.applyWrites");
		expect(deleted?.body.writes).toEqual([
			{
				$type: "com.atproto.repo.applyWrites#delete",
				collection: "com.example.note",
				rkey: "abc123",
			},
		]);
	});

	// ⭐ **The session is the credential, so the erasure spends no login.** A purge that logged in
	// with a password would still pass every assertion above; what it would also do is spend one
	// of the account's limited `createSession` calls and prove the hub was still keeping a
	// credential of its own rather than using the client session it already holds.
	it("uses the session already on file, and logs in for nothing", async () => {
		const { impl, calls } = healthyNode();
		await seedSession();
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome).toEqual({ status: "purged" });
		expect(calls.map((c) => c.method)).not.toContain("com.atproto.server.createSession");
	});

	// ⭐ The name and the address are the two identifying strings in the account row, and the
	// point of replacing them is that neither carries anything of the person's afterwards.
	it("leaves nothing of the old name in either the handle or the address", async () => {
		const { impl, calls } = healthyNode();
		await purgeHostedIdentity(DID, { fetchImpl: impl });

		const handle = calls.find((c) => c.method === "com.atproto.identity.updateHandle")?.body
			.handle as string;
		const email = calls.find((c) => c.method === "com.atproto.server.updateEmail")?.body
			.email as string;

		expect(handle).toMatch(/^deleted-[0-9a-f]{8}\.anthers\.test$/);
		expect(email).toMatch(/^deleted-[0-9a-f]{8}@anthers\.test$/);
		expect(handle).not.toContain("alice");
		expect(email).not.toContain("alice");
		// One account reads as one account to whoever is looking at the node's rows.
		expect(handle.split(".")[0]).toBe(email.split("@")[0]);
	});

	it("pages through a collection with more records than one listing", async () => {
		let page = 0;
		const { impl, calls } = healthyNode({
			"com.atproto.repo.listRecords": () => {
				page += 1;
				if (page > 2) return { body: { records: [] } };
				return {
					body: {
						records: Array.from({ length: 100 }, (_, i) => ({
							uri: `at://${DID}/com.example.note/p${page}-${i}`,
						})),
					},
				};
			},
		});
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome).toEqual({ status: "purged" });
		const applied = calls.filter((c) => c.method === "com.atproto.repo.applyWrites");
		expect(applied).toHaveLength(2);
		expect(applied.flatMap((c) => c.body.writes as unknown[])).toHaveLength(200);
	});

	// An account that migrated away, or one an operator already removed. Nothing is owed and
	// nothing went wrong, so this must not read as a failure of any kind.
	it("reports an account the node does not have as absent, and asks it nothing else", async () => {
		const { impl, calls } = nodeFetch({
			"com.atproto.repo.describeRepo": () => ({ status: 400, body: { error: "RepoNotFound" } }),
		});
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome).toEqual({ status: "absent" });
		expect(calls.map((c) => c.method)).toEqual(["com.atproto.repo.describeRepo"]);
	});

	// A previous run got as far as deactivating, so the records are gone and the repository
	// will refuse writes. Finishing the rest is what makes a retry converge instead of looping.
	it("finishes the address on a repository a previous run already deactivated", async () => {
		const { impl, calls } = healthyNode({
			"com.atproto.repo.describeRepo": () => ({
				status: 400,
				body: { error: "RepoDeactivated" },
			}),
		});
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome).toEqual({ status: "purged" });
		const order = calls.map((c) => c.method);
		expect(order).toContain("com.atproto.server.updateEmail");
		// Neither is attempted against a repository that would refuse them anyway.
		expect(order).not.toContain("com.atproto.repo.applyWrites");
		expect(order).not.toContain("com.atproto.server.deactivateAccount");
	});
});

describe("purgeHostedIdentity, when it cannot finish", () => {
	// 🚨 This is the one the caller DEFERS on. The node is Anthers' own machine holding that
	// person's records, so an outage is a reason to try again rather than to call it done.
	it("reports a node that did not answer as unreachable", async () => {
		const impl = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome.status).toBe("unreachable");
	});

	it("reports a node answering 500 as unreachable rather than as a considered refusal", async () => {
		const { impl } = nodeFetch({
			"com.atproto.repo.describeRepo": () => ({ status: 500, body: { error: "InternalError" } }),
		});
		expect((await purgeHostedIdentity(DID, { fetchImpl: impl })).status).toBe("unreachable");
	});

	// 🚨 The address is the personal data in that row, so a purge that could not replace it has
	// not finished — even when the node's refusal looks final. Reporting this as done would be
	// an erasure claiming more than it did.
	it("defers when the address could not be replaced, whatever the node said", async () => {
		const { impl } = healthyNode({
			"com.atproto.server.updateEmail": () => ({
				status: 400,
				body: { error: "InvalidRequest", message: "nope" },
			}),
		});
		expect((await purgeHostedIdentity(DID, { fetchImpl: impl })).status).toBe("unreachable");
	});

	// 🚨 And this is the one the caller must NOT defer on: retrying never opens a credential
	// this deployment's key cannot open, and blocking an erasure forever is worse than
	// finishing it and saying loudly that a shell was left behind.
	it("reports a password the node rejects as unusable, not as unreachable", async () => {
		const { impl } = healthyNode({
			"com.atproto.server.createSession": () => ({
				status: 401,
				body: { error: "AuthenticationRequired" },
			}),
		});
		expect((await purgeHostedIdentity(DID, { fetchImpl: impl })).status).toBe("unusable");
	});

	it("reports a credential this key cannot open as unusable, and asks the node nothing", async () => {
		const { impl, calls } = healthyNode();
		await seedCredential("v1.aaaa.bbbb.cccc");
		const outcome = await purgeHostedIdentity(DID, { fetchImpl: impl });

		expect(outcome.status).toBe("unusable");
		// Nothing is destroyed or rewritten on the node. `describeRepo` runs first because it is
		// also how the collections are enumerated, and it costs nothing to ask.
		expect(calls.map((c) => c.method)).toEqual(["com.atproto.repo.describeRepo"]);
	});
});
