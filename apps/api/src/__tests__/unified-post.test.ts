// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Unified Post vertical slice (E02) — proves the content-type-agnostic model
 * end to end against the real dev database:
 *   free text post + paid download post → unified timeline → access gating →
 *   access-checked signed download → collection membership.
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

	it("creates a free, stream-only text post", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Free devlog ${id}`,
				body: "Hello from the unified model.",
				contentType: "text",
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.contentType).toBe("text");
		expect(post.streamEnabled).toBe(true);
		expect(post.downloadEnabled).toBe(false);
		expect(post.basePrice).toBeNull();
		freeSlug = post.slug;
	});

	it("creates a paid, download-only post", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creatorCookie },
			body: JSON.stringify({
				title: `Paid build ${id}`,
				contentType: "game",
				streamEnabled: false,
				downloadEnabled: true,
				basePrice: "5.00",
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.downloadEnabled).toBe(true);
		expect(post.basePrice).toBe("5.00");
		paidSlug = post.slug;
	});

	it("attaches a downloadable asset to the paid post", async () => {
		const res = await req(`/api/content/posts/${paidSlug}/assets`, {
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
		// Download keys are not leaked to viewers without access.
		expect(post.assets[0].file).toBe("");
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

		// Look up the paid post's numeric id to add it to the collection.
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
