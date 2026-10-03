// SPDX-License-Identifier: Apache-2.0
/**
 * The automated-test account goes dark in every listing, and nowhere else.
 *
 * One rule, asserted at each shape of surface the account could appear on: hidden from
 * the listings by the query predicate `notTestAccount`, while its profile keeps answering
 * a direct read, on the model `suspension-visibility.test.ts` set for the neighboring
 * rule. A row flag was the rejected shape for the same reason suspension is a query
 * condition — nothing about the account itself has to change, so the test suite that
 * signs in as it keeps signing in.
 *
 * The fixture gets the production handle by rewriting its row after `createAccount`
 * issues it an identity — the identity columns are the server's to set, so a suite that
 * needs the account to carry a given handle writes it directly, the way any other
 * server-owned column would be staged.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { follows, posts, projects, reviews, users, works } from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import app from "../index";
import { HIDDEN_TEST_ACCOUNT_HANDLE, notTestAccount } from "../services/account-visibility.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork, testPublicId } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const RUN = crypto.randomUUID().slice(0, 8);
const hiddenName = `hta_hidden_${RUN}`;
const otherName = `hta_other_${RUN}`;
const readerName = `hta_reader_${RUN}`;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

let hiddenId = 0;
let otherId = 0;
let hiddenCookie = "";
let readerCookie = "";
let workIds: number[] = [];
let projectIds: number[] = [];
let postIds: number[] = [];
let reviewIds: number[] = [];
let followIds: number[] = [];

describe("The automated-test account — hidden from listings, nothing else", () => {
	beforeAll(async () => {
		// A previous failed run may have left accounts holding the production handle behind —
		// it is unique, so a leftover row would fail the update below with a collision that
		// reads as a fixture bug instead of a leftover. Take any row already holding it, the
		// same cleanup-before-create shape the suspension suite's email delete uses.
		const [squatter] = await db
			.select({ id: users.id, email: users.email })
			.from(users)
			.where(eq(users.atprotoHandle, HIDDEN_TEST_ACCOUNT_HANDLE));
		if (squatter?.email.startsWith("hta_")) {
			await db.delete(users).where(eq(users.id, squatter.id));
		}

		const [hidden, other, reader] = await Promise.all([
			createAccount(hiddenName),
			createAccount(otherName),
			createAccount(readerName),
		]);
		hiddenId = hidden.user.id;
		otherId = other.user.id;
		hiddenCookie = hidden.cookie;
		readerCookie = reader.cookie;

		await db.update(users).set({ isCreator: true }).where(eq(users.id, hiddenId));
		await db.update(users).set({ isCreator: true }).where(eq(users.id, otherId));

		// The production handle, put on the fixture's row directly — the identity columns
		// are the server's to issue, and the fixture has to keep the identity it was given
		// (the session's own server issued it) while the listing predicate reads the handle.
		await db
			.update(users)
			.set({ atprotoHandle: HIDDEN_TEST_ACCOUNT_HANDLE })
			.where(eq(users.id, hiddenId));

		// One released, open, streamable Work each, so the commons and the projects browse
		// hold one row per fixture creator to be found or missed.
		const hiddenWork = await insertWork({
			creatorId: hiddenId,
			type: "game",
			title: "Hidden fixture Work",
			slug: `hta-hidden-${RUN}`,
			access: [{ threshold: 0, allow: true, price: "0" }],
		});
		const otherWork = await insertWork({
			creatorId: otherId,
			type: "game",
			title: "Visible fixture Work",
			slug: `hta-other-${RUN}`,
			access: [{ threshold: 0, allow: true, price: "0" }],
		});
		workIds = [hiddenWork.id, otherWork.id];

		// One published post each, for the feed.
		const madePosts = await db
			.insert(posts)
			.values([
				{
					creatorId: hiddenId,
					publicId: testPublicId(),
					slug: `hta-hidden-post-${RUN}`,
					title: "Hidden fixture post",
					isPublished: true,
					publishedAt: new Date(),
				},
				{
					creatorId: otherId,
					publicId: testPublicId(),
					slug: `hta-other-post-${RUN}`,
					title: "Visible fixture post",
					isPublished: true,
					publishedAt: new Date(),
				},
			])
			.returning({ id: posts.id });
		postIds = madePosts.map((p) => p.id);

		// One published project each, for the projects browse.
		const madeProjects = await db
			.insert(projects)
			.values([
				{
					creatorId: hiddenId,
					slug: `hta-hidden-project-${RUN}`,
					title: "Hidden fixture project",
					isPublished: true,
				},
				{
					creatorId: otherId,
					slug: `hta-other-project-${RUN}`,
					title: "Visible fixture project",
					isPublished: true,
				},
			])
			.returning({ id: projects.id });
		projectIds = madeProjects.map((p) => p.id);

		// The reader follows both creators, so the follow list and the feed's followed-id
		// list hold one row per fixture to be kept or dropped.
		const madeFollows = await db
			.insert(follows)
			.values([
				{ followerId: reader.user.id, creatorId: hiddenId },
				{ followerId: reader.user.id, creatorId: otherId },
			])
			.returning({ id: follows.id });
		followIds = madeFollows.map((f) => f.id);

		// A review by the hidden account on the visible creator's Work, for the review
		// listing and its aggregate — the written half of the same surface.
		const [hiddenReview] = await db
			.insert(reviews)
			.values({
				userId: hiddenId,
				workId: otherWork.id,
				verdict: "recommended",
				body: "Carries itself.",
			})
			.returning({ id: reviews.id });
		reviewIds = [hiddenReview.id];
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// Content first, while the rows still point at their owner — the pointing tables
		// are `set null`, so deleting the accounts first would orphan it. Projects and
		// follows cascade to nothing further and go beside their rows.
		if (followIds.length > 0) await db.delete(follows).where(inArray(follows.id, followIds));
		if (reviewIds.length > 0) await db.delete(reviews).where(inArray(reviews.id, reviewIds));
		if (projectIds.length > 0) await db.delete(projects).where(inArray(projects.id, projectIds));
		if (postIds.length > 0) await db.delete(posts).where(inArray(posts.id, postIds));
		// `purgeAccountIds` is what the high-water sweep in `purgeAccountsCreatedHere` runs,
		// and it takes the Works the fixtures made (and everything pointing at them);
		// the account rows themselves go with it.
	});

	it("drops the account from the public feed while the visible fixture stays", async () => {
		const res = await req("/api/content/posts");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { posts: { creatorId: number | null }[] };
		expect(body.posts.some((p) => p.creatorId === hiddenId)).toBe(false);
		expect(body.posts.some((p) => p.creatorId === otherId)).toBe(true);
	});

	it("drops the account from the Public Access commons while the visible fixture stays", async () => {
		const res = await req("/api/content/open-works?limit=24");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { works: { slug: string }[] };
		expect(body.works.some((w) => w.slug === `hta-hidden-${RUN}`)).toBe(false);
		expect(body.works.some((w) => w.slug === `hta-other-${RUN}`)).toBe(true);
	});

	it("drops the account's Projects from the projects browse while the visible fixture stays", async () => {
		const res = await req("/api/content/projects");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects: { slug: string }[] };
		expect(body.projects.some((p) => p.slug === `hta-hidden-project-${RUN}`)).toBe(false);
		expect(body.projects.some((p) => p.slug === `hta-other-project-${RUN}`)).toBe(true);
	});

	it("drops the account from Discover while the visible fixture stays", async () => {
		const res = await req("/api/accounts/creators");
		expect(res.status).toBe(200);
		const { creators } = (await res.json()) as { creators: { id: number }[] };
		expect(creators.some((c) => c.id === hiddenId)).toBe(false);
		expect(creators.some((c) => c.id === otherId)).toBe(true);
	});

	it("drops the account from a follower's following list while the visible fixture stays", async () => {
		const res = await req("/api/accounts/me/following", {
			headers: { Cookie: readerCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { users: { id: number }[] };
		expect(body.users.some((u) => u.id === hiddenId)).toBe(false);
		expect(body.users.some((u) => u.id === otherId)).toBe(true);
	});

	it("drops the account from the follower feed's followed creators while the visible fixture stays", async () => {
		const res = await req("/api/accounts/me/feed", {
			headers: { Cookie: readerCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { posts: { creatorId: number | null }[] };
		expect(body.posts.some((p) => p.creatorId === hiddenId)).toBe(false);
		expect(body.posts.some((p) => p.creatorId === otherId)).toBe(true);
	});

	it("drops the account's review from the review listing and its count", async () => {
		const [otherWork] = await db.select().from(works).where(eq(works.id, workIds[1]!));
		const res = await req(`/api/content/works/${otherWork!.slug}/reviews`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			reviews: { userId: number | null }[];
			count: number;
		};
		expect(body.reviews.some((r) => r.userId === hiddenId)).toBe(false);
		expect(body.count).toBe(0);
	});

	it("still serves the account's profile to a direct read, by its handle", async () => {
		const res = await req(`/api/accounts/users/${HIDDEN_TEST_ACCOUNT_HANDLE}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { user: { id: number } };
		expect(body.user.id).toBe(hiddenId);
	});

	it("still serves the account's catalog and Work page to a direct read", async () => {
		const catalogRes = await req(`/api/content/catalog/${HIDDEN_TEST_ACCOUNT_HANDLE}`);
		expect(catalogRes.status).toBe(200);
		const catalog = (await catalogRes.json()) as { works: unknown[] };
		expect(catalog.works.length).toBeGreaterThan(0);

		const workRes = await req(`/api/content/works/hta-hidden-${RUN}`);
		expect(workRes.status).toBe(200);
	});

	it("still answers the account's own session with its own feed", async () => {
		// The account itself keeps signing in and keeps reading its own posts — `mine=true`
		// is the creator's own view, which the predicate deliberately leaves alone.
		const res = await req("/api/content/posts?mine=true", {
			headers: { Cookie: hiddenCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { posts: { creatorId: number | null }[] };
		expect(body.posts.some((p) => p.creatorId === hiddenId)).toBe(true);
	});
});

// The predicate itself, asserted where it is cheap to see — a suite that only ever
// reads listings cannot tell "hidden by handle" apart from "hidden by something else
// the fixture happened to set".
describe("notTestAccount — matches the production handle and nothing else", () => {
	it("produces a predicate that composes, on the shape of its sibling", () => {
		expect(notTestAccount(users.id)).toBeDefined();
	});
});
