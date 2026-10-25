// SPDX-License-Identifier: Apache-2.0
/**
 * The unified timeline paginates, and paging is a walk a client can finish.
 *
 * `GET /posts` used to end at a flat `.limit(100)` — a feed that quietly stopped at the
 * same place, indistinguishable from a feed that had run out. The route now carries
 * keyset pagination over its full ordering tuple, and these tests walk it: every visible
 * post surfaced exactly once across pages, the pinned band floats above the timeline and
 * paginates within itself, publication-time ties break on the row id, the popular sort
 * paginates by its own key, and a garbage or sort-mismatched cursor refuses with a 400.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { posts, users } from "@anthers/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `feedp_creator_${id}`;
const secondName = `feedp_second_${id}`;

type FeedPost = { id: number; isPinned: boolean; viewCount: number };

/** Walks a feed from its first page to a null cursor and returns every card it served. */
async function walkFeed(query: string, limit: number) {
	const seen: FeedPost[] = [];
	const pageCounts: number[] = [];
	let cursor: string | null = null;
	for (let page = 0; page < 20; page++) {
		const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
		const res = await req(`/api/content/posts?limit=${limit}${query}${cursorParam}`);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { posts: FeedPost[]; nextCursor: string | null };
		pageCounts.push(data.posts.length);
		seen.push(...data.posts);
		if (!data.nextCursor) return { seen, pageCounts };
		cursor = data.nextCursor;
	}
	throw new Error("cursor walk never terminated — the feed is serving pages forever");
}

