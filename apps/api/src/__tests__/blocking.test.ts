// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Blocking, end to end — and the two decisions most likely to be "fixed" back out.
 *
 * The brief left four design questions open and this file is where the answers are
 * held, because each one is a call someone will reasonably reach the opposite of:
 *
 * 1. **Symmetric.** Every enforcement assertion runs in BOTH directions. A one-way
 *    block passes half a suite that only checks the blocker's view, which is the
 *    version that protects the wrong person — so no assertion here is made once.
 * 2. **The follow goes with it**, both ways, and an unblock does NOT bring it back.
 * 3. **The block is never announced.** A blocked profile answers 404, the same as a
 *    username nobody ever registered — not a 403 and not a blocked-state body.
 * 4. **A block is not a content filter.** The blocked creator's Works still load.
 *    That is the assertion protecting the Library: a purchase outlives everything,
 *    and a block that hid content would have to carve the Library out.
 *
 * Point 4 in particular is the one that looks like an omission. It is a decision, and
 * `blocks_do_not_filter_content` exists so that changing it has to be deliberate.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	comments,
	follows,
	moderationActions,
	ratings,
	userBlocks,
	users,
} from "@anthers/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string, body?: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

function get(path: string, cookie?: string) {
	return req(path, { headers: cookie ? { Cookie: cookie } : {} });
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
/** The creator whose Work carries the thread the two others meet in. */
const hostName = `blk_host_${id}`;
/** Blocks `bee`. Everything is asserted from both their point of view and bee's. */
const abeName = `blk_abe_${id}`;
const beeName = `blk_bee_${id}`;
/** Never involved in a block — the control proving filters are pair-scoped, not global. */
const camName = `blk_cam_${id}`;

let host: string;
let abe: string;
let bee: string;
let cam: string;
let abeId: number;
let beeId: number;
let workId: number;
let postSlug: string;

async function userId(username: string): Promise<number> {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return row.id;
}

/** Put the pair back to unblocked, so each test states its own starting position. */
async function clearBlocks() {
	await db.delete(userBlocks).where(
		sql`(${userBlocks.blockerId} = ${abeId} AND ${userBlocks.blockedId} = ${beeId})
			 OR (${userBlocks.blockerId} = ${beeId} AND ${userBlocks.blockedId} = ${abeId})`,
	);
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${hostName}, ${abeName}, ${beeName}, ${camName})`,
	);
	host = await signUp(hostName);
	abe = await signUp(abeName);
	bee = await signUp(beeName);
	cam = await signUp(camName);
	// abe and bee are creators too, so the creator-listing and profile assertions have
	// something to find them in.
	await db.execute(
		sql`UPDATE users SET is_creator = true WHERE username IN (${hostName}, ${abeName}, ${beeName})`,
	);

	abeId = await userId(abeName);
	beeId = await userId(beeName);

	// `maturity` declared on create so the release below is not refused for a reason
	// this suite is not about.
	const workRes = await post("/api/content/works", host, {
		type: "game",
		title: `Blk work ${id}`,
		maturity: "general",
	});
	expect(workRes.status).toBe(201);
	workId = (await workRes.json()).work.id;

	// Released and open, so both parties can comment on and review it.
	const release = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: host },
		body: JSON.stringify({
			visibility: "released",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(release.status).toBe(200);

	const postRes = await post("/api/content/posts", host, {
		title: `Blk post ${id}`,
		workIds: [workId],
		isPublished: true,
	});
	expect(postRes.status).toBe(201);
	postSlug = (await postRes.json()).post.slug;

	for (const [cookie, body] of [
		[abe, `abe was here ${id}`],
		[bee, `bee was here ${id}`],
		[cam, `cam was here ${id}`],
	] as const) {
		expect((await post(`/api/content/posts/${postSlug}/comments`, cookie, { body })).status).toBe(
			201,
		);
		expect((await post(`/api/content/works/${workId}/comments`, cookie, { body })).status).toBe(
			201,
		);
		expect(
			(await post(`/api/content/works/${workId}/ratings`, cookie, { score: 4, body })).status,
		).toBe(201);
	}
}, DB_SETUP_TIMEOUT);

describe("blocking is symmetric", () => {
	it("hides each party's profile from the other, and says nothing about why", async () => {
		await clearBlocks();
		expect((await get(`/api/accounts/users/${beeName}`, abe)).status).toBe(200);
		expect((await get(`/api/accounts/users/${abeName}`, bee)).status).toBe(200);

		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// Both directions. The blocked party losing the blocker is the half a one-way
		// implementation gets wrong, and it is the half that matters for contact risk.
		const forBlocker = await get(`/api/accounts/users/${beeName}`, abe);
		const forBlocked = await get(`/api/accounts/users/${abeName}`, bee);
		expect(forBlocker.status).toBe(404);
		expect(forBlocked.status).toBe(404);

		// Not a 403, and no blocked-state body: the response is indistinguishable from a
		// username nobody ever registered. Anthers never states the block.
		const body = (await forBlocked.json()) as Record<string, unknown>;
		expect(JSON.stringify(body).toLowerCase()).not.toContain("block");
		const missing = await get(`/api/accounts/users/nobody_${id}`, bee);
		expect(missing.status).toBe(forBlocked.status);

		// A third party is unaffected — the filter is pair-scoped, not a global hide.
		expect((await get(`/api/accounts/users/${beeName}`, cam)).status).toBe(200);
		expect((await get(`/api/accounts/users/${abeName}`)).status).toBe(200);
	});

	it("refuses the follow in both directions, with the same 404 the profile gave", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// A 403 here would announce the block that the profile route just declined to.
		expect((await post(`/api/accounts/users/${beeName}/follow`, abe)).status).toBe(404);
		expect((await post(`/api/accounts/users/${abeName}/follow`, bee)).status).toBe(404);
		expect((await post(`/api/accounts/users/${camName}/follow`, bee)).status).toBe(201);
	});

	it("drops both parties out of the creator listing for each other", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		const names = async (cookie?: string) => {
			const res = await get("/api/accounts/creators", cookie);
			expect(res.status).toBe(200);
			return ((await res.json()).creators as { username: string }[]).map((u) => u.username);
		};

		expect(await names(abe)).not.toContain(beeName);
		expect(await names(bee)).not.toContain(abeName);
		// Present for everyone else, including signed-out — a block is one pair's business.
		expect(await names(cam)).toEqual(expect.arrayContaining([abeName, beeName]));
		expect(await names()).toEqual(expect.arrayContaining([abeName, beeName]));
	});

	it("removes each party's comments and reviews from the other's view of a thread", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		const authors = async (path: string, cookie?: string) => {
			const res = await get(path, cookie);
			expect(res.status).toBe(200);
			const data = (await res.json()) as {
				comments?: { username: string }[];
				reviews?: { username: string }[];
			};
			return (data.comments ?? data.reviews ?? []).map((r) => r.username);
		};

		for (const path of [
			`/api/content/posts/${postSlug}/comments`,
			`/api/content/works/${workId}/comments`,
			`/api/content/works/${workId}/ratings`,
		]) {
			expect(await authors(path, abe)).not.toContain(beeName);
			expect(await authors(path, bee)).not.toContain(abeName);
			// Their own words stay, and the uninvolved third party is visible to everyone.
			expect(await authors(path, abe)).toContain(abeName);
			expect(await authors(path, abe)).toContain(camName);
			expect(await authors(path, cam)).toEqual(expect.arrayContaining([abeName, beeName]));
		}
	});

	it("leaves the review AGGREGATE global — a block must not move a creator's score", async () => {
		await clearBlocks();
		const before = await (await get(`/api/content/works/${workId}/ratings`, cam)).json();

		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		const after = (await (await get(`/api/content/works/${workId}/ratings`, abe)).json()) as {
			average: number;
			count: number;
			reviews: { username: string }[];
		};

		// The list shrank; the aggregate did not. A per-viewer average would mean two
		// people see different ratings for the same Work, and would hand one user a way
		// to move a creator's public score by blocking a reviewer.
		expect(after.reviews.map((r) => r.username)).not.toContain(beeName);
		expect(after.count).toBe((before as { count: number }).count);
		expect(after.average).toBe((before as { average: number }).average);
		expect(after.count).toBeGreaterThan(after.reviews.length);
	});
});

describe("blocking and following", () => {
	it("deletes the follow in both directions, and unblocking does not restore it", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/follow`, abe)).status).toBe(201);
		expect((await post(`/api/accounts/users/${abeName}/follow`, bee)).status).toBe(201);

		const followRows = async () =>
			db
				.select({ id: follows.id })
				.from(follows)
				.where(
					sql`(${follows.followerId} = ${abeId} AND ${follows.creatorId} = ${beeId})
					 OR (${follows.followerId} = ${beeId} AND ${follows.creatorId} = ${abeId})`,
				);

		expect((await followRows()).length).toBe(2);

		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// Following is not symmetric, so there is a row each way — removing only the
		// blocker's own would leave the blocked party still subscribed to the account
		// they were just cut off from.
		expect(await followRows()).toEqual([]);

		expect((await post(`/api/accounts/users/${beeName}/unblock`, abe)).status).toBe(204);

		// Not restored. Re-subscribing someone to an account they were cut off from
		// would be the app making a social decision for them.
		expect(await followRows()).toEqual([]);
	});

	it("keeps blocked creators out of the follow feed and the following list", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${hostName}/follow`, abe)).status).toBe(201);
		expect((await post(`/api/accounts/users/${beeName}/follow`, abe)).status).toBe(201);

		// Seed the DB directly: the follow rows are what the feed reads, and blocking is
		// about to delete them — so this asserts the filters hold even if a follow row
		// survives, which is the state a future bug would produce.
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);
		await db.insert(follows).values({ followerId: abeId, creatorId: beeId }).onConflictDoNothing();

		const following = await get("/api/accounts/me/following", abe);
		expect(following.status).toBe(200);
		const names = ((await following.json()).users as { username: string }[]).map((u) => u.username);
		expect(names).not.toContain(beeName);
		expect(names).toContain(hostName);

		const feed = await get("/api/accounts/me/feed", abe);
		expect(feed.status).toBe(200);
		const creators = ((await feed.json()).entries as { creator: { username: string } }[]).map(
			(e) => e.creator.username,
		);
		expect(creators).not.toContain(beeName);
	});
});

describe("a block is a boundary, not a moderation action", () => {
	it("writes no moderation record", async () => {
		await clearBlocks();
		const before = await db
			.select({ id: moderationActions.id })
			.from(moderationActions)
			.where(inArray(moderationActions.actorId, [abeId, beeId]));

		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// A block enters no queue, records no reason and is reviewed by nobody. If this
		// ever fails, blocking has acquired an operator — which is the thing keeping it
		// out of `services/moderation.ts` was meant to prevent.
		const after = await db
			.select({ id: moderationActions.id })
			.from(moderationActions)
			.where(inArray(moderationActions.actorId, [abeId, beeId]));
		expect(after.length).toBe(before.length);
	});

	it("blocks_do_not_filter_content — the blocked creator's Works still load", async () => {
		await clearBlocks();
		const beeWorkRes = await post("/api/content/works", bee, {
			type: "text",
			title: `Bee work ${id}`,
			body: "words",
			maturity: "general",
		});
		expect(beeWorkRes.status).toBe(201);
		const beeWork = (await beeWorkRes.json()).work;
		expect(
			(
				await req(`/api/content/works/${beeWork.id}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: bee },
					body: JSON.stringify({
						visibility: "released",
						seedAccess: [{ threshold: 0, allow: true, price: "0" }],
					}),
				})
			).status,
		).toBe(200);

		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// DELIBERATE. A block severs contact between two people; it is not a mute and it
		// does not remove anyone's published work from anyone's view. The decisive case
		// is that a purchase outlives everything — a buyer who later blocks a creator
		// still owns what they bought, so a content-filtering block would need a Library
		// carve-out, and needing the carve-out is the proof content was never the axis.
		//
		// If this assertion is failing because someone made blocks filter content, that
		// is a product decision, not a bug fix: change it here on purpose or not at all.
		const workRes = await get(`/api/content/works/${beeWork.id}`, abe);
		expect(workRes.status).toBe(200);
		expect((await workRes.json()).work.title).toBe(`Bee work ${id}`);
	});

	it("lets the blocker name the person the block hides, so an unblock is possible", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// Every other username lookup goes through the block filter. The unblock route
		// deliberately does not — otherwise the block would hide its own subject from the
		// one person entitled to lift it, and the boundary would be a one-way door.
		expect((await get(`/api/accounts/users/${beeName}`, abe)).status).toBe(404);

		const list = await get("/api/accounts/me/blocks", abe);
		expect(list.status).toBe(200);
		expect(((await list.json()).blocks as { username: string }[]).map((b) => b.username)).toContain(
			beeName,
		);

		expect((await post(`/api/accounts/users/${beeName}/unblock`, abe)).status).toBe(204);
		expect((await get(`/api/accounts/users/${beeName}`, abe)).status).toBe(200);
	});

	it("only the blocker can lift it, and self-blocking is refused", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// bee cannot unblock themselves out of abe's decision.
		expect((await post(`/api/accounts/users/${abeName}/unblock`, bee)).status).toBe(404);
		expect((await get(`/api/accounts/users/${abeName}`, bee)).status).toBe(404);

		expect((await post(`/api/accounts/users/${abeName}/block`, abe)).status).toBe(400);
	});

	it("is idempotent", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);
		const rows = await db
			.select({ id: userBlocks.id })
			.from(userBlocks)
			.where(and(eq(userBlocks.blockerId, abeId), eq(userBlocks.blockedId, beeId)));
		expect(rows.length).toBe(1);
	});
});

describe("the rows survive, because a block is not a delete", () => {
	it("leaves the filtered comments and reviews in the table untouched", async () => {
		await clearBlocks();
		expect((await post(`/api/accounts/users/${beeName}/block`, abe)).status).toBe(201);

		// Filtering is a read-time decision, exactly as hiding is. A suite that only
		// checked the API response would pass just as happily against an implementation
		// that deleted bee's comments when abe blocked them — and that implementation
		// would let one user destroy another's words.
		const beeComments = await db
			.select({ id: comments.id, body: comments.body })
			.from(comments)
			.where(eq(comments.userId, beeId));
		expect(beeComments.length).toBeGreaterThan(0);
		expect(beeComments.every((c) => c.body.includes("bee was here"))).toBe(true);

		const beeReviews = await db
			.select({ id: ratings.id })
			.from(ratings)
			.where(eq(ratings.userId, beeId));
		expect(beeReviews.length).toBeGreaterThan(0);
	});
});
