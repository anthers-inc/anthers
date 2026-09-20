// SPDX-License-Identifier: Apache-2.0
/**
 * A creator without a permission Anthers can write their records with cannot publish, and hears
 * about it before they try.
 *
 * 🚨 **Every creator here has payouts set up and is in creator mode**, so the only thing that can
 * refuse them is the permission. A refusal this suite sees is therefore this condition's and not
 * a neighbor's, which is what keeps it from passing because payout setup happened to refuse.
 *
 * ⚠️ `queue.send` is replaced, so a release that got through would be read rather than synced,
 * and the OAuth client is a fake whose `restore` a case sets.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { atprotoSessions, follows, notifications, posts, users, works } from "@anthers/db/schema";
import { TokenRevokedError } from "@atproto/oauth-client";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { queue } from "../jobs/queue";
import { releaseScheduled } from "../jobs/release-scheduled";
import { interactionPermissionRefusal, publishingStateFor } from "../services/atproto";
import {
	CREATOR_SCOPE_EXPANDED,
	grantedScopeFor,
	setAtprotoClient,
	USER_SCOPE_EXPANDED,
} from "../services/atproto-client";

import { GRANT_RECHECK_MS, recheckPublishingGrant } from "../services/oauth-repo-writer";
import { publishRefusal } from "../services/publish-refusal";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

/** The full grant, spelled the way an authorization server answers it. */
const GRANTED = `atproto ${USER_SCOPE_EXPANDED} ${CREATOR_SCOPE_EXPANDED}`;

/** The reader tier alone, which is what a reader is asked for. */
const READER_GRANT = `atproto ${USER_SCOPE_EXPANDED}`;

interface Creator {
	id: number;
	cookie: string;
	did: string;
}

let brought: Creator;
let granted: Creator;
let hosted: Creator;
const workIds: number[] = [];
let sendSpy: ReturnType<typeof spyOn>;

/** What the fake client's `restore` does, set per case. */
let restore: (did: string) => Promise<unknown> = async () => {
	throw new Error("restore not staged");
};

async function makeCreator(tag: string, identity: "hosted" | "brought"): Promise<Creator> {
	const account = await createAccount(`perm_${tag}_${run}`, {
		identity,
		fields: { isCreator: true },
	});
	const id = account.userId as number;
	await enablePayoutsFor(id);
	return { id, cookie: account.cookie, did: account.did as string };
}

/** Put a session on file for this identity, holding `scope`. */
async function holdGrant(did: string, userId: number, scope: string | null): Promise<void> {
	await db
		.insert(atprotoSessions)
		.values({ did, userId, session: {}, scope })
		.onConflictDoUpdate({ target: atprotoSessions.did, set: { scope } });
}

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

async function stage(creatorId: number): Promise<number> {
	const row = await insertWork({
		creatorId,
		type: "game",
		visibility: "private",
		seedAccess: [{ threshold: 0, allow: true, price: "0" }],
	});
	workIds.push(row.id);
	return row.id;
}

beforeAll(async () => {
	brought = await makeCreator("brought", "brought");
	granted = await makeCreator("granted", "brought");
	hosted = await makeCreator("hosted", "hosted");
	sendSpy = spyOn(queue, "send").mockImplementation((async () => "job") as typeof queue.send);
	setAtprotoClient({ restore: (did: string) => restore(did) } as never);
}, DB_SETUP_TIMEOUT);

beforeEach(async () => {
	process.env.ATPROTO_PUBLISH_ENABLED = "true";
	await holdGrant(brought.did, brought.id, "atproto");
	await holdGrant(granted.did, granted.id, GRANTED);
});

afterAll(async () => {
	delete process.env.ATPROTO_PUBLISH_ENABLED;
	sendSpy.mockRestore();
	setAtprotoClient(undefined);
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	await db
		.delete(atprotoSessions)
		.where(inArray(atprotoSessions.did, [brought.did, granted.did, hosted.did]));
});

