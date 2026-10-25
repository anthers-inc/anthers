// SPDX-License-Identifier: Apache-2.0
/**
 * Filter mode on the feed.
 *
 * The feed paginates, so its filter has to be a server condition applied before the cap —
 * a client-side filter would search only what had been scrolled into view. The suite
 * proves the condition reaches both halves (posts and releases) and that the creator's
 * names are part of what it matches, because "Parker Davis" is a person as often as it is
 * a title.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { follows, posts } from "@anthers/db/schema";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);

function req(path: string, cookie: string) {
	return app.fetch(new Request(`http://localhost${path}`, { headers: { Cookie: cookie } }));
}

async function feed(cookie: string, q: string) {
	const res = await req(`/api/accounts/me/feed?q=${encodeURIComponent(q)}`, cookie);
	expect(res.status).toBe(200);
	return ((await res.json()) as { entries: { kind: string; title: string }[] }).entries;
}

let author: FixtureAccount;
let viewer: FixtureAccount;

beforeAll(async () => {
	author = await createAccount(`feedsearch_a_${run}`, {
		fields: { creatorMode: true, displayName: "Carla Author" },
	});
	viewer = await createAccount(`feedsearch_v_${run}`);
	await db.insert(follows).values({ followerId: viewer.userId, creatorId: author.userId });

	await db.insert(posts).values([
		{
			creatorId: author.userId,
			publicId: Date.now(),
			slug: `feedsearch-title-${run}`,
			title: "Parker Davis Devlog",
			body: "Notes about the release.",
			isPublished: true,
			publishedAt: new Date(),
		},
		{
			creatorId: author.userId,
			publicId: Date.now() + 1,
			slug: `feedsearch-body-${run}`,
			title: "Quiet Post",
			body: "Parker Davis wrote this in the body.",
			isPublished: true,
			publishedAt: new Date(),
		},
		{
			creatorId: author.userId,
			publicId: Date.now() + 2,
			slug: `feedsearch-unrelated-${run}`,
			title: "Unrelated Announcement",
			body: "Nothing to see here.",
			isPublished: true,
			publishedAt: new Date(),
		},
	]);

	await insertWork({
		creatorId: author.userId,
		type: "text",
		title: "Parker Davis Work",
		description: "A release in the feed.",
	});
}, DB_SETUP_TIMEOUT);

describe("filter mode on the feed", () => {
	it("matches titles, bodies and releases, and drops what does not match", async () => {
		const entries = await feed(viewer.cookie, "Parker Davis");
		const titles = entries.map((entry) => entry.title);
		expect(titles).toContain("Parker Davis Devlog");
		expect(titles).toContain("Parker Davis Work");
		// A post whose body carries both words matches too; the feed's post half searches
		// its body, not only its title.
		expect(titles).toContain("Quiet Post");
		expect(titles).not.toContain("Unrelated Announcement");
	});

	it("requires every term", async () => {
		const entries = await feed(viewer.cookie, "Parker Nonexistent");
		expect(entries).toEqual([]);
	});

	it("keeps the creator's own name in scope", async () => {
		const entries = await feed(viewer.cookie, "Carla");
		expect(entries.map((entry) => entry.title)).toContain("Unrelated Announcement");
	});
});
