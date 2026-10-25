// SPDX-License-Identifier: Apache-2.0
/**
 * The routes behind Discovery, and the graph it no longer draws (Parker, 2026-10-19;
 * Discovery became one stream on 2026-10-23).
 *
 * - `GET /me/graph` ranks creators by how many of the people the viewer follows also
 *   follow them, and carries the edge count plus the vocabulary the shared Type and
 *   Tags filters read. No page calls it today; the graph waits on a platform with
 *   enough content for the edges to say something, and the route keeps its own shape.
 *   A reader who follows nobody gets the stated follower-count fallback rather than an
 *   empty page with no explanation.
 * - `GET /me/feed?scope=global` is the stream Discovery shows: the same stream and card
 *   fields as the Network feed, widened to every creator. The default feed stays the
 *   network, so a creator the viewer does not follow must be absent from one and
 *   present in the other. Discovery's recipe rides two parameters over that stream —
 *   `mix=spread|straight` reorders it and `scope` chooses the candidate set — and an
 *   absent `mix` keeps each stream's historic order.
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
import { enablePayoutsFor } from "./payouts-fixture";
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
const BUSY_WORK = `Busy creator's run ${run}`;
const TAG = `graph-tag-${run}`;

let viewerCookie = "";
let followedCreatorId = 0;
let unfollowedCreatorId = 0;
let busyCreatorId = 0;
let secondFollowedCreatorId = 0;

async function feed(cookie: string, query = "") {
	const res = await req(`/api/accounts/me/feed${query}`, withCookie(cookie));
	expect(res.status).toBe(200);
	return (await res.json()) as {
		entries: Array<{
			kind: "post" | "release";
			id: number;
			title: string;
			source: string;
			creatorId: number;
			reason?: { stage: string; code: string; label: string };
		}>;
	};
}

describe("Discovery's graph and ticker routes", () => {
	beforeAll(async () => {
		const viewer = await createAccount(`dsc_viewer_${run}`);
		const followed = await createAccount(`dsc_followed_${run}`);
		const unfollowed = await createAccount(`dsc_unfollowed_${run}`);
		await enablePayoutsFor(followed.userId);
		await enablePayoutsFor(unfollowed.userId);
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
		const blocked = await createAccount(`dsc_blocked_${run}`, { fields: { creatorMode: true } });
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

		// A second creator the viewer follows, with a run of three, so the network
		// candidate set has two lanes and the mix has something to spread. Inserted
		// before the busy run, which must stay the newest thing in the whole-site stream.
		const secondFollowed = await createAccount(`dsc_followed2_${run}`, {
			fields: { creatorMode: true },
		});
		secondFollowedCreatorId = (
			await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, `dsc_followed2_${run}@example.com`))
		)[0]!.id;
		for (let index = 0; index < 3; index += 1) {
			await insertWork({
				creatorId: secondFollowedCreatorId,
				type: "text",
				title: `Second followed creator's work ${index} ${run}`,
			});
		}
		await req(`/api/accounts/users/${secondFollowed.handle}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: viewer.cookie },
		});

		// A creator who posts a run of four, inserted last so they are the newest
		// entries in the whole-site stream. Without the mix stage this is exactly the
		// run that takes four of the page's first five cards.
		await createAccount(`dsc_busy_${run}`, { fields: { creatorMode: true } });
		busyCreatorId = (
			await db
				.select({ id: users.id })
				.from(users)
				.where(eq(users.email, `dsc_busy_${run}@example.com`))
		)[0]!.id;
		for (let index = 0; index < 4; index += 1) {
			await insertWork({
				creatorId: busyCreatorId,
				type: "text",
				title: `${BUSY_WORK} ${index}`,
			});
		}
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

	it("says which recipe it ran when the viewer follows nobody", async () => {
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

	it("carries a structured reason with every entry, saying it is the newest across Anthers", async () => {
		const ticker = await feed(viewerCookie, "?scope=global");
		expect(ticker.entries.length).toBeGreaterThan(0);
		for (const entry of ticker.entries) {
			expect(entry.reason, `${entry.title} carries no reason`).toBeDefined();
			expect(entry.reason?.stage).toBe("candidates");
			expect(entry.reason?.code).toBe("discovery");
			expect(entry.reason?.label).toBe("Newest across Anthers");
		}
	});

	it("spreads one creator's run across the stream instead of stacking it", async () => {
		const ticker = await feed(viewerCookie, "?scope=global&mix=spread");
		const creators = ticker.entries.map((entry) => entry.creatorId);
		const busyTitles = ticker.entries
			.filter((entry) => entry.creatorId === busyCreatorId)
			.map((entry) => entry.title);

		// The run is real and complete: four entries, in the ticker.
		expect(busyTitles.sort()).toEqual([0, 1, 2, 3].map((index) => `${BUSY_WORK} ${index}`).sort());
		// The mix ran: round one is one card per creator, so the top of the page covers
		// every creator in the stream rather than one creator's run. Newest-first would
		// have made the first four cards all this creator's.
		const lanes = new Set(creators);
		expect(lanes.size).toBeGreaterThan(1);
		expect(new Set(creators.slice(0, lanes.size)).size).toBe(lanes.size);
		expect(creators.slice(0, 4).filter((id) => id === busyCreatorId).length).toBeLessThan(4);
	});

	it("leaves the newest run stacked when the recipe asks for no mix, which is the absence the spread test needs", async () => {
		const straight = await feed(viewerCookie, "?scope=global&mix=straight");
		const firstFour = straight.entries.slice(0, 4).map((entry) => entry.creatorId);

		expect(firstFour.every((id) => id === busyCreatorId)).toBe(true);
	});

	it("runs the chosen mix over the network candidate set too", async () => {
		const straight = await feed(viewerCookie, "?scope=network&mix=straight");
		const straightCreators = straight.entries.slice(0, 3).map((entry) => entry.creatorId);
		// The second followed creator's three are the newest thing in this candidate set,
		// so no mix leaves them adjacent.
		expect(straightCreators).toEqual([
			secondFollowedCreatorId,
			secondFollowedCreatorId,
			secondFollowedCreatorId,
		]);

		const spread = await feed(viewerCookie, "?scope=network&mix=spread");
		const spreadCreators = spread.entries.slice(0, 3).map((entry) => entry.creatorId);
		expect(new Set(spreadCreators).size).toBeGreaterThan(1);
		// Same entries, different order: the mix reorders the page, it does not reselect it.
		expect(spread.entries.map((entry) => entry.id).sort()).toEqual(
			straight.entries.map((entry) => entry.id).sort(),
		);
	});

	it("keeps the network feed's own default order when no recipe names a mix", async () => {
		const bare = await feed(viewerCookie, "?scope=network");
		const straight = await feed(viewerCookie, "?scope=network&mix=straight");
		expect(bare.entries.map((entry) => entry.title)).toEqual(
			straight.entries.map((entry) => entry.title),
		);
	});
});
