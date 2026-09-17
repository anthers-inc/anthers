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
import { atprotoSessions, notifications, posts, works } from "@anthers/db/schema";
import { TokenRevokedError } from "@atproto/oauth-client";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import { queue } from "../jobs/queue";
import { releaseScheduled } from "../jobs/release-scheduled";
import { publishingStateFor } from "../services/atproto";
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
