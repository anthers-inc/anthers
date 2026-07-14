// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Content-library references — the server half of the content-model pivot. Content is a
 * first-class, creator-owned library item; posts REFERENCE items instead of owning media.
 * Covers: library CRUD, a post that mixes a text block with a content ref, ownership
 * enforcement on refs (a non-owner can't attach another creator's item), reconcile-by-id
 * on patch, and that deleting a library item cascades away the post's reference.
 *
 * Items are game/text so nothing hits real media processing (no pg-boss).
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

describe("Content-library references", () => {
	let ownerCookie: string;
	let strangerCookie: string;
	let itemId: number;
	let postSlug: string;
	let textEntryId: number;
	let contentEntryId: number;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username IN (${ownerName}, ${strangerName})`);
	});

	it("signs up an owner and a stranger", async () => {
		ownerCookie = await signUp(ownerName);
		strangerCookie = await signUp(strangerName);
		expect(ownerCookie).toBeTruthy();
		expect(strangerCookie).toBeTruthy();
	});

	it("creates a library content item and fetches it back (owner-only)", async () => {
		const create = await req("/api/content/content-items", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ type: "game", title: "Library Build", description: "A build" }),
		});
		expect(create.status).toBe(201);
		itemId = (await create.json()).item.id;
		expect(itemId).toBeGreaterThan(0);

		// The stranger can't read someone else's library item.
		const forbidden = await req(`/api/content/content-items/${itemId}`, {
			headers: { Cookie: strangerCookie },
		});
		expect(forbidden.status).toBe(404);

		const mine = await req(`/api/content/content-items/${itemId}`, {
			headers: { Cookie: ownerCookie },
		});
		expect(mine.status).toBe(200);
		expect((await mine.json()).item.title).toBe("Library Build");
	});

	it("patches the item (owner-only)", async () => {
		const res = await req(`/api/content/content-items/${itemId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({ title: "Renamed Build" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()).item.title).toBe("Renamed Build");
	});

	it("creates a post mixing a text block with a content ref", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				title: `Mixed ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [
					{ kind: "text", bodyHtml: "<p>Read me first.</p>" },
					{ kind: "content", contentItemId: itemId },
				],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.contentType).toBe("game"); // first CONTENT ref's item type
		expect(post.contents.length).toBe(2);
		expect(post.contents[0].kind).toBe("text");
		expect(post.contents[0].bodyHtml).toContain("Read me first");
		expect(post.contents[1].kind).toBe("content");
		expect(post.contents[1].contentItem.id).toBe(itemId);
		postSlug = post.slug;
		textEntryId = post.contents[0].id;
		contentEntryId = post.contents[1].id;
	});

	it("refuses to reference another creator's library item (400)", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: strangerCookie },
			body: JSON.stringify({
				title: `Nope ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: false,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("reconciles entries by id on patch (drop the text block, keep the ref)", async () => {
		const res = await req(`/api/content/posts/${postSlug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				contents: [{ kind: "content", id: contentEntryId, contentItemId: itemId }],
			}),
		});
		expect(res.status).toBe(200);
		const { post } = await res.json();
		expect(post.contents.length).toBe(1);
		expect(post.contents[0].id).toBe(contentEntryId);
		expect(post.contents[0].kind).toBe("content");
		// The dropped text entry is gone.
		expect(post.contents.some((e: any) => e.id === textEntryId)).toBe(false);
	});

	it("still allows publishing a text-only post (no content refs)", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ownerCookie },
			body: JSON.stringify({
				title: `Text ${id}`,
				body: "No media here.",
				streamEnabled: true,
				downloadEnabled: false,
				seedAccess: FREE,
				contents: [{ kind: "text", bodyHtml: "<p>hi</p>" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		const { post } = await res.json();
		expect(post.isPublished).toBe(true);
		expect(post.contentType).toBe("text");
	});

	it("deleting the library item cascades away the post's reference", async () => {
		const del = await req(`/api/content/content-items/${itemId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: ownerCookie },
		});
		expect(del.status).toBe(204);

		// The item is gone from the library.
		const gone = await req(`/api/content/content-items/${itemId}`, {
			headers: { Cookie: ownerCookie },
		});
		expect(gone.status).toBe(404);

		// The post survives, but its content ref (cascaded) is gone → back to text.
		const post = await req(`/api/content/posts/${postSlug}`, { headers: { Cookie: ownerCookie } });
		expect(post.status).toBe(200);
		const { post: p } = await post.json();
		expect(p.contents.length).toBe(0);
	});
});
