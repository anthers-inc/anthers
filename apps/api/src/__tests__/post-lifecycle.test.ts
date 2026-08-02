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
import { works, transcodingJobs } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { publishScheduled } from "../jobs/publish-scheduled";
import { CRON_SCHEDULES, QUEUES } from "../jobs/queue";

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
			.values({ workId: itemId, mediaType: "video", status: "pending", progress: 0 });

		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Gate ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", workId: itemId }],
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
				contents: [{ kind: "content", workId: itemId }],
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
			.where(eq(transcodingJobs.workId, itemId));

		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Gate ok ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", workId: itemId }],
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
				contents: [{ kind: "content", workId: itemId }],
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

		const [gone] = await db.select().from(works).where(eq(works.id, itemId));
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
				contents: [{ kind: "content", workId: itemId }],
				isPublished: false,
			}),
		});
		const slug = (await create.json()).post.slug;

		const del = await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(del.status).toBe(204);

		const [kept] = await db.select().from(works).where(eq(works.id, itemId));
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
				contents: [{ kind: "content", workId: itemId }],
				isPublished: false,
				scheduledFor: past,
			}),
		});
		const slug = (await res.json()).post.slug;
		await db
			.insert(transcodingJobs)
			.values({ workId: itemId, mediaType: "video", status: "processing", progress: 20 });

		await publishScheduled();

		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		expect((await get.json()).post.isPublished).toBe(false);
	});
});

/**
 * Two validation gaps found while checking the status report against the code, both in
 * the "a request that looks fine leaves the data wrong" family rather than the "500s"
 * family — which is why neither had coverage.
 */
describe("Delivery-method floor on PATCH", () => {
	/** Create a post owned by `owner` and return its slug. */
	async function makePost(title: string, body: Record<string, unknown> = {}) {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title, seedAccess: FREE, isPublished: true, ...body }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).post.slug;
	}

	it("rejects a create with no delivery method", async () => {
		// The create-time `.refine()` existed but had never been exercised by a test.
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `NoDelivery ${id}`,
				streamEnabled: false,
				downloadEnabled: false,
				seedAccess: FREE,
			}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a PATCH that switches both off", async () => {
		// The actual bug: `updatePostSchema` is `postBaseSchema.partial()`, and `.partial()`
		// drops the refine — so this used to 200 and leave a published post unconsumable.
		const slug = await makePost(`BothOff ${id}`, { streamEnabled: true, downloadEnabled: true });
		const res = await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ streamEnabled: false, downloadEnabled: false }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a PATCH that switches off the only one left", async () => {
		// The case a schema-level refine could never catch: the request names ONE field, and
		// whether it's legal depends on the post's stored value for the other.
		const slug = await makePost(`LastOne ${id}`, { streamEnabled: true, downloadEnabled: false });
		const res = await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ streamEnabled: false }),
		});
		expect(res.status).toBe(400);
	});

	it("allows switching one off while the other stays on", async () => {
		const slug = await makePost(`SwapOne ${id}`, { streamEnabled: true, downloadEnabled: true });
		const res = await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ streamEnabled: false }),
		});
		expect(res.status).toBe(200);
	});
});

