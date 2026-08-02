// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Catalog CRUD and a post's references to Works.
 *
 * The pivot this covers: a Work is a creator-owned, first-class thing that carries its own
 * visibility, dates, delivery and gates, and a post merely LINKS it. The link is inert —
 * confers no access, no ownership — so most of what this file asserts is what linking
 * *doesn't* do.
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
const ownerName = `lib_${id}`;
const strangerName = `lib_other_${id}`;

/** Free baseline so the created posts are readable back by the owner. */
const FREE = [{ threshold: 0, allow: true, price: "0" }];

describe("Catalog CRUD and post links", () => {
	let ownerCookie: string;
	let strangerCookie: string;
	let workId: number;
	let postSlug: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${ownerName}, ${strangerName})`);
	});

	it("signs up an owner and a stranger", async () => {
		ownerCookie = await signUp(ownerName);
		strangerCookie = await signUp(strangerName);
		expect(ownerCookie).toBeTruthy();
		expect(strangerCookie).toBeTruthy();
	});

	it("creates a Work, private by default", async () => {
		const create = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ type: "game", title: "Library Build", description: "A build" }),
		});
		expect(create.status).toBe(201);
		const { work } = await create.json();
		workId = work.id;
		expect(workId).toBeGreaterThan(0);
		// Nothing is visible on upload. Release is a separate, deliberate act — the whole
		// point of separating the Catalog from posting.
		expect(work.visibility).toBe("private");
		expect(work.slug).toBeTruthy();
		expect(work.publicId).toBeGreaterThan(0);

		// A private Work is invisible to everyone else, and 404s rather than 403s.
		const forbidden = await req(`/api/content/works/${workId}`, {
			headers: { Cookie: strangerCookie },
		});
		expect(forbidden.status).toBe(404);

		const mine = await req(`/api/content/works/${workId}`, { headers: { Cookie: ownerCookie } });
		expect(mine.status).toBe(200);
		expect((await mine.json()).work.title).toBe("Library Build");
	});

	it("refuses to create a Work already released", async () => {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ type: "game", title: "Too Eager", visibility: "released" }),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("release_on_create");
	});

	it("patches the Work (owner-only) and records a Created date with its precision", async () => {
		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				title: "Renamed Build",
				authoredAt: "2015-06-01T00:00:00.000Z",
				authoredPrecision: "year",
			}),
		});
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.title).toBe("Renamed Build");
		// The migration case: made long before it was uploaded, and we store how precisely
		// the creator actually knows that, rather than inventing a day.
		expect(work.authoredPrecision).toBe("year");
		expect(new Date(work.authoredAt).getUTCFullYear()).toBe(2015);
	});

	it("rejects a Created date with no precision", async () => {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				type: "game",
				title: "Undated",
				authoredAt: "2015-06-01T00:00:00.000Z",
			}),
		});
		expect(res.status).toBe(400);
	});

	it("releases the Work, and only then does it become publicly visible", async () => {
		const before = await req(`/api/content/works/${workId}`, {
			headers: { Cookie: strangerCookie },
		});
		expect(before.status).toBe(404);

		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ visibility: "released", streamEnabled: false, downloadEnabled: true }),
		});
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.visibility).toBe("released");
		expect(work.releasedAt).toBeTruthy();

		const after = await req(`/api/content/works/${workId}`, { headers: { Cookie: strangerCookie } });
		expect(after.status).toBe(200);
	});

	it("refuses a PATCH that leaves a Work with no delivery method", async () => {
		// The floor moved to the Work with delivery itself, and is still evaluated on the
		// state the edit RESULTS IN — the stored value a schema refine can't see.
		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ downloadEnabled: false }),
		});
		expect(res.status).toBe(400);
	});

	it("creates a post linking the Work", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				title: `Announcing ${id}`,
				bodyHtml: "<p>it's out</p>",
				workIds: [workId],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		postSlug = post.slug;
		expect(post.linkedWorks.length).toBe(1);
		expect(post.linkedWorks[0].work.id).toBe(workId);
		// A post has no gate of its own — there is no post-level access verdict at all.
		expect(post.access).toBeUndefined();
	});

	it("refuses to link another creator's Work (400)", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: strangerCookie },
			body: JSON.stringify({ title: `Thief ${id}`, workIds: [workId] }),
		});
		expect(res.status).toBe(400);
	});

	it("replaces the link set wholesale on patch", async () => {
		const res = await req(`/api/content/posts/${postSlug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ workIds: [] }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).post.linkedWorks.length).toBe(0);
	});

	it("publishes a post with no links at all", async () => {
		// A post is allowed to be just words. It always was, but it used to be the odd case;
		// now it is the ordinary one.
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				title: `Words only ${id}`,
				bodyHtml: "<p>just saying hello</p>",
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.isPublished).toBe(true);
		expect(post.publishedAt).toBeTruthy();
	});

	it("refuses to delete a linked Work without force, and reports where it is linked", async () => {
		const relink = await req(`/api/content/posts/${postSlug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ workIds: [workId] }),
		});
		expect(relink.status).toBe(200);

		const res = await req(`/api/content/works/${workId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: ownerCookie },
		});
		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.code).toBe("work_in_use");
		expect(body.posts.length).toBe(1);
	});

	it("deletes a post without touching the Work it announced", async () => {
		// Deleting an announcement must never destroy the work it announced.
		const del = await req(`/api/content/posts/${postSlug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: ownerCookie },
		});
		expect(del.status).toBe(204);

		const still = await req(`/api/content/works/${workId}`, { headers: { Cookie: ownerCookie } });
		expect(still.status).toBe(200);
	});

	it("deletes the Work once nothing links it", async () => {
		const res = await req(`/api/content/works/${workId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: ownerCookie },
		});
		expect(res.status).toBe(204);
		const gone = await req(`/api/content/works/${workId}`, { headers: { Cookie: ownerCookie } });
		expect(gone.status).toBe(404);
	});
});
