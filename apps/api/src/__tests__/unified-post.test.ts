// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Catalog vertical slice — proves the Catalog/Posts split end to end against the real dev
 * database:
 *   upload a Work → back-date it → release it → it appears in the public Catalog in
 *   Created-date order → access gating via the two access tables → access-checked signed
 *   download → an announcement post that links it and confers nothing.
 *
 * This is the walk that motivated the whole revamp: a creator migrating old work should be
 * able to publish a 2015 game, dated 2015, without inventing a post for it.
 *
 * Works are game/text so nothing hits real media processing (no pg-boss).
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { sql } from "drizzle-orm";
import app from "../index";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string) {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `creator_${id}`;
const otherName = `viewer_${id}`;

describe("Catalog vertical slice", () => {
	let creatorCookie: string;
	let otherCookie: string;
	let oldGameId: number;
	let recentEssayId: number;
	let paidAssetId: number;
	let announcementSlug: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${otherName})`);
	});

	it("signs up a creator and a viewer", async () => {
		creatorCookie = await signUp(creatorName);
		otherCookie = await signUp(otherName);
		expect(creatorCookie).toBeTruthy();
		expect(otherCookie).toBeTruthy();
	});

	it("uploads a game to the Catalog, back-dated to the year it was actually made", async () => {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				type: "game",
				title: `Old Game ${id}`,
				description: "Made years before Anthers existed",
				streamEnabled: false,
				downloadEnabled: true,
				authoredAt: "2015-01-01T00:00:00.000Z",
				authoredPrecision: "year",
			}),
		});
		expect(res.status).toBe(201);
		const { work } = await res.json();
		oldGameId = work.id;
		expect(work.visibility).toBe("private");
		expect(work.authoredPrecision).toBe("year");
	});

	it("attaches a downloadable build to it", async () => {
		const res = await req(`/api/content/works/${oldGameId}/assets`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				file: `creators/test/${id}/build.zip`,
				filename: "build.zip",
				fileSize: 1024 * 1024,
				mimeType: "application/zip",
				platform: "windows",
				isPrimary: true,
			}),
		});
		expect(res.status).toBe(201);
		paidAssetId = (await res.json()).asset.id;
	});

	it("is invisible to the public until released", async () => {
		const detail = await req(`/api/content/works/${oldGameId}`, {
			headers: { Cookie: otherCookie },
		});
		expect(detail.status).toBe(404);

		const catalog = await req(`/api/content/catalog/${creatorName}`, {
			headers: { Cookie: otherCookie },
		});
		expect(catalog.status).toBe(200);
		expect((await catalog.json()).works.length).toBe(0);
	});

	it("releases it, priced for direct purchase", async () => {
		const res = await req(`/api/content/works/${oldGameId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				visibility: "released",
				anthersAccess: [{ threshold: 0, allow: true, price: "5.00" }],
			}),
		});
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.visibility).toBe("released");
		expect(work.releasedAt).toBeTruthy();
	});

	it("publishes a free essay too, dated this year", async () => {
		const create = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				type: "text",
				title: `Recent Essay ${id}`,
				bodyHtml: "<p>a thing I wrote lately</p>",
				authoredAt: new Date().toISOString(),
				authoredPrecision: "day",
			}),
		});
		expect(create.status).toBe(201);
		recentEssayId = (await create.json()).work.id;

		const release = await req(`/api/content/works/${recentEssayId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				visibility: "released",
				anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
			}),
		});
		expect(release.status).toBe(200);
	});

	it("lists both in the public Catalog, newest-MADE first", async () => {
		// The point of the whole exercise: the Catalog reads as a body of work in the order
		// it was made, not the order it happened to be uploaded. Both were uploaded within
		// seconds of each other; the 2015 game still sorts last.
		const res = await req(`/api/content/catalog/${creatorName}`, {
			headers: { Cookie: otherCookie },
		});
		expect(res.status).toBe(200);
		const { works: listed } = await res.json();
		expect(listed.length).toBe(2);
		expect(listed[0].id).toBe(recentEssayId);
		expect(listed[1].id).toBe(oldGameId);

		// And the access verdicts differ per Work, resolved on their own gates.
		expect(listed[0].access.canAccess).toBe(true);
		expect(listed[1].access.canAccess).toBe(false);
		expect(listed[1].access.requiresPurchase).toBe(true);
	});

	it("sorts by release date when asked instead", async () => {
		const res = await req(`/api/content/catalog/${creatorName}?sort=released`, {
			headers: { Cookie: otherCookie },
		});
		const { works: listed } = await res.json();
		expect(listed.length).toBe(2);
		// Released game-then-essay, so "what's new" inverts the Created order.
		expect(listed[0].id).toBe(recentEssayId);
	});

	it("filters the Catalog by type", async () => {
		const res = await req(`/api/content/catalog/${creatorName}?type=game`, {
			headers: { Cookie: otherCookie },
		});
		const { works: listed } = await res.json();
		expect(listed.length).toBe(1);
		expect(listed[0].id).toBe(oldGameId);
	});

	it("refuses the download to a viewer without access (403)", async () => {
		const res = await req(`/api/content/works/${oldGameId}/assets/${paidAssetId}/download`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: otherCookie },
		});
		expect(res.status).toBe(403);
	});

	it("hands the owner a signed download URL (200)", async () => {
		const res = await req(`/api/content/works/${oldGameId}/assets/${paidAssetId}/download`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).url).toBeTruthy();
	});

	it("announces the game in a post that confers no access at all", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Out now ${id}`,
				bodyHtml: "<p>my 2015 game is on Anthers</p>",
				workIds: [oldGameId],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		announcementSlug = (await res.json()).post.slug;

		// The viewer can read the announcement in full...
		const detail = await req(`/api/content/posts/${announcementSlug}`, {
			headers: { Cookie: otherCookie },
		});
		expect(detail.status).toBe(200);
		const { post } = await detail.json();
		expect(post.bodyHtml).toContain("2015 game");
		// ...while the Work it links stays exactly as locked as it was.
		expect(post.linkedWorks.length).toBe(1);
		expect(post.linkedWorks[0].work.access.canAccess).toBe(false);
		expect(post.linkedWorks[0].work.assets[0].file).toBe("");
	});

	it("shows the Work where it has been posted", async () => {
		const res = await req(`/api/content/works/${oldGameId}`, { headers: { Cookie: otherCookie } });
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.postedIn.length).toBe(1);
		expect(work.postedIn[0].slug).toBe(announcementSlug);
	});

	it("holds Works and Posts in one project, in separate lists", async () => {
		const proj = await req("/api/content/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Collection ${id}`,
				slug: `collection-${id}`,
				isPublished: true,
			}),
		});
		expect(proj.status).toBe(201);
		const projectSlug = (await proj.json()).project.slug;

		// A game project holds its builds AND the devlogs about them — the half the
		// schema could not express before, which made an album unable to hold its tracks.
		const addWork = await req(`/api/content/projects/${projectSlug}/works`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ workId: oldGameId }),
		});
		expect(addWork.status).toBe(201);

		const announcement = await req(`/api/content/posts/${announcementSlug}`);
		const announcementId = (await announcement.json()).post.id as number;
		const addPost = await req(`/api/content/projects/${projectSlug}/posts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ postId: announcementId }),
		});
		expect(addPost.status).toBe(201);

		const view = await req(`/api/content/projects/${projectSlug}`, {
			headers: { Cookie: otherCookie },
		});
		expect(view.status).toBe(200);
		const { project } = await view.json();
		expect(project.works.length).toBe(1);
		expect(project.posts.length).toBe(1);
		// Shelving a Work changes nothing about who can open it.
		expect(project.works[0].access.canAccess).toBe(false);
		expect(project.works[0].sourceKey).toBe("");
	});

	it("shows a follower both what the creator said and what they released", async () => {
		// Without this a creator who only ever adds to their Catalog is invisible to their
		// own followers, and a post becomes the price of being seen — exactly the coupling
		// the Catalog/Posts split removes.
		const follow = await req(`/api/accounts/users/${creatorName}/follow`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: otherCookie },
		});
		expect(follow.ok).toBe(true);

		const res = await req("/api/accounts/me/feed", { headers: { Cookie: otherCookie } });
		expect(res.status).toBe(200);
		const { entries } = await res.json();
		expect(entries.some((e: { kind: string }) => e.kind === "release")).toBe(true);
		expect(entries.some((e: { kind: string }) => e.kind === "post")).toBe(true);

		// A release in the feed carries the card and nothing else. This endpoint resolves
		// no access at all, so a payload here would be a leak by construction.
		for (const e of entries.filter((x: { kind: string }) => x.kind === "release")) {
			expect(e.sourceKey).toBeUndefined();
			expect(e.embedUrl).toBeUndefined();
			expect(e.transcoding).toBeUndefined();
			expect(e.bodyHtml).toBeUndefined();
		}

		const postsOnly = await req("/api/accounts/me/feed?kind=posts", {
			headers: { Cookie: otherCookie },
		});
		const onlyPosts = (await postsOnly.json()).entries as { kind: string }[];
		expect(onlyPosts.every((e) => e.kind === "post")).toBe(true);

		const releasesOnly = await req("/api/accounts/me/feed?kind=releases", {
			headers: { Cookie: otherCookie },
		});
		const onlyReleases = (await releasesOnly.json()).entries as { kind: string }[];
		expect(onlyReleases.every((e) => e.kind === "release")).toBe(true);
	});

	it("keeps the Work when the announcement is deleted", async () => {
		const del = await req(`/api/content/posts/${announcementSlug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(del.status).toBe(204);

		const still = await req(`/api/content/works/${oldGameId}`, {
			headers: { Cookie: otherCookie },
		});
		expect(still.status).toBe(200);
	});
});
