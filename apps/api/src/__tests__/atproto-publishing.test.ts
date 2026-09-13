// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Asking a creator for permission to publish their listings, and remembering the answer.
 *
 * 🚨 **Two refusals carry the weight, and both protect somebody other than the person pressing
 * the button.** The flow must authorize against the DID already on the account rather than a
 * handle the browser supplied, and the callback must refuse an identity that is not the one
 * linked. Either one missing puts a creator's catalog in a stranger's repository.
 *
 * ⭐ **The pair about what a sign-in asks for is the subtler half, and an earlier version of
 * this file asserted the wrong one of them.** One OAuth session is stored per DID, so each
 * authorization replaces the last — which means a sign-in that asked for identity alone would
 * discard a publishing permission the creator had already granted, and the first sign of it
 * would be a listing that stopped updating. So a creator's sign-in carries their permission
 * through, *and* a reader's still asks for nothing beyond identity. Asking everybody would
 * make the first test pass and is why the second one is here.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db";
import { atprotoSessions, users, works } from "@anthers/db/schema";
import { eq, like } from "drizzle-orm";
import app from "../index.js";
import { publishingStateFor } from "../services/atproto.js";
import {
	buildClientMetadata,
	CREATOR_COLLECTIONS,
	CREATOR_SCOPE_EXPANDED,
	CREATOR_SCOPES,
	grantedScopeFor,
	setAtprotoClient,
	USER_COLLECTIONS,
	USER_SCOPE_EXPANDED,
	USER_SCOPES,
} from "../services/atproto-client.js";
import { POST_COLLECTION } from "../services/atproto-record-plan.js";
import { WORK_COLLECTION } from "../services/atproto-repo.js";
import { createSession } from "../services/auth.js";
import { oauthWriterFor } from "../services/oauth-repo-writer.js";
import { stopPublishingFor } from "../services/work-listing.js";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const RUN = `pb${Date.now().toString(36)}`;
const did = (tag: string) => `did:plc:${RUN}${tag}`;

/** The full grant, spelled the way an authorization server answers it — see `atproto-scope`. */
const GRANTED = `atproto ${USER_SCOPE_EXPANDED} ${CREATOR_SCOPE_EXPANDED}`;

/** What a grant under the retired catalog set expanded to: Work listings, and nothing else. */
const WORK_ONLY = "atproto repo:org.anthers.work";

