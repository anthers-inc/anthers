// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Asking a creator for permission to publish their listings, and remembering the answer.
 *
 * 🚨 **Three refusals carry the weight here, and all three protect somebody other than the
 * person pressing the button.** The flow must authorize against the DID already on the
 * account rather than a handle the browser supplied; the callback must refuse an identity
 * that is not the one linked; and signing in must go on asking for identity alone however
 * much permission the account has already given. The first two stop a catalog being written
 * into a stranger's repository, and the third is the promise that a write permission is never
 * put in front of somebody who came to sign in.
 *
 * ⭐ **The fourth is quieter and is the one nothing else would catch.** One OAuth session is
 * stored per DID, so each authorization replaces the last — which means signing in after
 * granting publishing leaves an identity-only token behind. What is recorded has to narrow
 * with it, because a column claiming a permission the token does not carry would turn a
 * revocation nobody intended into a listing that silently stopped updating.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, users, works } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import { publishingStateFor } from "../services/atproto.js";
import {
	buildClientMetadata,
	grantedScopeFor,
	PUBLISH_SCOPE,
	setAtprotoClient,
} from "../services/atproto-client.js";
import { createSession } from "../services/auth.js";
import { oauthWriterFor } from "../services/oauth-repo-writer.js";
import { stopPublishingFor } from "../services/work-listing.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `pb${Date.now().toString(36)}`;
const did = (tag: string) => `did:plc:${RUN}${tag}`;

/** The full grant, spelled the way an authorization server answers it — see `atproto-scope`. */
const GRANTED = "atproto repo:org.anthers.work";

let lastAuthorize: { input: string; options: { state?: string; scope?: string } } | undefined;
let nextCallback: { did: string; state?: string; scope?: string } | undefined;
const revoked: string[] = [];

const realFetch = globalThis.fetch;

