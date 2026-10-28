// SPDX-License-Identifier: Apache-2.0
/**
 * The Network tab's widened membership (Parker, 2026-10-19).
 *
 * The default network is who the reader follows, who they support with a Badge, and
 * who made the posts and Works they saved or bought. `network_source` narrows it to
 * one of those routes in, with `following` preserving the old feed exactly.
 *
 * 🚨 **Each narrow assertion names what must be absent.** A route that ignored
 * `network_source` and returned the whole network would pass every presence check,
 * so each case also excludes the creators it did not ask for. The default case
 * excludes a stranger, which is the one account no route should reach.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	badges,
	follows,
	posts,
	purchases,
	userBadges,
	userLibraryItems,
	users,
} from "@anthers/db/schema";
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

const FOLLOWED = `Followed work ${run}`;
const SUBSCRIBED = `Supported work ${run}`;
const SAVED_POST = `Saved post ${run}`;
const SAVED_WORK = `Saved work ${run}`;
const PURCHASED = `Purchased work ${run}`;
const STRANGER = `Stranger work ${run}`;

let viewerCookie = "";
let followedId = 0;
let subscribedId = 0;
let savedId = 0;
let purchasedId = 0;
let purchaseId = 0;

async function feed(cookie: string, query = "") {
	const res = await req(`/api/accounts/me/feed${query}`, withCookie(cookie));
	expect(res.status).toBe(200);
	return (await res.json()) as {
		entries: Array<{ kind: "post" | "release"; title: string; source: string }>;
	};
}

const titles = (entries: Array<{ title: string }>) => entries.map((entry) => entry.title);
const sourceOf = (entries: Array<{ title: string; source: string }>, title: string) =>
	entries.find((entry) => entry.title === title)?.source;

async function userIdFor(email: string) {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
	expect(row, `${email} exists`).toBeDefined();
	return row!.id;
}

beforeAll(async () => {
	const viewer = await createAccount(`netmem_viewer_${run}`);
	await createAccount(`netmem_followed_${run}`, { fields: { creatorMode: true } });
	await createAccount(`netmem_subscribed_${run}`, { fields: { creatorMode: true } });
	await createAccount(`netmem_saved_${run}`, { fields: { creatorMode: true } });
	await createAccount(`netmem_purchased_${run}`, { fields: { creatorMode: true } });
	await createAccount(`netmem_stranger_${run}`, { fields: { creatorMode: true } });
	viewerCookie = viewer.cookie;

	followedId = await userIdFor(`netmem_followed_${run}@example.com`);
	subscribedId = await userIdFor(`netmem_subscribed_${run}@example.com`);
	savedId = await userIdFor(`netmem_saved_${run}@example.com`);
	purchasedId = await userIdFor(`netmem_purchased_${run}@example.com`);
	const strangerId = await userIdFor(`netmem_stranger_${run}@example.com`);
	const viewerId = await userIdFor(`netmem_viewer_${run}@example.com`);

	await db.insert(follows).values({ followerId: viewerId, creatorId: followedId });

	const [rung] = await db
		.insert(badges)
		.values({ creatorId: subscribedId, threshold: "3", label: `Member ${run}` })
		.returning({ id: badges.id });
	await db.insert(userBadges).values({
		userId: viewerId,
		badgeId: rung!.id,
		billingCycle: "2026-10",
	});

	await insertWork({ creatorId: followedId, type: "text", title: FOLLOWED });
	await insertWork({ creatorId: subscribedId, type: "text", title: SUBSCRIBED });
	const savedWork = await insertWork({ creatorId: savedId, type: "text", title: SAVED_WORK });
	await db.insert(posts).values({
		creatorId: savedId,
		title: SAVED_POST,
		slug: `netmem-post-${run}`,
		publicId: testPublicId(),
		isPublished: true,
	});
	await db.insert(userLibraryItems).values([
		{ userId: viewerId, workId: savedWork.id },
		// `postId` needs the row id, so the post is read back after its insert.
	]);
	const [savedPost] = await db
		.select({ id: posts.id })
		.from(posts)
		.where(eq(posts.creatorId, savedId))
		.limit(1);
	await db.insert(userLibraryItems).values({ userId: viewerId, postId: savedPost!.id });

	const purchasedWork = await insertWork({
		creatorId: purchasedId,
		type: "text",
		title: PURCHASED,
	});
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId: viewerId,
			workId: purchasedWork.id,
			creatorId: purchasedId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.30",
			salesTax: "0.00",
			creatorEarnings: "4.70",
			stripePaymentIntentId: `pi_netmem_${run}`,
			status: "completed",
		})
		.returning({ id: purchases.id });
	purchaseId = purchase!.id;

	await insertWork({ creatorId: strangerId, type: "text", title: STRANGER });
});

afterAll(async () => {
	// A purchase's buyer is set null rather than cascaded, so the financial row
	// outlives the account. This suite's row names a test Work and no money moved, so
	// it is removed by id before the account sweep.
	if (purchaseId > 0) await db.delete(purchases).where(eq(purchases.id, purchaseId));
});

describe("the Network tab's default membership", () => {
	it("draws follows, support, and saved or purchased creators", async () => {
		const entries = (await feed(viewerCookie)).entries;
		const seen = titles(entries);
		for (const title of [FOLLOWED, SUBSCRIBED, SAVED_POST, SAVED_WORK, PURCHASED]) {
			expect(seen, `${title} is in the network`).toContain(title);
		}
		expect(seen, "a stranger is never in the network").not.toContain(STRANGER);
	});

	it("says which route put each creator in the stream", async () => {
		const entries = (await feed(viewerCookie)).entries;
		expect(sourceOf(entries, FOLLOWED)).toBe("following");
		expect(sourceOf(entries, SUBSCRIBED)).toBe("subscribed");
		expect(sourceOf(entries, SAVED_POST)).toBe("saved");
		expect(sourceOf(entries, SAVED_WORK)).toBe("saved");
		expect(sourceOf(entries, PURCHASED)).toBe("saved");
	});
});

describe("the Network membership filter", () => {
	it("keeps following-only to the creators the reader follows", async () => {
		const seen = titles((await feed(viewerCookie, "?network_source=following")).entries);
		expect(seen).toContain(FOLLOWED);
		for (const title of [SUBSCRIBED, SAVED_POST, SAVED_WORK, PURCHASED, STRANGER]) {
			expect(seen).not.toContain(title);
		}
	});

	it("keeps support-only to the creators whose Badge the reader holds", async () => {
		const seen = titles((await feed(viewerCookie, "?network_source=subscribed")).entries);
		expect(seen).toContain(SUBSCRIBED);
		for (const title of [FOLLOWED, SAVED_POST, SAVED_WORK, PURCHASED, STRANGER]) {
			expect(seen).not.toContain(title);
		}
	});

	it("keeps saved-only to saved posts, saved Works, and purchases", async () => {
		const seen = titles((await feed(viewerCookie, "?network_source=saved")).entries);
		for (const title of [SAVED_POST, SAVED_WORK, PURCHASED]) {
			expect(seen).toContain(title);
		}
		for (const title of [FOLLOWED, SUBSCRIBED, STRANGER]) {
			expect(seen).not.toContain(title);
		}
	});

	it("drops a creator the reader blocks from every view", async () => {
		const handle = (
			await db.select({ handle: users.atprotoHandle }).from(users).where(eq(users.id, savedId))
		)[0]!.handle!;
		const blocked = await req(`/api/accounts/users/${handle}/block`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: viewerCookie },
		});
		expect(blocked.status).toBe(201);

		for (const query of ["", "?network_source=saved"]) {
			const seen = titles((await feed(viewerCookie, query)).entries);
			expect(seen, `blocked creator leaks under "${query}"`).not.toContain(SAVED_POST);
			expect(seen).not.toContain(SAVED_WORK);
		}
	});
});