describe("who is refused", () => {
	it("refuses a creator whose identity is held elsewhere and who has not granted it", async () => {
		const refusal = await publishRefusal({ id: brought.id, isCreator: true }, "release");
		expect(refusal?.status).toBe(409);
		expect(refusal?.body.code).toBe("publishing_permission_required");
		expect(refusal?.body.error).toContain("Studio settings");
	});

	it("lets a creator with the grant publish", async () => {
		expect(await publishRefusal({ id: granted.id, isCreator: true }, "release")).toBeNull();
	});

	it("never refuses an identity Anthers hosts, which has nothing to grant", async () => {
		expect(await publishRefusal({ id: hosted.id, isCreator: true }, "release")).toBeNull();
	});

	// A refusal nobody could act on: with asking closed there is no button that gives it.
	it("does not refuse anybody while Anthers is not asking for the permission", async () => {
		delete process.env.ATPROTO_PUBLISH_ENABLED;
		expect(await publishRefusal({ id: brought.id, isCreator: true }, "release")).toBeNull();
	});

	it("counts a grant over Work listings alone as not granted", async () => {
		// Posts and projects would go unwritten under it, so it is not a working state.
		await holdGrant(brought.did, brought.id, "atproto repo:org.anthers.work");
		const refusal = await publishRefusal({ id: brought.id, isCreator: true }, "publish");
		expect(refusal?.body.code).toBe("publishing_permission_required");
	});
});

describe("every way of publishing", () => {
	it("refuses a release, and the Work stays private", async () => {
		const workId = await stage(brought.id);
		const res = await call("PATCH", `/api/content/works/${workId}`, brought.cookie, {
			visibility: "released",
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("publishing_permission_required");
		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.visibility).toBe("private");
	});

	it("releases once the grant is back", async () => {
		const workId = await stage(brought.id);
		await holdGrant(brought.did, brought.id, GRANTED);
		const res = await call("PATCH", `/api/content/works/${workId}`, brought.cookie, {
			visibility: "released",
		});
		expect(res.status).toBe(200);
	});

	it("refuses scheduling a release, since nobody would be there when it was refused", async () => {
		const workId = await stage(brought.id);
		const res = await call("PATCH", `/api/content/works/${workId}`, brought.cookie, {
			scheduledReleaseAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("publishing_permission_required");
	});

	it("refuses publishing a post and a project", async () => {
		const post = await call("POST", "/api/content/posts", brought.cookie, {
			title: `Perm post ${run}`,
			isPublished: true,
		});
		expect(post.status).toBe(409);
		expect((await post.json()).code).toBe("publishing_permission_required");

		const project = await call("POST", "/api/content/projects", brought.cookie, {
			title: "Perm project",
			slug: `perm-project-${run}`,
			isPublished: true,
		});
		expect(project.status).toBe(409);
		expect((await project.json()).code).toBe("publishing_permission_required");

		const [stored] = await db
			.select({ id: posts.id })
			.from(posts)
			.where(eq(posts.title, `Perm post ${run}`));
		expect(stored).toBeUndefined();
	});

	it("gives up a scheduled release and tells the creator, when the grant lapsed before its time", async () => {
		const workId = await stage(granted.id);
		const at = new Date(Date.now() - 60_000);
		await db.update(works).set({ scheduledReleaseAt: at }).where(eq(works.id, workId));
		await holdGrant(granted.did, granted.id, null);

		await releaseScheduled();

		const [row] = await db.select().from(works).where(eq(works.id, workId));
		expect(row.visibility).toBe("private");
		expect(row.scheduledReleaseAt).toBeNull();
		const notices = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, granted.id),
					eq(notifications.dedupeKey, `scheduled-release-refused:${workId}:${at.toISOString()}`),
				),
			);
		expect(notices).toHaveLength(1);
		expect(notices[0].body).toContain("permission");
	});
});

