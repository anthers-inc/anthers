// SPDX-License-Identifier: Apache-2.0
/**
 * Discovery's two modes, as the routes behind them (Parker, 2026-10-19).
 *
 * - `GET /me/graph` ranks creators by how many of the people the viewer follows also
 *   follow them, and carries the edge count plus the vocabulary the shared Type and
 *   Tags filters read. A reader who follows nobody gets the stated follower-count
 *   fallback rather than an empty page with no explanation.
 * - `GET /me/feed?scope=global` is the Ticker: the same stream and card fields as the
 *   Network feed, widened to every creator. The default feed stays the network, so a
 *   creator the viewer does not follow must be absent from one and present in the
 *   other.
 *
 * 🚨 **The absence is half the test.** A global scope that quietly returned the
 * network's list would pass every presence assertion here, so each half names what it
 * must not contain.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { follows, posts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { insertWork, testPublicId } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function withCookie(cookie: string) {
	return { headers: { Origin: ORIGIN, Cookie: cookie } };
}

const SHARED_WORK = `Graph work ${run}`;
const SHARED_POST = `Graph post ${run}`;
const BLOCKED_WORK = `Blocked work ${run}`;
const TAG = `graph-tag-${run}`;

let viewerCookie = "";
let followedCreatorId = 0;
let unfollowedCreatorId = 0;

async function feed(cookie: string, query = "") {
	const res = await req(`/api/accounts/me/feed${query}`, withCookie(cookie));
	expect(res.status).toBe(200);
	return (await res.json()) as {
		entries: Array<{ kind: "post" | "release"; title: string; source: string }>;
	};
}

describe("Discovery's graph and ticker routes", () => {
	beforeAll(async () => {
		const viewer = await createAccount(`dsc_viewer_${run}`);
		const followed = await createAccount(`dsc_followed_${run}`, { fields: { isCreator: true } });
		await createAccount(`dsc_unfollowed_${run}`, { fields: { isCreator: true } });
		viewerCookie = viewer.cookie;

		const [followedRow] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, `dsc_followed_${run}@example.com`));
		const [unfollowedRow] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, `dsc_unfollowed_${run}@example.com`));
		expect(followedRow, "the followed creator exists").toBeDefined();
		expect(unfollowedRow, "the unfollowed creator exists").toBeDefined();
		followedCreatorId = followedRow!.id;
		unfollowedCreatorId = unfollowedRow!.id;

		// The viewer follows one creator; that creator follows the other. The second
		// creator is therefore in the viewer's network by one edge, though the viewer
		// never follows them.
		await db
			.insert(follows)
			.values({ followerId: followedCreatorId, creatorId: unfollowedCreatorId });

		await insertWork({
			creatorId: followedCreatorId,
			type: "text",
			title: `Followed creator's work ${run}`,
		});
		const work = await insertWork({
			creatorId: unfollowedCreatorId,
			type: "text",
			title: SHARED_WORK,
			tags: [TAG],
		});
		expect(work.id).toBeGreaterThan(0);

		await db.insert(posts).values({
			creatorId: unfollowedCreatorId,
			title: SHARED_POST,
			slug: `dsc-post-${run}`,
			publicId: testPublicId(),
			isPublished: true,
			tags: [TAG],
		});

		await req(`/api/accounts/users/${followed.handle}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: viewer.cookie },
		});

		// A creator the viewer blocks is absent from the global Ticker even though no
		// creator list filtered them out first — the row filters are what have to hold.
		const blocked = await createAccount(`dsc_blocked_${run}`, { fields: { isCreator: true } });
		await insertWork({
			creatorId: (
				await db
					.select({ id: users.id })
					.from(users)
					.where(eq(users.email, `dsc_blocked_${run}@example.com`))
			)[0]!.id,
			type: "text",
			title: BLOCKED_WORK,
		});
		await req(`/api/accounts/users/${blocked.handle}/block`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: viewer.cookie },
		});
	});

	it("ranks a creator by the follows the viewer and their network share", async () => {
		const res = await req("/api/accounts/me/graph", withCookie(viewerCookie));
		expect(res.status).toBe(200);
		const data = (await res.json()) as {
			basis: string;
			creators: Array<{
				id: number;
				sharedFollows: number;
				types: string[];
				hasPosts: boolean;
				tags: string[];
			}>;
		};

		expect(data.basis).toBe("network");
		const creator = data.creators.find((row) => row.id === unfollowedCreatorId);
		expect(creator, "the one-edge creator is in the graph").toBeDefined();
		expect(creator?.sharedFollows).toBe(1);
		expect(creator?.types).toContain("text");
		expect(creator?.hasPosts).toBe(true);
		expect(creator?.tags).toContain(TAG);
	});

	it("says which formula it ran when the viewer follows nobody", async () => {
		const lonely = await createAccount(`dsc_lonely_${run}`);
		const res = await req("/api/accounts/me/graph", withCookie(lonely.cookie));
		expect(res.status).toBe(200);
		const data = (await res.json()) as { basis: string };
		expect(data.basis).toBe("followers");
	});

	it("keeps the network feed to the network", async () => {
		const network = await feed(viewerCookie);
		const titles = network.entries.map((entry) => entry.title);
		expect(titles).not.toContain(SHARED_WORK);
		expect(titles).not.toContain(SHARED_POST);
	});

	it("widens the ticker to every creator and labels why an entry is there", async () => {
		const ticker = await feed(viewerCookie, "?scope=global");
		const byTitle = new Map(ticker.entries.map((entry) => [entry.title, entry]));
		expect(byTitle.get(SHARED_WORK)?.kind).toBe("release");
		expect(byTitle.get(SHARED_POST)?.kind).toBe("post");
		expect(byTitle.get(SHARED_WORK)?.source).toBe("discovery");
		expect(byTitle.get(SHARED_POST)?.source).toBe("discovery");
	});

	it("keeps a blocked creator out of the global ticker", async () => {
		const ticker = await feed(viewerCookie, "?scope=global");
		expect(ticker.entries.map((entry) => entry.title)).not.toContain(BLOCKED_WORK);
	});
});
