// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post lifecycle — the edit/delete/schedule/gate cluster.
 *
 * Covers: the publish-readiness gate (409 while referenced media transcodes), the edit
 * history log (a post_edits row per content-changing PATCH, exposed on GET), delete with
 * opt-in orphaned-media purge, the unpublish action + permalink 404 for non-owners, and
 * the scheduled-publish sweep (publishes due drafts whose media is ready, defers the rest).
 *
 * Transcode state is simulated by inserting transcoding_jobs rows directly, so nothing
 * touches real ffmpeg or pg-boss.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { contentItems, transcodingJobs } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { publishScheduled } from "../jobs/publish-scheduled";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

/** Create an owned library item and return its id. game type → no auto media processing. */
async function makeItem(cookie: string, title: string): Promise<number> {
	const res = await req("/api/content/content-items", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ type: "game", title }),
	});
	expect(res.status).toBe(201);
	return (await res.json()).item.id;
}

const id = crypto.randomUUID().slice(0, 8);
const ownerName = `pl_${id}`;
const strangerName = `pl_other_${id}`;
const FREE = [{ threshold: 0, allow: true, price: "0" }];

let owner: string;
let stranger: string;

beforeAll(async () => {
	await db.execute(sql`DELETE FROM users WHERE username IN (${ownerName}, ${strangerName})`);
	owner = await signUp(ownerName);
	stranger = await signUp(strangerName);
});

describe("Publish-readiness gate", () => {
	let itemId: number;

	it("blocks publishing a post whose referenced media is still transcoding", async () => {
		itemId = await makeItem(owner, "Gated build");
		await db
			.insert(transcodingJobs)
			.values({ contentItemId: itemId, mediaType: "video", status: "pending", progress: 0 });

		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Gate ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("media_not_ready");
	});

	it("allows saving the same post as a draft while media processes", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Gate draft ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: false,
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).post.isPublished).toBe(false);
	});

	it("publishes once the transcode completes", async () => {
		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100 })
			.where(eq(transcodingJobs.contentItemId, itemId));

		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Gate ok ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).post.isPublished).toBe(true);
	});
});

describe("Edit history", () => {
	let slug: string;

	it("creates a text post to edit", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `History ${id}`,
				body: "First",
				streamEnabled: true,
				downloadEnabled: false,
				seedAccess: FREE,
				contents: [{ kind: "text", bodyHtml: "<p>First</p>" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		slug = (await res.json()).post.slug;
	});

	it("logs a timestamped entry when the title changes", async () => {
		await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `History renamed ${id}` }),
		});
		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		const { post } = await get.json();
		expect(post.edits.length).toBe(1);
		expect(post.edits[0].summary).toContain("title");
	});

	it("does not log a no-op re-save", async () => {
		await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `History renamed ${id}` }),
		});
		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		expect((await get.json()).post.edits.length).toBe(1);
	});

	it("does not log a pure unpublish (publish toggles aren't edits)", async () => {
		await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ isPublished: false }),
		});
		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		expect((await get.json()).post.edits.length).toBe(1);
	});
});

describe("Delete with orphaned-media purge", () => {
	it("purges an orphaned library item when opted in", async () => {
		const itemId = await makeItem(owner, "Orphan build");
		const create = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Purge ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: false,
			}),
		});
		const slug = (await create.json()).post.slug;

		const preview = await req(`/api/content/posts/${slug}/orphaned-media`, {
			headers: { Cookie: owner },
		});
		expect(preview.status).toBe(200);
		expect((await preview.json()).items.map((i: { id: number }) => i.id)).toContain(itemId);

		const del = await req(`/api/content/posts/${slug}?purgeMedia=true`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(del.status).toBe(204);

		const [gone] = await db.select().from(contentItems).where(eq(contentItems.id, itemId));
		expect(gone).toBeUndefined();
	});

	it("keeps library media when purge is not requested", async () => {
		const itemId = await makeItem(owner, "Kept build");
		const create = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Keep ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: false,
			}),
		});
		const slug = (await create.json()).post.slug;

		const del = await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(del.status).toBe(204);

		const [kept] = await db.select().from(contentItems).where(eq(contentItems.id, itemId));
		expect(kept).toBeDefined();
	});
});

describe("Unpublish + permalink visibility", () => {
	let slug: string;

	it("a published post is visible to a stranger", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Visible ${id}`,
				body: "hi",
				streamEnabled: true,
				downloadEnabled: false,
				seedAccess: FREE,
				contents: [{ kind: "text", bodyHtml: "<p>hi</p>" }],
				isPublished: true,
			}),
		});
		slug = (await res.json()).post.slug;
		const strangerView = await req(`/api/content/posts/${slug}`, { headers: { Cookie: stranger } });
		expect(strangerView.status).toBe(200);
	});

	it("unpublishing hides it from strangers but not the owner", async () => {
		await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ isPublished: false }),
		});
		const strangerView = await req(`/api/content/posts/${slug}`, { headers: { Cookie: stranger } });
		expect(strangerView.status).toBe(404);
		const ownerView = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		expect(ownerView.status).toBe(200);
	});
});

describe("Scheduled-publish sweep", () => {
	const past = new Date(Date.now() - 60_000).toISOString();

	it("publishes a due draft whose media is ready", async () => {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Sched ready ${id}`,
				body: "soon",
				streamEnabled: true,
				downloadEnabled: false,
				seedAccess: FREE,
				contents: [{ kind: "text", bodyHtml: "<p>soon</p>" }],
				isPublished: false,
				scheduledFor: past,
			}),
		});
		const slug = (await res.json()).post.slug;

		await publishScheduled();

		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		const { post } = await get.json();
		expect(post.isPublished).toBe(true);
		expect(post.scheduledFor).toBeNull();
	});

	it("defers a due draft whose media is still processing", async () => {
		const itemId = await makeItem(owner, "Sched build");
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Sched unready ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", contentItemId: itemId }],
				isPublished: false,
				scheduledFor: past,
			}),
		});
		const slug = (await res.json()).post.slug;
		await db
			.insert(transcodingJobs)
			.values({ contentItemId: itemId, mediaType: "video", status: "processing", progress: 20 });

		await publishScheduled();

		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		expect((await get.json()).post.isPublished).toBe(false);
	});
});
