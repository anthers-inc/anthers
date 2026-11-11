// SPDX-License-Identifier: Apache-2.0
/**
 * Hiding a Work or a creator from Discovery — and the boundary that makes it a preference
 * rather than a block.
 *
 * 🚨 **The absence is only half of it.** A hide list that filtered every listing would pass
 * a suite that only asserted the entry vanished from the stream, and it would be the wrong
 * feature: the task's own words are that the Work stays reachable by direct link and search,
 * which is precisely what separates *Don't Show this Work* from Blocked Accounts. So each
 * hide is asserted twice — gone from the feed, still there at its own address — and there is
 * a search assertion for the same reason.
 *
 * ⚠️ **Per-user, not site-wide.** Hiding is one reader's view, so a second account is walked
 * through the same listing and must still see both entries. That is the assertion that would
 * catch the filter being written into a shared place.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { follows, posts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
const ORIGIN = "http://localhost:3000";

function req(path: string, cookie?: string, options?: RequestInit) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			...options,
			headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...options?.headers },
		}),
	);
}

function hide(cookie: string, path: string) {
	return req(`/api/accounts/me/hidden/${path}`, cookie, { method: "POST" });
}

function showAgain(cookie: string, path: string) {
	return req(`/api/accounts/me/hidden/${path}`, cookie, { method: "DELETE" });
}

interface FeedRow {
	kind: string;
	id: number;
	title: string | null;
	creatorId: number | null;
}

async function feed(cookie: string, scope = ""): Promise<FeedRow[]> {
	const res = await req(`/api/accounts/me/feed${scope}`, cookie);
	expect(res.status).toBe(200);
	return ((await res.json()) as { entries: FeedRow[] }).entries;
}

let author: FixtureAccount;
let viewer: FixtureAccount;
let other: FixtureAccount;
let hiddenWork: { id: number; publicId: number; slug: string };
let keptWork: { id: number; publicId: number; slug: string };
let postTitle: string;

beforeAll(async () => {
	author = await createAccount(`hide_a_${run}`, {
		fields: { creatorMode: true, displayName: "Hana Author" },
	});
	viewer = await createAccount(`hide_v_${run}`);
	other = await createAccount(`hide_o_${run}`);
	await db.insert(follows).values([
		{ followerId: viewer.userId, creatorId: author.userId },
		{ followerId: other.userId, creatorId: author.userId },
	]);

	hiddenWork = await insertWork({
		creatorId: author.userId,
		type: "text",
		title: `Hide me ${run}`,
		description: "A Work this reader will hide.",
	});
	keptWork = await insertWork({
		creatorId: author.userId,
		type: "text",
		title: `Keep me ${run}`,
		description: "A Work the same creator also released.",
	});

	postTitle = `Author post ${run}`;
	await db.insert(posts).values({
		creatorId: author.userId,
		publicId: Date.now(),
		slug: `hide-post-${run}`,
		title: postTitle,
		body: "An announcement from this creator.",
		isPublished: true,
		publishedAt: new Date(),
	});
}, DB_SETUP_TIMEOUT);

describe("hiding one Work", () => {
	it("takes that entry out of the stream and leaves the creator's other Work", async () => {
		expect((await hide(viewer.cookie, `works/${hiddenWork.id}`)).status).toBe(201);

		for (const scope of ["", "?scope=global"]) {
			const entries = await feed(viewer.cookie, scope);
			expect(
				entries.map((entry) => entry.title),
				`feed${scope}`,
			).not.toContain(`Hide me ${run}`);
			expect(
				entries.map((entry) => entry.title),
				`feed${scope}`,
			).toContain(`Keep me ${run}`);
			// Hiding a Work says nothing about its creator, so the post stays.
			expect(
				entries.map((entry) => entry.title),
				`feed${scope}`,
			).toContain(postTitle);
		}
	});

	it("leaves the Work reachable at its own address and in search", async () => {
		const direct = await req(`/api/content/works/${hiddenWork.publicId}`, viewer.cookie);
		expect(direct.status, "a hidden Work must still open by direct link").toBe(200);

		const search = await req(
			`/api/search?q=${encodeURIComponent(`Hide me ${run}`)}`,
			viewer.cookie,
		);
		expect(search.status).toBe(200);
		const { results } = (await search.json()) as { results: { kind: string; title: string }[] };
		expect(
			results.some((hit) => hit.kind === "work" && hit.title === `Hide me ${run}`),
			"a hidden Work must still be found by search",
		).toBe(true);
	});

	it("is one reader's list, not the site's", async () => {
		const entries = await feed(other.cookie);
		expect(entries.map((entry) => entry.title)).toContain(`Hide me ${run}`);
	});

	it("comes back when the reader says so", async () => {
		expect((await showAgain(viewer.cookie, `works/${hiddenWork.id}`)).status).toBe(204);
		const entries = await feed(viewer.cookie);
		expect(entries.map((entry) => entry.title)).toContain(`Hide me ${run}`);
	});
});

describe("hiding a creator", () => {
	it("takes their posts and releases out of the stream, and nothing else", async () => {
		expect((await hide(viewer.cookie, `creators/${author.userId}`)).status).toBe(201);

		for (const scope of ["", "?scope=global"]) {
			const titles = (await feed(viewer.cookie, scope)).map((entry) => entry.title);
			expect(titles, `feed${scope}`).not.toContain(`Hide me ${run}`);
			expect(titles, `feed${scope}`).not.toContain(`Keep me ${run}`);
			expect(titles, `feed${scope}`).not.toContain(postTitle);
		}
	});

	it("leaves the profile and the Work reachable", async () => {
		const profile = await req(`/api/accounts/users/${author.handle}`, viewer.cookie);
		expect(profile.status, "a hidden creator's profile must still resolve").toBe(200);

		const work = await req(`/api/content/works/${keptWork.publicId}`, viewer.cookie);
		expect(work.status).toBe(200);
	});

	it("refuses to hide the reader's own account", async () => {
		const res = await hide(viewer.cookie, `creators/${viewer.userId}`);
		expect(res.status).toBe(400);
	});

	it("is still one reader's list", async () => {
		const titles = (await feed(other.cookie)).map((entry) => entry.title);
		expect(titles).toContain(`Keep me ${run}`);
		expect(titles).toContain(postTitle);
	});

	it("comes back when the reader says so", async () => {
		expect((await showAgain(viewer.cookie, `creators/${author.userId}`)).status).toBe(204);
		const titles = (await feed(viewer.cookie)).map((entry) => entry.title);
		expect(titles).toContain(`Keep me ${run}`);
		expect(titles).toContain(postTitle);
	});
});

describe("the settings lists", () => {
	it("names what is hidden, and empties as each row is cleared", async () => {
		await hide(viewer.cookie, `works/${hiddenWork.id}`);
		await hide(viewer.cookie, `creators/${author.userId}`);

		const listed = await req("/api/accounts/me/hidden", viewer.cookie);
		expect(listed.status).toBe(200);
		const lists = (await listed.json()) as {
			works: { id: number; title: string }[];
			creators: { id: number; handle: string }[];
		};
		expect(lists.works.map((row) => row.id)).toContain(hiddenWork.id);
		expect(lists.creators.map((row) => row.id)).toContain(author.userId);

		await showAgain(viewer.cookie, `works/${hiddenWork.id}`);
		await showAgain(viewer.cookie, `creators/${author.userId}`);
		const cleared = (await (await req("/api/accounts/me/hidden", viewer.cookie)).json()) as {
			works: { id: number }[];
			creators: { id: number }[];
		};
		expect(cleared.works.map((row) => row.id)).not.toContain(hiddenWork.id);
		expect(cleared.creators.map((row) => row.id)).not.toContain(author.userId);
	});

	it("is empty for an account that has hidden nothing", async () => {
		const lists = (await (await req("/api/accounts/me/hidden", other.cookie)).json()) as {
			works: unknown[];
			creators: unknown[];
		};
		expect(lists).toEqual({ works: [], creators: [] });
	});
});

describe("the cascade the pair tables rely on", () => {
	it("drops both rows when the Work and the creator are deleted", async () => {
		await hide(viewer.cookie, `works/${keptWork.id}`);
		await hide(viewer.cookie, `creators/${author.userId}`);

		// One delete exercises both foreign keys: the creator's Works go with the account,
		// and `hidden_works.work_id` and `hidden_creators.creator_id` go with them. A JSON
		// column of ids on `user_preferences` could do neither.
		await db.delete(posts).where(eq(posts.creatorId, author.userId));
		await db.delete(users).where(eq(users.id, author.userId));

		const lists = (await (await req("/api/accounts/me/hidden", viewer.cookie)).json()) as {
			works: { id: number }[];
			creators: { id: number }[];
		};
		expect(lists.works.map((row) => row.id)).not.toContain(keptWork.id);
		expect(lists.creators.map((row) => row.id)).not.toContain(author.userId);
	});
});