describe("noticing a grant taken back somewhere else", () => {
	// Each case uses its own clock, far enough apart that the throttle never carries over.
	let clock = Date.now();
	const later = () => {
		clock += GRANT_RECHECK_MS * 10;
		return clock;
	};

	it("forgets a grant the creator's server says was revoked", async () => {
		restore = async (did) => {
			throw new TokenRevokedError(did);
		};
		expect(await recheckPublishingGrant(granted.did, later())).toBe(true);
		expect(await grantedScopeFor(granted.did)).toBeNull();
		expect((await publishingStateFor(granted.id)).route).toBe("ungranted");
	});

	// 🚨 The other half, and the one that would lock creators out for somebody else's outage.
	it("keeps a grant when the creator's server is merely not answering", async () => {
		restore = async () => {
			throw new Error("fetch failed");
		};
		expect(await recheckPublishingGrant(granted.did, later())).toBe(false);
		expect(await grantedScopeFor(granted.did)).toBe(GRANTED);
	});

	it("asks at most once in a window, however often the state is read", async () => {
		let asked = 0;
		restore = async () => {
			asked += 1;
			return { getTokenInfo: async () => ({ scope: GRANTED }) };
		};
		const at = later();
		await recheckPublishingGrant(granted.did, at);
		await recheckPublishingGrant(granted.did, at + GRANT_RECHECK_MS - 1);
		expect(asked).toBe(1);
		await recheckPublishingGrant(granted.did, at + GRANT_RECHECK_MS);
		expect(asked).toBe(2);
	});

	it("reports the lapse through the state the banner reads", async () => {
		restore = async (did) => {
			throw new TokenRevokedError(did);
		};
		// A DID this process has never rechecked, so the window cannot be what answers.
		const fresh = await makeCreator("fresh", "brought");
		await holdGrant(fresh.did, fresh.id, GRANTED);
		try {
			const res = await call("GET", "/api/atproto/publishing", fresh.cookie);
			expect(res.status).toBe(200);
			expect((await res.json()).route).toBe("ungranted");
		} finally {
			await db.delete(atprotoSessions).where(eq(atprotoSessions.did, fresh.did));
		}
	});
});

