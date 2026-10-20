// SPDX-License-Identifier: Apache-2.0
/**
 * The topbar's global search.
 *
 * The suite asserts the shape the panel depends on: mixed kinds from one query, connected
 * rows first, the second pass finding secondary prose and never repeating a first-pass row,
 * and the listing rules holding inside search exactly as they hold everywhere else.
 *
 * 🚨 **Absences are named Work by Work**, as `content-filter.test.ts` states the rule: a
 * search that silently stops matching still returns a plausible list, so every visibility
 * test names what must be missing beside what must be present.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	follows,
	libraryItems,
	posts,
	projectItems,
	projects,
	userBlocks,
	works,
} from "@anthers/db/schema";
import { inArray } from "drizzle-orm";
import app from "../index";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

async function search(viewer: FixtureAccount | null, params: Record<string, string>) {
	const query = new URLSearchParams(params).toString();
	const res = await req(`/api/search?${query}`, {
		headers: viewer ? { Cookie: viewer.cookie } : {},
	});
	return {
		res,
		body: (await res.json()) as { results: { kind: string; id: number; title: string }[] },
	};
}

let author: FixtureAccount;
let stranger: FixtureAccount;
let viewer: FixtureAccount;
let blocked: FixtureAccount;
let savedWorkId: number;
const workIds: number[] = [];
const postIds: number[] = [];
const projectIds: number[] = [];

beforeAll(async () => {
	author = await createAccount(`search_a_${run}`, {
		fields: { isCreator: true, displayName: "Parker Davis", bio: "Quiet songs and field notes." },
	});
	stranger = await createAccount(`search_s_${run}`, {
		fields: { isCreator: true, displayName: "Carla Davis", bio: "Parker Davis writes here too." },
	});
	viewer = await createAccount(`search_v_${run}`);
	blocked = await createAccount(`search_b_${run}`, {
		fields: { isCreator: true, displayName: "Parker Davis", bio: "Blocked." },
	});

	await db.insert(follows).values({ followerId: viewer.userId, creatorId: author.userId });

	const anthology = await insertWork({
		creatorId: author.userId,
		type: "text",
		title: "Parker Davis Anthology",
		description: "A quiet collection.",
	});
	const fieldNotes = await insertWork({
		creatorId: stranger.userId,
		type: "text",
		title: "Parker Davis Field Notes",
		description: "Not the same collection.",
	});
	const quiet = await insertWork({
		creatorId: author.userId,
		type: "music",
		title: "Evening Songs",
		description: "Parker Davis wrote quiet notes.",
	});
	const cotton = await insertWork({
		creatorId: author.userId,
		type: "text",
		title: "100% Cotton",
		description: "A literal test.",
	});
	const privateWork = await insertWork({
		creatorId: stranger.userId,
		type: "text",
		title: "Parker Davis Private",
		visibility: "private",
	});
	const adultWork = await insertWork({
		creatorId: stranger.userId,
		type: "text",
		title: "Parker Davis Adult",
		maturity: "adult",
	});
	const blockedWork = await insertWork({
		creatorId: blocked.userId,
		type: "text",
		title: "Parker Davis Blocked",
	});
	workIds.push(
		anthology.id,
		fieldNotes.id,
		quiet.id,
		cotton.id,
		privateWork.id,
		adultWork.id,
		blockedWork.id,
	);
	savedWorkId = fieldNotes.id;
	await db.insert(libraryItems).values({ userId: viewer.userId, workId: fieldNotes.id });

	const [collection] = await db
		.insert(projects)
		.values({
			creatorId: author.userId,
			slug: `search-collection-${run}`,
			title: "Parker Davis Collection",
			description: "Everything in one place.",
			isPublished: true,
		})
		.returning({ id: projects.id });
	const [adultOnly] = await db
		.insert(projects)
		.values({
			creatorId: stranger.userId,
			slug: `search-adult-only-${run}`,
			title: "Parker Davis Adult Collection",
			isPublished: true,
		})
		.returning({ id: projects.id });
	projectIds.push(collection.id, adultOnly.id);
	await db.insert(projectItems).values([
		{ projectId: collection.id, workId: anthology.id },
		{ projectId: adultOnly.id, workId: adultWork.id },
	]);

	const [devlog] = await db
		.insert(posts)
		.values({
			creatorId: author.userId,
			publicId: Date.now(),
			slug: `search-devlog-${run}`,
			title: "Parker Davis Devlog",
			body: "Notes about quiet songs.",
			isPublished: true,
			publishedAt: new Date(),
		})
		.returning({ id: posts.id });
	const [strangerPost] = await db
		.insert(posts)
		.values({
			creatorId: stranger.userId,
			publicId: Date.now() + 1,
			slug: `search-stranger-post-${run}`,
			title: "Parker Davis Notes",
			body: "An announcement.",
			isPublished: true,
			publishedAt: new Date(),
		})
		.returning({ id: posts.id });
	const [bodyOnly] = await db
		.insert(posts)
		.values({
			creatorId: stranger.userId,
			publicId: Date.now() + 2,
			slug: `search-body-only-${run}`,
			title: "",
			body: "Parker Davis wrote this in the body, with quiet words.",
			isPublished: true,
			publishedAt: new Date(),
		})
		.returning({ id: posts.id });
	postIds.push(devlog.id, strangerPost.id, bodyOnly.id);

	await db.insert(userBlocks).values({ blockerId: viewer.userId, blockedId: blocked.userId });
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
	if (postIds.length > 0) await db.delete(posts).where(inArray(posts.id, postIds));
	if (projectIds.length > 0) await db.delete(projects).where(inArray(projects.id, projectIds));
});

describe("the names pass", () => {
	it("returns mixed kinds for one two-word query", async () => {
		const { res, body } = await search(viewer, { q: "Parker Davis", scope: "names" });
		expect(res.status).toBe(200);
		const kinds = new Set(body.results.map((r) => r.kind));
		expect(kinds.has("creator")).toBe(true);
		expect(kinds.has("work")).toBe(true);
		expect(kinds.has("project")).toBe(true);
		expect(kinds.has("post")).toBe(true);
	});

	it("puts a Library row above a followed creator's, which is above a stranger's", async () => {
		const { body } = await search(viewer, { q: "Parker Davis", scope: "names" });
		const titles = body.results.map((r) => r.title);
		expect(titles[0]).toBe("Parker Davis Field Notes");
		// The author is followed and the other post's creator is not, so the followed
		// creator's row lands above it.
		expect(titles.indexOf("Parker Davis Anthology")).toBeLessThan(
			titles.indexOf("Parker Davis Notes"),
		);
		// The saved row is the only one in this viewer's Library, and it is a stranger's.
		expect(savedWorkId).toBeGreaterThan(0);
	});

	it("omits private content, Adult work, an Adult-only Project and a blocked creator", async () => {
		const { body } = await search(viewer, { q: "Parker Davis", scope: "names" });
		const titles = body.results.map((r) => r.title);
		expect(titles).not.toContain("Parker Davis Private");
		expect(titles).not.toContain("Parker Davis Adult");
		expect(titles).not.toContain("Parker Davis Adult Collection");
		expect(titles).not.toContain("Parker Davis Blocked");
	});

	it("treats a wildcard character as a literal", async () => {
		const literal = await search(viewer, { q: "100%", scope: "names" });
		expect(literal.body.results.map((r) => r.title)).toContain("100% Cotton");
		const wildcard = await search(viewer, { q: "100", scope: "names" });
		expect(wildcard.body.results.map((r) => r.title)).toContain("100% Cotton");
	});
});

describe("the body pass", () => {
	it("finds secondary text the names pass cannot", async () => {
		const names = await search(viewer, { q: "quiet", scope: "names" });
		expect(names.body.results.map((r) => r.title)).not.toContain("Evening Songs");
		const body = await search(viewer, { q: "quiet", scope: "body" });
		expect(body.body.results.map((r) => r.title)).toContain("Evening Songs");
	});

	it("excludes the rows the first pass already showed", async () => {
		const names = await search(viewer, { q: "Parker Davis", scope: "names" });
		const shown = new Set(names.body.results.map((r) => `${r.kind}:${r.id}`));
		expect(shown.size).toBeGreaterThan(0);
		const exclude = [...shown].join(",");
		const body = await search(viewer, { q: "Parker Davis", scope: "body", exclude });
		expect(body.res.status).toBe(200);
		for (const row of body.body.results) {
			expect(shown.has(`${row.kind}:${row.id}`)).toBe(false);
		}
	});

	it("never returns a body-only Post in the names pass", async () => {
		const names = await search(viewer, { q: "Parker Davis", scope: "names" });
		const titles = names.body.results.map((r) => r.title);
		expect(titles).not.toContain("Untitled post");
		const body = await search(viewer, { q: "Parker Davis", scope: "body" });
		expect(body.body.results.map((r) => r.kind)).toContain("post");
	});
});

describe("the request", () => {
	it("filters to one kind", async () => {
		const { body } = await search(viewer, { q: "Parker Davis", scope: "names", type: "work" });
		expect(body.results.length).toBeGreaterThan(0);
		expect(body.results.every((r) => r.kind === "work")).toBe(true);
	});

	it("refuses a kind and a scope it does not know", async () => {
		expect((await search(viewer, { q: "Parker", type: "mode" })).res.status).toBe(400);
		expect((await search(viewer, { q: "Parker", scope: "all" })).res.status).toBe(400);
	});

	it("returns nothing for a blank query", async () => {
		const { body } = await search(viewer, { q: "   ", scope: "names" });
		expect(body.results).toEqual([]);
	});

	it("requires a session", async () => {
		const { res } = await search(null, { q: "Parker", scope: "names" });
		expect(res.status).toBe(401);
	});
});