describe("The unified timeline paginates", () => {
	let creatorCookie: string;
	let secondCookie: string;
	let secondHandle: string;
	// `order` is the first creator's nine posts, newest first — publication times are
	// staged a minute apart in the setup walk, i = 1 the newest.
	const order: number[] = [];
	// The second creator's four, oldest first (they are staged even older, below the nine).
	const secondOrder: number[] = [];

	beforeAll(async () => {
		// A previous failed run's rows share the `feedp_` email prefix — take them back
		// before the high-water fixture starts, so a leftover cannot collide with a fresh
		// account of the same name.
		await db.execute(sql`DELETE FROM users WHERE email LIKE ${`feedp_%${id}@example.com`}`);
	}, DB_SETUP_TIMEOUT);

	it(
		"sets up two creators and thirteen published posts",
		async () => {
			const creator = await createAccount(creatorName);
			creatorCookie = creator.cookie;
			await enablePayouts(creatorName);
			await db
				.update(users)
				.set({ creatorMode: true })
				.where(eq(users.atprotoHandle, creator.handle));

			const second = await createAccount(secondName);
			secondCookie = second.cookie;
			secondHandle = second.handle;
			await enablePayouts(secondName);
			await db
				.update(users)
				.set({ creatorMode: true })
				.where(eq(users.atprotoHandle, second.handle));

			// Nine timeline posts from the first creator: i minutes below the base, so i = 1
			// is the newest; each iteration pushes onto `order`, which ends newest first.
			const base = new Date("2026-08-01T12:00:00.000Z").getTime();
			for (let i = 1; i <= 9; i++) {
				const res = await req("/api/content/posts", {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
					body: JSON.stringify({
						title: `Feed post ${i} ${id}`,
						body: "body of the post",
						isPublished: true,
					}),
				});
				expect(res.status).toBe(201);
				const created = (await res.json()) as { post: { id: number } };
				await db
					.update(posts)
					.set({ publishedAt: new Date(base - i * 60_000) })
					.where(eq(posts.id, created.post.id));
				order.push(created.post.id);
			}

			// Four more from the second creator, staged well below the nine — older than all
			// of them, their own order strictly by recency among themselves (i minutes below
			// 20, oldest last).
			for (let i = 1; i <= 4; i++) {
				const res = await req("/api/content/posts", {
					method: "POST",
					headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: secondCookie },
					body: JSON.stringify({
						title: `Second post ${i} ${id}`,
						body: "body of the post",
						isPublished: true,
					}),
				});
				expect(res.status).toBe(201);
				const created = (await res.json()) as { post: { id: number } };
				await db
					.update(posts)
					.set({ publishedAt: new Date(base - (20 + i) * 60_000) })
					.where(eq(posts.id, created.post.id));
				secondOrder.push(created.post.id);
			}
		},
		DB_SETUP_TIMEOUT,
	);

	it("walks the whole timeline page by page without repeating or skipping a row", async () => {
		const { seen, pageCounts } = await walkFeed("", 3);
		// Thirteen visible posts, three per page except the last, which says stop.
		expect(pageCounts.slice(0, -1)).toEqual([3, 3, 3, 3]);
		expect(pageCounts[pageCounts.length - 1]).toBe(1);
		// Newest first across the whole board: the nine, then the second creator's four
		// (i = 1 carries the latest of their staged times, so push order is newest first).
		expect(seen.map((p) => p.id)).toEqual([...order, ...secondOrder]);
	});

	it("floats the pinned post above the timeline and paginates within the band", async () => {
		// Pin the middle-dweller of the nine.
		const pinnedId = order[4];
		await db.update(posts).set({ isPinned: true }).where(eq(posts.id, pinnedId));

		const { seen } = await walkFeed("", 3);
		expect(seen[0].id).toBe(pinnedId);
		// Everyone still surfaces exactly once, pinned first, the rest newest first.
		expect(seen.map((p) => p.id)).toEqual([
			pinnedId,
			...order.filter((p) => p !== pinnedId),
			...secondOrder,
		]);
	});

	it("breaks a publication-time tie on the row id instead of dropping a row", async () => {
		await db.update(posts).set({ isPinned: false }).where(eq(posts.id, order[4]));
		// The two newest posts now share one exact timestamp, newer than everything else:
		// they surface adjacently at the top, second-highest id first (order[1], order[0]),
		// and the equality band must not re-serve or swallow either.
		const share = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
		await db.update(posts).set({ publishedAt: share }).where(eq(posts.id, order[0]));
		await db.update(posts).set({ publishedAt: share }).where(eq(posts.id, order[1]));

		const { seen } = await walkFeed("", 2);
		const ids = seen.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.slice(0, 2)).toEqual([order[1], order[0]]);
		// And the walk still reaches the whole board.
		expect(ids.length).toBe(13);
	});

	it("paginates the popular sort by its own key", async () => {
		// Distinct view counts, deliberately unrelated to recency; the second creator's
		// four stay at zero, so the tail shows them ordered by recency under the tie.
		const counts = new Map<number, number>();
		for (let i = 0; i < order.length; i++) counts.set(order[i], (order.length - i) * 7);
		await db
			.update(posts)
			.set({ viewCount: 0 })
			.where(inArray(posts.id, [...order, ...secondOrder]));
		for (const [pid, count] of counts) {
			await db.update(posts).set({ viewCount: count }).where(eq(posts.id, pid));
		}

		const { seen } = await walkFeed("&sort=popular", 4);
		const ids = seen.map((p) => p.id);
		expect(ids).toEqual([...order, ...secondOrder]);
	});

	it("paginates a creator-filtered feed within the filter", async () => {
		const { seen } = await walkFeed(`&creator=${secondHandle}`, 2);
		expect(seen.map((p) => p.id)).toEqual(secondOrder);
	});

	it("serves a default page that does not truncate this board, with a null cursor", async () => {
		const res = await req("/api/content/posts");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { posts: FeedPost[]; nextCursor: string | null };
		expect(data.posts.length).toBe(13);
		expect(data.nextCursor).toBeNull();
	});

	it("refuses a cursor that does not match the sort being asked", async () => {
		const newest = await req("/api/content/posts?limit=2");
		const { nextCursor } = (await newest.json()) as { nextCursor: string | null };
		expect(nextCursor).toBeTruthy();
		const res = await req(
			`/api/content/posts?sort=popular&limit=2&cursor=${encodeURIComponent(nextCursor!)}`,
		);
		expect(res.status).toBe(400);
	});

	it("refuses a malformed cursor with a 400", async () => {
		const res = await req("/api/content/posts?cursor=not-a-cursor");
		expect(res.status).toBe(400);
	});

	it("refuses a non-positive or non-integer limit with a 400", async () => {
		expect((await req("/api/content/posts?limit=0")).status).toBe(400);
		expect((await req("/api/content/posts?limit=-3")).status).toBe(400);
		expect((await req("/api/content/posts?limit=wider")).status).toBe(400);
	});

	it("clamps an oversized limit instead of serving a huge page", async () => {
		const res = await req("/api/content/posts?limit=99999");
		expect(res.status).toBe(200);
		const data = (await res.json()) as { posts: FeedPost[] };
		// The whole visible board, whatever the ask.
		expect(data.posts.length).toBe(13);
	});
});