const CREATOR_SCOPE = CREATOR_SCOPES[0];

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
	it("declares both permission sets, and still no write-everything scope", () => {
		const prev = process.env.BASE_URL;
		process.env.BASE_URL = "https://anthers.org";
		try {
			const scope = buildClientMetadata().scope ?? "";
			expect(USER_SCOPES).toEqual(["include:org.anthers.userPermissions"]);
			expect(CREATOR_SCOPES).toEqual(["include:org.anthers.creatorPermissions"]);
			for (const asked of [...USER_SCOPES, ...CREATOR_SCOPES]) expect(scope).toContain(asked);
			// ⚠️ Still declared while it is being retired, so a grant already made under it is not
			// orphaned by the switch. This line goes in the change that retires it.
			expect(scope).toContain("include:org.anthers.catalogPermissions");
			expect(scope).not.toContain("repo:*");
			expect(scope).not.toContain("transition:generic");
		} finally {
			if (prev === undefined) delete process.env.BASE_URL;
			else process.env.BASE_URL = prev;
		}
	});

	// 🚨 **The narrowness lives in the published Lexicons, so the guard reads them.** The scope
	// string names a document rather than saying what is asked for, and a test asserting on the
	// string would pass while that document quietly widened.
	//
	// ⚠️ **A published set can never be narrowed again**, so this reads the files that are
	// published rather than describing them: a `*` collection would be a permission over every
	// record the account will ever own, which is what this whole design avoids. And each set must
	// name exactly the collections the code judges a grant against, or a grant would be read as
	// covering records it does not.
	it("asks for exactly the collections the code writes, and three actions, in each set", async () => {
		for (const [name, collections] of [
			["userPermissions", USER_COLLECTIONS],
			["creatorPermissions", CREATOR_COLLECTIONS],
		] as const) {
			const set = (await Bun.file(`lexicons/org/anthers/${name}.json`).json()) as {
				id: string;
				defs: {
					main: {
						type: string;
						title: string;
						detail: string;
						permissions: { resource: string; collection: string[]; action: string[] }[];
					};
				};
			};

			expect(set.id).toBe(`org.anthers.${name}`);
			expect(set.defs.main.type).toBe("permission-set");
			expect(set.defs.main.permissions).toHaveLength(1);

			const [permission] = set.defs.main.permissions;
			expect(permission.resource).toBe("repo");
			expect([...permission.collection].sort()).toEqual([...collections].sort());
			expect(permission.collection).not.toContain("*");
			expect([...permission.action].sort()).toEqual(["create", "delete", "update"]);

			// ⭐ The title and the detail are the sentence somebody reads deciding whether to trust
			// us, so they are copy rather than configuration — and they must not go empty.
			expect(set.defs.main.title.length).toBeGreaterThan(0);
			expect(set.defs.main.detail.length).toBeGreaterThan(0);
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
		// Both sets, the reader's alongside the creator's, because one request replaces the last.
		expect(lastAuthorize?.options.scope).toBe(
			`atproto ${[...USER_SCOPES, ...CREATOR_SCOPES].join(" ")}`,
		);
	});

	// 🚨 **The one that matters, and the one an earlier version of this got backwards.** One
	// session is stored per DID and each authorization replaces the last, so a sign-in asking
	// for identity alone would throw away a permission this creator had already granted — and
	// the first sign anybody would get is a listing that stopped updating.
	it("carries the creator permission through a later sign-in", async () => {
		const user = await makeUser("back", { atprotoDid: did("back"), isCreator: true });
		await seedSession(did("back"), user.id);

		await startAuth({ handle: did("back"), intent: "login" });
		expect(lastAuthorize?.options.scope).toContain(CREATOR_SCOPE);
	});

	// ⚠️ And the other half: a reader is never asked for permission over a kind of record they
	// will never write. Asking everybody would be the easy way to make the test above pass.
	// 🚨 **Linking is where the account-shaped question has an answer and the identity-shaped
	// one does not.** A creator attaching a Bluesky account has no DID on their account yet —
	// that is what linking is for — so resolving the handle finds nobody and would answer
	// "reader". They would connect an identity, be asked for nothing, and have to come back and
	// grant publishing as a second errand, which is the opt-in step this design does not have.
	it("asks a creator linking an identity for the publishing permission too", async () => {
		const user = await makeUser("linkcr", { isCreator: true });
		const token = await createSession(user.id, undefined, undefined);

		await startAuth({ handle: "fresh.bsky.social", intent: "link" }, token);
		expect(lastAuthorize?.options.scope).toContain(CREATOR_SCOPE);
	});

	// A reader's own records are Anthers working, so every reader is asked for them — and never
	// for the creator set, over records they will not make.
	it("asks a reader for their own records and not for the creator permission", async () => {
		const user = await makeUser("read", { atprotoDid: did("read"), isCreator: false });
		await seedSession(did("read"), user.id);

		await startAuth({ handle: did("read"), intent: "login" });
		expect(lastAuthorize?.options.scope).toBe(`atproto ${USER_SCOPES.join(" ")}`);
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

	it("needs no handle at all, and still requires one from every other intent", async () => {
		const user = await makeUser("nohandle", { atprotoDid: did("nohandle"), isCreator: true });
		const token = await createSession(user.id, undefined, undefined);

		expect((await startAuth({ intent: "publish" }, token)).status).toBe(200);
		expect(lastAuthorize?.input).toBe(did("nohandle"));
		// ⚠️ Optional in the schema, required by the handler — a sign-in with no handle has
		// nothing to resolve, and answering 400 says so rather than failing deeper in the SDK.
		expect((await startAuth({ intent: "login" })).status).toBe(400);
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

	// 🚨 A grant made under the retired catalog set covers Works and nothing else. Reading it as
	// publishing being on would leave every post and project quietly unwritten, so it reads as the
	// state a creator can act on: asked again.
	it("treats a grant under the retired catalog set as needing to be asked again", async () => {
		const user = await makeUser("old", { atprotoDid: did("old") });
		await seedSession(did("old"), user.id);

		const url = await runCallback({
			did: did("old"),
			scope: WORK_ONLY,
			state: JSON.stringify({ intent: "publish", userId: user.id }),
		});
		expect(url.searchParams.get("success")).toBe("publish_declined");
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
		expect(await oauthWriterFor(user.id, [WORK_COLLECTION])).toEqual({
			writer: null,
			reason: "no_identity",
		});
	});

	it("is quiet about an identity that has granted nothing", async () => {
		const user = await makeUser("ung", { atprotoDid: did("ung") });
		await seedSession(did("ung"), user.id);
		expect(await oauthWriterFor(user.id, [WORK_COLLECTION])).toEqual({
			writer: null,
			reason: "not_granted",
		});
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
		expect(await oauthWriterFor(user.id, [WORK_COLLECTION])).toEqual({
			writer: null,
			reason: "not_granted",
		});
	});
	// 🚨 **A grant is per collection, and a writer is judged against what it is opened FOR.** The
	// gate used to check Work listings whatever the caller was about to write, so a creator who had
	// granted only that got a writer for their posts too — which their own server then refused, and
	// the refusal read as a permission withdrawn that had never been given.
	it("does not open a writer for posts on the strength of a grant over Work listings", async () => {
		const user = await makeUser("percol", { atprotoDid: did("percol") });
		await seedSession(did("percol"), user.id);
		await db
			.update(atprotoSessions)
			.set({ scope: WORK_ONLY })
			.where(eq(atprotoSessions.did, did("percol")));

		expect(await oauthWriterFor(user.id, [POST_COLLECTION])).toEqual({
			writer: null,
			reason: "not_granted",
		});
		// And one collection it lacks is enough to refuse a writer asked to cover two.
		expect(await oauthWriterFor(user.id, [WORK_COLLECTION, POST_COLLECTION])).toEqual({
			writer: null,
			reason: "not_granted",
		});
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

	// 🚨 **A creator with no Works at all, and the case the first implementation missed.** The
	// writer used to be opened only when a Work carried a URI, so a creator whose only records
	// were posts and projects took that branch, revoked cleanly, and left every one of them up —
	// answering "stop writing on my behalf" by handing back the only credential that could.
	it("takes posts and projects down too, and strands them rather than revoking", async () => {
		const user = await makeUser("prj", { atprotoDid: did("prj") });
		await seedSession(did("prj"), user.id);

		const { posts, projects } = await import("@anthers/db/schema");
		const [post] = await db
			.insert(posts)
			.values({
				creatorId: user.id,
				publicId: Date.now(),
				slug: `${RUN}-prj-post`,
				isPublished: true,
				publishedAt: new Date(),
				atprotoUri: `at://${did("prj")}/org.anthers.post/p1`,
			})
			.returning();
		const [project] = await db
			.insert(projects)
			.values({
				creatorId: user.id,
				slug: `${RUN}-prj-project`,
				title: "A Project",
				isPublished: true,
				atprotoUri: `at://${did("prj")}/org.anthers.project/j1`,
			})
			.returning();

		// No grant on file, so no writer can be opened — and there is not one Work in sight.
		const result = await stopPublishingFor(user.id);
		expect(result).toEqual({ removed: 0, stranded: 2, revoked: false });
		expect(revoked).not.toContain(did("prj"));

		await db.delete(posts).where(eq(posts.id, post.id));
		await db.delete(projects).where(eq(projects.id, project.id));
	});
});
