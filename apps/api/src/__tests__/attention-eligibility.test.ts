// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Server-side attention eligibility on POST /api/subscriptions/attention.
 *
 * `distribute-pool` sums `attention_events.duration_seconds` per creator and splits the
 * Time Pool proportionally, nightly — so a row in that table is money. The eligibility
 * rule that decides which seconds may become a row (only a post's CONTENT ELEMENTS earn;
 * bodies, project pages, profiles, discovery and comments earn nothing) used to be enforced
 * only in the browser, at `PostPage.tsx`. The endpoint validated shape alone.
 *
 * The wall-clock clamp is not a substitute and never was: it bounds *volume* — you cannot
 * be credited more seconds than have elapsed — and has nothing to say about *attribution*.
 * A hand-written request could sit inside the clamp perfectly while crediting `read` seconds
 * against a body-only announcement, or against a creator who had nothing to do with the post.
 * These tests are about attribution.
 *
 * Policy itself lives in `packages/shared/src/attention.ts` and is unit-tested there; what's
 * asserted here is that the endpoint actually consults it.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents, contentItems } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return {
		cookie: res.headers.get("Set-Cookie")!.split(";")[0],
		id: (await res.json()).user.id,
	};
}

type Event = {
	creatorId: number;
	eventType: string;
	durationSeconds: number;
	postId?: number;
};

async function claim(cookie: string, events: Event[]) {
	const res = await req("/api/subscriptions/attention", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ events }),
	});
	expect(res.status).toBe(200);
	return res.json();
}

/** Seconds this user has ever been credited toward this creator. */
async function creditedTo(userId: number, creatorId: number): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(and(eq(attentionEvents.userId, userId), eq(attentionEvents.creatorId, creatorId)));
	return row?.total ?? 0;
}

async function createPost(cookie: string, body: Record<string, unknown>): Promise<number> {
	const res = await req("/api/content/posts", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ isPublished: true, ...body }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).post.id;
}

const FREE = [{ threshold: 0, allow: true, price: "0" }];
const LOCKED = { anthersAccess: [{ threshold: 0, allow: false, price: "0" }] };

let viewer: { cookie: string; id: number };
let creator: { cookie: string; id: number };
let bystander: { cookie: string; id: number };

/** Free, one video element → earns "watch". */
let videoPostId: number;
/** Free, one text element → earns "read". */
let textPostId: number;
/** Free, body prose only, NO content elements → earns nothing. */
let announcementPostId: number;
/** A video element, but locked to everyone. */
let lockedPostId: number;

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	viewer = await signUp(`eligviewer${stamp}`);
	creator = await signUp(`eligcreator${stamp}`);
	bystander = await signUp(`eligbystander${stamp}`);

	// Video items are inserted rather than created through the API: creating one queues a
	// transcode, and pg-boss isn't running in the test process.
	const [videoA] = await db
		.insert(contentItems)
		.values({ creatorId: creator.id, type: "video", title: "A Film" })
		.returning();
	const [videoB] = await db
		.insert(contentItems)
		.values({ creatorId: creator.id, type: "video", title: "A Locked Film" })
		.returning();

	videoPostId = await createPost(creator.cookie, {
		title: `Video ${stamp}`,
		seedAccess: FREE,
		contents: [{ kind: "content", contentItemId: videoA.id }],
	});
	textPostId = await createPost(creator.cookie, {
		title: `Text ${stamp}`,
		seedAccess: FREE,
		contents: [{ kind: "text", bodyHtml: "<p>a work, published as a content element</p>" }],
	});
	announcementPostId = await createPost(creator.cookie, {
		title: `Announcement ${stamp}`,
		seedAccess: FREE,
		body: "just prose in the post body — connective tissue, not a work",
	});
	lockedPostId = await createPost(creator.cookie, {
		title: `Locked ${stamp}`,
		...LOCKED,
		contents: [{ kind: "content", contentItemId: videoB.id }],
	});
});

describe("attention eligibility is decided server-side", () => {
	it("credits time against a post whose content element earns it", async () => {
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 30, postId: videoPostId },
			{ creatorId: creator.id, eventType: "read", durationSeconds: 20, postId: textPostId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before + 50);
	});

	it("earns nothing for a body-only announcement", async () => {
		// The asymmetry this asserts is deliberate and documented: prose in a post BODY
		// earns nothing while the same prose published as a content element earns.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{
				creatorId: creator.id,
				eventType: "read",
				durationSeconds: 60,
				postId: announcementPostId,
			},
		]);
		expect(body.recorded).toBe(0);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses an event type the post's elements don't earn", async () => {
		// The text post has no video, so "watch" against it is not a real observation.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, postId: textPostId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time credited to someone who isn't the post's creator", async () => {
		// Straightforward attribution forgery: real post, real elements, wrong payee.
		const before = await creditedTo(viewer.id, bystander.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: bystander.id, eventType: "watch", durationSeconds: 60, postId: videoPostId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, bystander.id)).toBe(before);
	});

	it("refuses time against a post the viewer can't access", async () => {
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, postId: lockedPostId },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time with no post context at all", async () => {
		// A claim with no post is connective tissue by definition — a profile, discovery.
		// This is the shape a naive forged request takes, and it used to be credited.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60 },
		]);
		expect(body.ineligible).toBe(1);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("refuses time against a post that doesn't exist", async () => {
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 60, postId: 2_000_000_000 },
		]);
		expect(body.ineligible).toBe(1);
	});

	it("still records zero-duration visit pings, with or without a post", async () => {
		// These carry no time so they cannot over-credit, and they are deliberately the
		// analytics signal for surfaces that earn nothing. Dropping them would lose that.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0 },
			{
				creatorId: creator.id,
				eventType: "page_view",
				durationSeconds: 0,
				postId: announcementPostId,
			},
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(0);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before);
	});

	it("keeps the good events in a batch that also carries bad ones", async () => {
		// A partly-forged batch must not cost an honest surface its seconds, and the bad
		// events must not eat clamp budget on their way to being dropped.
		const before = await creditedTo(viewer.id, creator.id);
		const body = await claim(viewer.cookie, [
			{ creatorId: creator.id, eventType: "watch", durationSeconds: 10, postId: videoPostId },
			{ creatorId: creator.id, eventType: "read", durationSeconds: 99, postId: announcementPostId },
			{ creatorId: creator.id, eventType: "read", durationSeconds: 5, postId: textPostId },
		]);
		expect(body.recorded).toBe(2);
		expect(body.ineligible).toBe(1);
		expect(body.granted).toBe(15);
		expect(await creditedTo(viewer.id, creator.id)).toBe(before + 15);
	});
});
