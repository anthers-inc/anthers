// SPDX-License-Identifier: Apache-2.0
/**
 * Retitling re-derives the slug (Parker, 2026-10-16 — "Hello, there" still serving
 * `/posts/post-…`): both `PATCH /posts/:slug` and `PATCH /works/:id` recompute the
 * slug half of the public address from the new title when no explicit slug rides the
 * PATCH, and the trailing `publicId` is the half that never changes — so every old
 * link keeps resolving while the canonical URL names the thing it is.
 *
 * Covers: the derive on a plain retitle, the old publicId-only address still
 * resolving, collision suffixing, an explicit slug still winning, a no-op retitle
 * rewriting nothing, the edit history recording the move, and the stranger refusal.
 */

import { describe, expect, it } from "bun:test";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function jsonReq(path: string, cookie: string, json: unknown, method = "PATCH") {
	return req(path, {
		method,
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(json),
	});
}

const id = crypto.randomUUID().slice(0, 8);
const name = `slug_${id}`;

/** A creator whose publishing path is fully set up. */
const owner = (async () => {
	const cookie = (await createAccount(name)).cookie;
	await enablePayouts(name);
	return cookie;
})();

/** Create and immediately publish a post through the API; returns its address fields. */
async function publishPost(
	title: string,
	body: string,
): Promise<{
	id: number;
	slug: string;
	publicId: number;
}> {
	const res = await jsonReq(
		"/api/content/posts",
		await owner,
		{
			title,
			body,
			isPublished: true,
		},
		"POST",
	);
	expect(res.status).toBe(201);
	return (await res.json()).post;
}

async function makeWork(title: string): Promise<{ id: number; slug: string; publicId: number }> {
	const res = await jsonReq("/api/content/works", await owner, { type: "game", title }, "POST");
	expect(res.status).toBe(201);
	return (await res.json()).work;
}

describe("Retitling a post re-derives the slug", () => {
	it("moves the slug to the new title and keeps the old address resolving", async () => {
		const post = await publishPost("First working title", "A body.");

		const retitled = await jsonReq(
			`/api/content/posts/${post.slug}-${post.publicId}`,
			await owner,
			{
				title: "Hello, there",
			},
		);
		expect(retitled.status).toBe(200);
		const updated = (await retitled.json()).post;
		expect(updated.slug).toBe("hello-there");
		expect(updated.publicId).toBe(post.publicId);

		// The canonical address answers.
		expect((await req(`/api/content/posts/hello-there-${post.publicId}`)).status).toBe(200);

		// The old slug form (and any word before the publicId) still resolves — the
		// durable-address half of the bargain.
		expect((await req(`/api/content/posts/first-working-title-${post.publicId}`)).status).toBe(200);
		expect((await req(`/api/content/posts/foobar-${post.publicId}`)).status).toBe(200);
	});

	it("suffixes a collision the same way create does", async () => {
		const first = await publishPost("Same title both want", "One.");
		await publishPost("A different title", "Two.");

		const res = await jsonReq(`/api/content/posts/${first.slug}-${first.publicId}`, await owner, {
			title: "A different title",
		});
		expect(res.status).toBe(200);
		const updated = (await res.json()).post;
		expect(updated.publicId).toBe(first.publicId);
		expect(updated.slug.startsWith("a-different-title-")).toBe(true);
		expect(updated.slug).not.toBe("a-different-title");
	});

	it("an explicit slug still wins, and a no-op retitle rewrites nothing", async () => {
		const res = await jsonReq(
			"/api/content/posts",
			await owner,
			{
				title: "Explicit check original",
				body: "A body.",
				isPublished: true,
				slug: "hand-chosen-original",
			},
			"POST",
		);
		expect(res.status).toBe(201);
		const post = (await res.json()).post as { slug: string; publicId: number };

		const explicit = await jsonReq(
			`/api/content/posts/${post.slug}-${post.publicId}`,
			await owner,
			{
				title: "A brand new name",
				slug: "also-hand-chosen",
			},
		);
		expect(explicit.status).toBe(200);
		expect((await explicit.json()).post.slug).toBe("also-hand-chosen");

		// A retitle whose derived slug equals the existing one leaves it in place.
		const noop = await jsonReq(
			`/api/content/posts/also-hand-chosen-${post.publicId}`,
			await owner,
			{
				title: "also hand chosen",
			},
		);
		expect(noop.status).toBe(200);
		expect((await noop.json()).post.slug).toBe("also-hand-chosen");
	});

	it("records the slug move in the edit history", async () => {
		const post = await publishPost("History check original", "A body.");
		expect(
			(
				await jsonReq(`/api/content/posts/${post.slug}-${post.publicId}`, await owner, {
					title: "History check renamed",
				})
			).status,
		).toBe(200);
		// The PATCH response does not carry the history; the detail GET does.
		const { post: updated } = (await (
			await req(`/api/content/posts/history-check-renamed-${post.publicId}`)
		).json()) as { post: { edits?: Array<{ summary?: string; changedFields?: string[] | null }> } };
		const latest = updated.edits?.[0];
		expect(latest?.summary).toContain("slug");
	});
});

describe("Retitling a Work re-derives the slug", () => {
	it("moves the slug and keeps every old address resolving", async () => {
		const work = await makeWork("Original Work Name");

		const res = await jsonReq(`/api/content/works/${work.id}`, await owner, {
			title: "Renamed Work",
		});
		expect(res.status).toBe(200);
		const updated = (await res.json()).work;
		expect(updated.slug).toBe("renamed-work");
		expect(updated.publicId).toBe(work.publicId);

		// A Work's route gates an unreleased Work on ownership, so these read with the
		// owner's own cookie — the assertion is the address resolving, not the release.
		const ownerCookie = await owner;
		const read = (path: string) => req(path, { headers: { Cookie: ownerCookie } });
		expect((await read(`/api/content/works/original-work-name-${work.publicId}`)).status).toBe(200);
		expect((await read(`/api/content/works/${work.publicId}`)).status).toBe(200);
	});

	it("an explicit slug still wins", async () => {
		const work = await makeWork("Explicit Slug Work");
		const res = await jsonReq(`/api/content/works/${work.id}`, await owner, {
			title: "A Second Name",
			slug: "also-hand-chosen",
		});
		expect(res.status).toBe(200);
		expect((await res.json()).work.slug).toBe("also-hand-chosen");
	});
});

describe("A retitle by a stranger is refused", () => {
	it("404s rather than revealing the row", async () => {
		const post = await publishPost("Ownership check original", "A body.");
		const other = (await createAccount(`${name}_other`)).cookie;
		const res = await jsonReq(`/api/content/posts/${post.slug}-${post.publicId}`, other, {
			title: "Not theirs",
		});
		expect(res.status).toBe(404);
	});
});