describe("Library delete refuses to silently strip posts", () => {
	async function postUsing(itemId: number, title: string) {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", workId: itemId }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()).post.slug;
	}

	it("reports which posts use an item", async () => {
		const itemId = await makeItem(owner, `Usage ${id}`);
		const slug = await postUsing(itemId, `Uses item ${id}`);
		const res = await req(`/api/content/content-items/${itemId}/usage`, {
			headers: { Cookie: owner },
		});
		expect(res.status).toBe(200);
		const { posts } = await res.json();
		expect(posts.map((p: { slug: string }) => p.slug)).toContain(slug);
	});

	it("409s on an unflagged delete of an in-use item, and leaves it intact", async () => {
		// `post_contents.workId` cascades, so this used to 204 and quietly remove the
		// item from a PUBLISHED post. Failing closed is the point: the destructive reading of
		// an ambiguous request is the one you can't undo.
		const itemId = await makeItem(owner, `InUse ${id}`);
		await postUsing(itemId, `Keeps item ${id}`);
		const res = await req(`/api/content/content-items/${itemId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("item_in_use");

		const still = await db.select().from(works).where(eq(works.id, itemId));
		expect(still.length).toBe(1);
	});

	it("deletes an in-use item when forced", async () => {
		const itemId = await makeItem(owner, `Forced ${id}`);
		await postUsing(itemId, `Loses item ${id}`);
		const res = await req(`/api/content/content-items/${itemId}?force=1`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(res.status).toBe(204);

		const gone = await db.select().from(works).where(eq(works.id, itemId));
		expect(gone.length).toBe(0);
	});

	it("deletes an unused item without a flag", async () => {
		// The common case must stay a one-step action — the guard is scoped to real damage.
		const itemId = await makeItem(owner, `Unused ${id}`);
		const res = await req(`/api/content/content-items/${itemId}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(res.status).toBe(204);
	});
});

/**
 * Three gaps the status report named, each confirmed against the code rather than
 * suspected. All three share a shape: the suite looked like it covered the case, but the
 * assertion was standing next to it rather than on it.
 */
describe("Gaps the suite looked like it covered", () => {
	async function makeScheduledReadyPost(title: string) {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title,
				streamEnabled: true,
				downloadEnabled: false,
				seedAccess: FREE,
				contents: [{ kind: "text", bodyHtml: "<p>x</p>" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()).post.slug;
	}

	it("hides an unpublished post from an ANONYMOUS visitor, not just a signed-in stranger", async () => {
		// The existing permalink test's "stranger" is a second *signed-in* account, so the
		// anonymous branch — `getOptionalUserId` returning null — was never exercised. That's
		// the branch a search-engine crawler or a shared link actually takes.
		const slug = await makeScheduledReadyPost(`Anon ${id}`);
		await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ isPublished: false }),
		});

		const anon = await req(`/api/content/posts/${slug}`); // no Cookie header at all
		expect(anon.status).toBe(404);

		const ownerView = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		expect(ownerView.status).toBe(200);
	});

	it("409s on a PATCH to an already-published post whose media went unready", async () => {
		// Every `media_not_ready` assertion went through POST, leaving the PATCH-side
		// `willPublish` branch untested — and that is the deliberately strict one: it rejects
		// ANY edit to an already-published post whose referenced media has gone unready,
		// even an edit that has nothing to do with the media.
		const itemId = await makeItem(owner, `Regress ${id}`);
		const create = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Regress ${id}`,
				streamEnabled: false,
				downloadEnabled: true,
				seedAccess: FREE,
				contents: [{ kind: "content", workId: itemId }],
				isPublished: true,
			}),
		});
		expect(create.status).toBe(201);
		const slug = (await create.json()).post.slug;

		// The media regresses to processing after the post went live.
		await db.insert(transcodingJobs).values({
			workId: itemId,
			mediaType: "video",
			status: "processing",
			progress: 10,
		});

		// A title-only edit — nothing to do with media — is still refused.
		const res = await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `Regress renamed ${id}` }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("media_not_ready");
	});

	it("registers publish-scheduled as a per-minute cron", async () => {
		// The sweep itself is tested by calling publishScheduled() directly, which
		// deliberately never starts pg-boss — so nothing checked that anything ever CALLS
		// it on a schedule. A dropped registration would surface as "scheduled posts just
		// never publish", with every existing test still green.
		const entry = CRON_SCHEDULES.find(([q]) => q === QUEUES.PUBLISH_SCHEDULED);
		expect(entry).toBeDefined();
		expect(entry?.[1]).toBe("* * * * *");

		// Every queue with a cron must also be a real queue, so a rename can't leave a
		// schedule pointing at nothing.
		const known = new Set<string>(Object.values(QUEUES));
		for (const [q] of CRON_SCHEDULES) expect(known.has(q)).toBe(true);
	});
});