describe("a reader's comments, reviews, votes and follows", () => {
	let reader: Creator;
	let hostedReader: Creator;
	let postId = 0;
	let postSlug = "";

	async function makeReader(tag: string, identity: "hosted" | "brought"): Promise<Creator> {
		const account = await createAccount(`perm_${tag}_${run}`, { identity });
		return { id: account.userId as number, cookie: account.cookie, did: account.did as string };
	}

	beforeAll(async () => {
		reader = await makeReader("reader", "brought");
		hostedReader = await makeReader("hreader", "hosted");
		// Something to react to: a post by the creator who holds every grant.
		const res = await call("POST", "/api/content/posts", granted.cookie, {
			title: `Perm thread ${run}`,
			isPublished: true,
		});
		expect(res.status).toBe(201);
		const { post } = (await res.json()) as { post: { id: number; slug: string } };
		postId = post.id;
		postSlug = post.slug;
	}, DB_SETUP_TIMEOUT);

	beforeEach(async () => {
		await holdGrant(reader.did, reader.id, "atproto");
	});

	afterAll(async () => {
		await db.delete(atprotoSessions).where(eq(atprotoSessions.did, reader.did));
	});

	it("refuses a comment, a vote and a follow, and writes none of them", async () => {
		const comment = await call("POST", `/api/content/posts/${postSlug}/comments`, reader.cookie, {
			body: "Lovely",
		});
		expect(comment.status).toBe(409);
		expect((await comment.json()).code).toBe("interaction_permission_required");

		const vote = await call("PUT", "/api/content/votes", reader.cookie, {
			subjectType: "post",
			subjectId: postId,
			direction: "up",
		});
		expect(vote.status).toBe(409);

		const [creatorRow] = await db
			.select({ handle: users.atprotoHandle })
			.from(users)
			.where(eq(users.id, granted.id));
		const follow = await call(
			"POST",
			`/api/accounts/users/${creatorRow.handle}/follow`,
			reader.cookie,
		);
		expect(follow.status).toBe(409);
		const kept = await db.select().from(follows).where(eq(follows.followerId, reader.id));
		expect(kept).toHaveLength(0);
	});

	it("refuses a review", async () => {
		const workId = await stage(granted.id);
		await db.update(works).set({ visibility: "released" }).where(eq(works.id, workId));
		const res = await call("POST", `/api/content/works/${workId}/reviews`, reader.cookie, {
			verdict: "recommended",
			body: "A thoughtful and generous piece of work.",
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("interaction_permission_required");
	});

	it("lets a reader take a vote back, which removes a record rather than creating one", async () => {
		await holdGrant(reader.did, reader.id, READER_GRANT);
		const cast = await call("PUT", "/api/content/votes", reader.cookie, {
			subjectType: "post",
			subjectId: postId,
			direction: "up",
		});
		expect(cast.status).toBe(200);

		await holdGrant(reader.did, reader.id, "atproto");
		const withdrawn = await call("DELETE", "/api/content/votes", reader.cookie, {
			subjectType: "post",
			subjectId: postId,
		});
		expect(withdrawn.status).toBe(200);
	});

	it("accepts all of it once the reader tier is granted, with no creator tier needed", async () => {
		await holdGrant(reader.did, reader.id, READER_GRANT);
		expect(await interactionPermissionRefusal(reader.id)).toBeNull();
		const comment = await call("POST", `/api/content/posts/${postSlug}/comments`, reader.cookie, {
			body: "Lovely",
		});
		expect(comment.status).toBe(201);
	});

	it("never refuses an identity Anthers hosts", async () => {
		expect(await interactionPermissionRefusal(hostedReader.id)).toBeNull();
	});

	// ⚠️ Asking readers is not behind the switch that gates asking creators to publish.
	it("refuses a reader whatever the publishing switch says, since the reader tier can always be given", async () => {
		delete process.env.ATPROTO_PUBLISH_ENABLED;
		const refusal = await interactionPermissionRefusal(reader.id);
		expect(refusal?.body.code).toBe("interaction_permission_required");
	});

	it("reports each tier on its own in the state the banner reads", async () => {
		const state = await publishingStateFor(reader.id);
		expect(state.interactions).toBe("ungranted");
		await holdGrant(reader.did, reader.id, READER_GRANT);
		expect((await publishingStateFor(reader.id)).interactions).toBe("granted");
		expect((await publishingStateFor(granted.id)).interactions).toBe("granted");
	});
});

describe("an identity's server that is not answering", () => {
	// 🚨 A down server delays records and blocks nothing. `pds-health.ts` carries why.
	it("is reported in the state the banner reads, and never refuses a release", async () => {
		const down = await makeCreator("pdsdown", "brought");
		await holdGrant(down.did, down.id, GRANTED);
		// The authorization server is down with it, which a recheck must read as an outage rather
		// than as the grant being gone.
		restore = async () => {
			throw new Error("fetch failed");
		};
		// A port nothing listens on, refused at once.
		await db
			.update(users)
			.set({ atprotoPdsUrl: "http://127.0.0.1:9" })
			.where(eq(users.id, down.id));
		try {
			const res = await call("GET", "/api/atproto/publishing", down.cookie);
			const state = (await res.json()) as { server: { reachable: boolean } | null };
			expect(state.server?.reachable).toBe(false);

			const workId = await stage(down.id);
			const released = await call("PATCH", `/api/content/works/${workId}`, down.cookie, {
				visibility: "released",
			});
			expect(released.status).toBe(200);
		} finally {
			await db.delete(atprotoSessions).where(eq(atprotoSessions.did, down.did));
		}
	});

	it("is never asked about for an identity Anthers hosts", async () => {
		const res = await call("GET", "/api/atproto/publishing", hosted.cookie);
		expect(((await res.json()) as { server: unknown }).server).toBeNull();
	});
});