beforeAll(() => {
	// The same one-object fake `atproto-login.test.ts` uses, plus the two things this flow
	// touches that a sign-in does not: a session that will say what it was granted, and a
	// `revoke` for handing the permission back.
	setAtprotoClient({
		authorize: async (input: string, options: { state?: string; scope?: string }) => {
			lastAuthorize = { input, options };
			return new URL("https://bsky.social/oauth/authorize?fake=1");
		},
		callback: async () => {
			if (!nextCallback) throw new Error("no callback staged");
			const staged = nextCallback;
			return {
				session: {
					did: staged.did,
					getTokenInfo: async () => ({ scope: staged.scope ?? "atproto" }),
				},
				state: staged.state,
			};
		},
		revoke: async (sub: string) => void revoked.push(sub),
		identityResolver: {
			resolve: async (didOrHandle: string) => ({
				did: didOrHandle,
				handle: `${RUN}.bsky.social`,
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

	globalThis.fetch = Object.assign(
		async () => new Response("{}", { headers: { "Content-Type": "application/json" } }),
		{ preconnect: realFetch.preconnect },
	);
	process.env.ATPROTO_PUBLISH_ENABLED = "true";
});

afterAll(async () => {
	setAtprotoClient(undefined);
	globalThis.fetch = realFetch;
	delete process.env.ATPROTO_PUBLISH_ENABLED;
	await db.delete(atprotoSessions).where(like(atprotoSessions.did, `did:plc:${RUN}%`));
	await db.delete(users).where(like(users.email, `${RUN}%`));
});

async function makeUser(tag: string, values: Partial<typeof users.$inferInsert> = {}) {
	const [user] = await db
		.insert(users)
		.values({
			username: `${RUN}${tag}`,
			email: `${RUN}${tag}@example.test`,
			emailVerified: true,
			isCreator: true,
			...values,
		})
		.returning();
	return user;
}

/** A signed-in POST to the auth initiation, which CSRF requires a real Origin for. */
async function startAuth(body: unknown, token?: string) {
	return app.request("/api/atproto/auth", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "http://localhost:3000",
			...(token ? { Cookie: `session=${token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

async function runCallback(staged: { did: string; state?: string; scope?: string }): Promise<URL> {
	nextCallback = staged;
	const res = await app.request("/api/atproto/callback?code=x&state=y&iss=https://bsky.social");
	expect(res.status).toBe(302);
	return new URL(res.headers.get("location") as string);
}

/** A row the SDK would have written before our code records anything against it. */
async function seedSession(d: string, userId?: number) {
	await db.insert(atprotoSessions).values({ did: d, userId, session: {} }).onConflictDoNothing();
}

describe("what the client is allowed to ask for", () => {
	it("declares the publishing permission, narrowly, and still no write-everything scope", () => {
		const prev = process.env.BASE_URL;
		process.env.BASE_URL = "https://anthers.org";
		try {
			const scope = buildClientMetadata().scope ?? "";
			expect(scope).toContain(PUBLISH_SCOPE);
			// 🚨 One collection, named. A `repo:*` here would be a permission over every record
			// the creator will ever own, which is the thing this whole design exists to avoid.
			expect(PUBLISH_SCOPE).toContain("org.anthers.work");
			expect(scope).not.toContain("repo:*");
			expect(scope).not.toContain("transition:generic");
		} finally {
			if (prev === undefined) delete process.env.BASE_URL;
			else process.env.BASE_URL = prev;
		}
	});
});

describe("asking for the permission", () => {
	it("authorizes against the DID on the account, never the handle in the request", async () => {
		const user = await makeUser("sub", { atprotoDid: did("sub"), atprotoHandle: "me.bsky.social" });
		const token = await createSession(user.id, undefined, undefined);

		const res = await startAuth(
			// 🚨 A handle belonging to somebody else entirely. It must not be resolved.
			{ handle: "victim.bsky.social", intent: "publish" },
			token,
		);
		expect(res.status).toBe(200);
		expect(lastAuthorize?.input).toBe(did("sub"));
		expect(lastAuthorize?.options.scope).toBe(`atproto ${PUBLISH_SCOPE}`);
	});

	it("still asks for identity alone when the same account signs in", async () => {
		// ⭐ The invariant the whole feature is built around: holding a publishing grant must
		// not change what a sign-in puts on anybody's consent screen.
		await startAuth({ handle: "me.bsky.social", intent: "login" });
		expect(lastAuthorize?.options.scope).toBe("atproto");
	});

	it("refuses an account with no linked identity", async () => {
		const user = await makeUser("bare");
		const token = await createSession(user.id, undefined, undefined);
		const res = await startAuth({ handle: "me.bsky.social", intent: "publish" }, token);
		expect(res.status).toBe(409);
	});

	it("refuses when nobody is signed in", async () => {
		const res = await startAuth({ handle: "me.bsky.social", intent: "publish" });
		expect(res.status).toBe(401);
	});

	it("refuses while the door is shut, without sending anybody to Bluesky first", async () => {
		const user = await makeUser("shut", { atprotoDid: did("shut") });
		const token = await createSession(user.id, undefined, undefined);
		delete process.env.ATPROTO_PUBLISH_ENABLED;
		try {
			const res = await startAuth({ handle: "me.bsky.social", intent: "publish" }, token);
			expect(res.status).toBe(403);
		} finally {
			process.env.ATPROTO_PUBLISH_ENABLED = "true";
		}
	});
});

describe("coming back from the consent screen", () => {
	it("records the grant and reports it", async () => {
		const user = await makeUser("yes", { atprotoDid: did("yes") });
		await seedSession(did("yes"), user.id);

		const url = await runCallback({
			did: did("yes"),
			scope: GRANTED,
			state: JSON.stringify({ intent: "publish", userId: user.id }),
		});
		expect(url.searchParams.get("success")).toBe("publishing");
		expect(await grantedScopeFor(did("yes"))).toBe(GRANTED);

		const state = await publishingStateFor(user.id);
		expect(state.route).toBe("granted");
	});

	it("treats a decline as an answer, and records what actually came back", async () => {
		const user = await makeUser("no", { atprotoDid: did("no") });
		await seedSession(did("no"), user.id);

		const url = await runCallback({
			did: did("no"),
			// The authorization server handing back less than was asked for.
			scope: "atproto",
			state: JSON.stringify({ intent: "publish", userId: user.id }),
		});
		expect(url.searchParams.get("success")).toBe("publish_declined");
		expect(url.searchParams.get("error")).toBeNull();
		expect(await grantedScopeFor(did("no"))).toBe("atproto");
		expect((await publishingStateFor(user.id)).route).toBe("available");
	});

	it("refuses an identity that is not the one linked to the account", async () => {
		// 🚨 Somebody signed in as themselves who authorizes as a different Bluesky account.
		// Granting anyway would point this creator's catalog at that account's repository.
		const user = await makeUser("mix", { atprotoDid: did("mix") });
		await seedSession(did("stranger"));

		const url = await runCallback({
			did: did("stranger"),
			scope: GRANTED,
			state: JSON.stringify({ intent: "publish", userId: user.id }),
		});
		expect(url.searchParams.get("error")).toBe("wrong_identity");
		expect((await publishingStateFor(user.id)).route).toBe("available");
	});

	it("refuses an account whose identity Anthers hosts", async () => {
		const user = await makeUser("host", { atprotoDid: did("host") });
		await seedSession(did("host"), user.id);
		const { hostedAccounts } = await import("@anthers/db/schema");
		await db
			.insert(hostedAccounts)
			.values({
				userId: user.id,
				did: did("host"),
				handle: "h.anthers.social",
				sealedPassword: "x",
			})
			.onConflictDoNothing();

		const url = await runCallback({
			did: did("host"),
			scope: GRANTED,
			state: JSON.stringify({ intent: "publish", userId: user.id }),
		});
		expect(url.searchParams.get("error")).toBe("hosted");
		await db.delete(hostedAccounts).where(eq(hostedAccounts.userId, user.id));
	});

	// 🚨 The quiet one. Nothing else in the system would notice this happening.
	it("narrows the record when a later sign-in replaces the session", async () => {
		const user = await makeUser("nar", { atprotoDid: did("nar") });
		await seedSession(did("nar"), user.id);

		await runCallback({
			did: did("nar"),
			scope: GRANTED,
			state: JSON.stringify({ intent: "publish", userId: user.id }),
		});
		expect((await publishingStateFor(user.id)).route).toBe("granted");

		// The same person signing in with Bluesky a week later. The token that replaces the
		// stored one carries identity alone, and what is recorded has to say so.
		await runCallback({
			did: did("nar"),
			scope: "atproto",
			state: JSON.stringify({ intent: "login" }),
		});
		expect(await grantedScopeFor(did("nar"))).toBe("atproto");
		expect((await publishingStateFor(user.id)).route).toBe("available");
	});
});

describe("opening a writer over a creator's own grant", () => {
	it("is quiet about an account with no identity", async () => {
		const user = await makeUser("none");
		expect(await oauthWriterFor(user.id)).toEqual({ writer: null, reason: "no_identity" });
	});

	it("is quiet about an identity that has granted nothing", async () => {
		const user = await makeUser("ung", { atprotoDid: did("ung") });
		await seedSession(did("ung"), user.id);
		expect(await oauthWriterFor(user.id)).toEqual({ writer: null, reason: "not_granted" });
	});

	it("is quiet about a grant that covers only some of the actions", async () => {
		// ⚠️ Create and delete but not update — the probe's own scope. A listing could go up
		// and come down and could never be corrected, so this is not a usable grant.
		const user = await makeUser("half", { atprotoDid: did("half") });
		await seedSession(did("half"), user.id);
		await db
			.update(atprotoSessions)
			.set({ scope: "atproto repo:org.anthers.work?action=create&action=delete" })
			.where(eq(atprotoSessions.did, did("half")));
		expect(await oauthWriterFor(user.id)).toEqual({ writer: null, reason: "not_granted" });
	});
});

describe("handing the permission back", () => {
	it("revokes when there is nothing on the network to take down", async () => {
		const user = await makeUser("quit", { atprotoDid: did("quit") });
		await seedSession(did("quit"), user.id);

		const result = await stopPublishingFor(user.id);
		expect(result).toEqual({ removed: 0, stranded: 0, revoked: true });
		expect(revoked).toContain(did("quit"));
		expect((await publishingStateFor(user.id)).route).toBe("available");
	});

	// 🚨 The rule the whole ordering exists for. Deleting a record needs the permission being
	// handed back, so a revocation that ran anyway would leave this listing advertising a Work
	// to a network Anthers could no longer reach — for good, with nothing anybody could press.
	it("keeps the permission when a listing could not be taken down", async () => {
		const user = await makeUser("strand", { atprotoDid: did("strand") });
		await seedSession(did("strand"), user.id);
		const work = await insertWork({ creatorId: user.id, type: "game" });
		await db
			.update(works)
			.set({ atprotoUri: `at://${did("strand")}/org.anthers.work/abc123` })
			.where(eq(works.id, work.id));

		// No grant on file, so no writer can be opened — the state a creator who revoked at
		// Bluesky first would arrive in.
		const result = await stopPublishingFor(user.id);
		expect(result).toEqual({ removed: 0, stranded: 1, revoked: false });
		expect(revoked).not.toContain(did("strand"));

		// ⚠️ And the column still remembers where the record is, which is the only thing that
		// makes finishing the job possible after the creator grants again.
		const [row] = await db
			.select({ uri: works.atprotoUri })
			.from(works)
			.where(eq(works.id, work.id));
		expect(row.uri).toBe(`at://${did("strand")}/org.anthers.work/abc123`);

		await db.delete(works).where(eq(works.id, work.id));
	});
});
