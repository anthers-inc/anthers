// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unified Post vertical slice (E02) — proves the content-library model end to end
 * against the real dev database:
 *   free text post (body only, no refs) + paid download post that REFERENCES a
 *   creator-owned game content item (with a downloadable asset) → unified timeline →
 *   access gating via the two access tables → access-checked signed download →
 *   collection membership.
 *
 * Content items are game/text so nothing hits real media processing (no pg-boss).
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

describe("Unified Post vertical slice", () => {
	let creatorCookie: string;
	let otherCookie: string;
	let freeSlug: string;
	let paidSlug: string;
	let gameItemId: number;
	let paidAssetId: number;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${creatorName}, ${otherName})`);
	});

	it("signs up a creator and a viewer", async () => {
		creatorCookie = await signUp(creatorName);
		otherCookie = await signUp(otherName);
		expect(creatorCookie).toBeTruthy();
		expect(otherCookie).toBeTruthy();
	});

	it("creates a game content item in the creator's library", async () => {
		const res = await req("/api/content/content-items", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ type: "game", title: "The Game" }),
		});
		expect(res.status).toBe(201);
		const { item } = await res.json();
		expect(item.type).toBe("game");
		gameItemId = item.id;
		expect(gameItemId).toBeGreaterThan(0);
	});

	it("lists the item in the creator's library with a derived transcoding field", async () => {
		const res = await req("/api/content/content-items?mine=true", {
			headers: { Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const { items } = await res.json();
		const mine = items.find((i: any) => i.id === gameItemId);
		expect(mine).toBeTruthy();
		// A game item needs no processing → no transcode job yet.
		expect(mine.transcoding).toBeNull();
	});

	it("attaches a downloadable asset to the game content item", async () => {
		const res = await req(`/api/content/content-items/${gameItemId}/assets`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				file: `creators/x/assets/${id}.zip`,
				filename: "build.zip",
				fileSize: 1048576,
				platform: "windows",
			}),
		});
		expect(res.status).toBe(201);
		const { asset } = await res.json();
		paidAssetId = asset.id;
		expect(paidAssetId).toBeGreaterThan(0);
	});

	it("creates a free, stream-only text post (body only, no content refs)", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Free devlog ${id}`,
				body: "Hello from the unified model.",
				streamEnabled: true,
				downloadEnabled: false,
				// Free to everyone: the $0 boost baseline is allowed at price 0.
				boostAccess: [{ threshold: 0, allow: true, price: "0" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.contentType).toBe("text"); // derived: no content refs → text
		expect(post.streamEnabled).toBe(true);
		expect(post.downloadEnabled).toBe(false);
		expect(typeof post.publicId).toBe("number");
		freeSlug = post.slug;
	});

	it("creates a paid, download-only post that references the game item", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Paid build ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				// Purchasable by anyone at $5 (the $0 boost baseline, priced).
				boostAccess: [{ threshold: 0, allow: true, price: "5.00" }],
				contents: [{ kind: "content", contentItemId: gameItemId }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.downloadEnabled).toBe(true);
		expect(post.contentType).toBe("game"); // derived from the first content ref's item
		expect(post.contents.length).toBe(1);
		expect(post.contents[0].kind).toBe("content");
		expect(post.contents[0].contentItem.id).toBe(gameItemId);
		paidSlug = post.slug;
	});

	it("rejects a post that references an item the caller does not own (400)", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: otherCookie },
			body: JSON.stringify({
				title: `Steal ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				boostAccess: [{ threshold: 0, allow: true, price: "0" }],
				contents: [{ kind: "content", contentItemId: gameItemId }],
				isPublished: false,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("lists both posts on the unified timeline with correct access", async () => {
		const res = await req("/api/content/posts");
		expect(res.status).toBe(200);
		const { posts } = await res.json();

		const free = posts.find((p: any) => p.slug === freeSlug);
		const paid = posts.find((p: any) => p.slug === paidSlug);
		expect(free).toBeTruthy();
		expect(paid).toBeTruthy();

		// Free post: anyone can access.
		expect(free.access.canAccess).toBe(true);
		expect(free.access.reason).toBe("free");

		// Paid post: purchase required, price surfaced.
		expect(paid.access.canAccess).toBe(false);
		expect(paid.access.reason).toBe("payment_required");
		expect(paid.access.price).toBe("5.00");
	});

	it("gates the paid post detail for an anonymous viewer", async () => {
		const res = await req(`/api/content/posts/${paidSlug}`);
		expect(res.status).toBe(200);
		const { post } = await res.json();
		expect(post.access.canAccess).toBe(false);
		// The item's media/type/title survive for the locked preview, but download keys don't.
		expect(post.contents[0].contentItem.type).toBe("game");
		expect(post.contents[0].contentItem.assets[0].file).toBe("");
	});

	it("resolves the paid post by its publicId form too", async () => {
		const detail = await req(`/api/content/posts/${paidSlug}`);
		const { post } = await detail.json();
		const byId = await req(`/api/content/posts/${post.publicId}`);
		expect(byId.status).toBe(200);
		expect((await byId.json()).post.slug).toBe(paidSlug);
	});

	it("refuses the download to a non-owner without access (403)", async () => {
		const res = await req(`/api/content/posts/${paidSlug}/assets/${paidAssetId}/download`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: otherCookie },
		});
		expect(res.status).toBe(403);
	});

	it("hands the owner a signed download URL (200)", async () => {
		const res = await req(`/api/content/posts/${paidSlug}/assets/${paidAssetId}/download`, {
			method: "POST",
			headers: { Origin: ORIGIN, Cookie: creatorCookie },
		});
		expect(res.status).toBe(200);
		const { url } = await res.json();
		expect(typeof url).toBe("string");
		expect(url.length).toBeGreaterThan(0);
	});

	it("groups posts into a collection and lists its members", async () => {
		const collectionSlug = `collection-${id}`;
		const create = await req("/api/content/projects", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ title: `Collection ${id}`, slug: collectionSlug, isPublished: true }),
		});
		expect(create.status).toBe(201);

		const detail = await req(`/api/content/posts/${paidSlug}`);
		const paidId = (await detail.json()).post.id;

		const add = await req(`/api/content/projects/${collectionSlug}/posts`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({ postId: paidId }),
		});
		expect(add.status).toBe(201);

		const view = await req(`/api/content/projects/${collectionSlug}`);
		expect(view.status).toBe(200);
		const { project } = await view.json();
		expect(project.posts.length).toBe(1);
		expect(project.posts[0].slug).toBe(paidSlug);
	});
});
