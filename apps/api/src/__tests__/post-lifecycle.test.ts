// SPDX-License-Identifier: Apache-2.0
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

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { transcodingJobs, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { publishScheduled } from "../jobs/publish-scheduled";
import { CRON_SCHEDULES, QUEUES } from "../jobs/queue";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { CREATED_CREDIT, giveWorkAFile } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<string> {
	return (await createAccount(username)).cookie;
}

/** Create an owned library item and return its id. game type → no auto media processing. */
/** Create a Work through the API. `game` by default so nothing queues a transcode. */
async function makeItem(
	cookie: string,
	title: string,
	type = "game",
): Promise<{
	id: number;
	slug: string;
	publicId: number;
}> {
	const res = await req("/api/content/works", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		// Rated on create so the release below is not refused for a reason
		// this suite is not about — release is gated on every row of the rating being answered.
		body: JSON.stringify({
			type,
			title,
			maturityRows: rowsRatedAs("general"),
			credits: CREATED_CREDIT,
		}),
	});
	expect(res.status).toBe(201);
	return (await res.json()).work;
}

/** Create a Work and release it, so it is publicly reachable. */
async function makeReleasedWork(
	cookie: string,
	title: string,
	type = "game",
): Promise<{ id: number; slug: string; publicId: number }> {
	const work = await makeItem(cookie, title, type);
	await giveWorkAFile(work.id);
	const res = await req(`/api/content/works/${work.id}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ visibility: "released", access: FREE }),
	});
	expect(res.status).toBe(200);
	return work;
}

const id = crypto.randomUUID().slice(0, 8);
const ownerName = `pl_${id}`;
const strangerName = `pl_other_${id}`;
const FREE = [{ threshold: 0, allow: true, price: "0" }];

let owner: string;
let stranger: string;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${ownerName}@example.com`}`, sql`${`${strangerName}@example.com`}`], sql`, `)})`,
	);
	owner = await signUp(ownerName);
	await enablePayouts(ownerName);
	stranger = await signUp(strangerName);
	await enablePayouts(strangerName);
	await db.execute(
		sql`UPDATE users SET creator_mode = true WHERE email IN (${sql.join([sql`${`${ownerName}@example.com`}`, sql`${`${strangerName}@example.com`}`], sql`, `)})`,
	);
}, DB_SETUP_TIMEOUT);

// These suites run against the shared dev database and the usernames carry a per-run
// suffix, so without this every run's rows stay forever. It matters more here than the
// count suggests: the transcoding_jobs rows below are inserted at `pending` to simulate an
// encode in flight, and the worker's boot-time resume sweep re-sent every such row as a
// real job on each `make dev`.
//
// Works and posts must go FIRST and by creator_id: both carry ON DELETE SET NULL (a Work
// outlives its creator's account), so deleting the users alone orphans them rather than
// removing them — and the transcoding_jobs that cascade off works would survive with them.
afterAll(async () => {
	const owners = sql`SELECT id FROM users WHERE email IN (${sql.join([sql`${`${ownerName}@example.com`}`, sql`${`${strangerName}@example.com`}`], sql`, `)})`;
	await db.execute(sql`DELETE FROM works WHERE creator_id IN (${owners})`);
	await db.execute(sql`DELETE FROM posts WHERE creator_id IN (${owners})`);
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${ownerName}@example.com`}`, sql`${`${strangerName}@example.com`}`], sql`, `)})`,
	);
});

describe("Release-readiness gate", () => {
	// The gate MOVED rather than vanished. Readiness is a property of the media, the media
	// belongs to a Work, and a post that merely embeds a Work has nothing to wait for — so
	// this blocks RELEASE, and publishing an announcement is never blocked by an encode.
	let workId: number;
	let workSlug: string;
	let workPublicId: number;

	it("blocks releasing a Work whose media is still transcoding", async () => {
		const work = await makeItem(owner, "Gated build", "video");
		workId = work.id;
		workSlug = work.slug;
		workPublicId = work.publicId;
		await giveWorkAFile(workId);
		await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "video", status: "pending", progress: 0 });

		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ visibility: "released" }),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("media_not_ready");
	});

	it("publishes a post embedding that Work anyway", async () => {
		// The announcement is not the work. Blocking it on someone's encode was an artifact
		// of the post owning the media.
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Gate announce ${id}`,
				body: `Come get it: https://anthers.org/works/${workSlug}-${workPublicId}`,
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		expect((await res.json()).post.isPublished).toBe(true);
	});

	it("releases once the transcode completes", async () => {
		await db
			.update(transcodingJobs)
			.set({ status: "completed", progress: 100 })
			.where(eq(transcodingJobs.workId, workId));

		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ visibility: "released" }),
		});
		expect(res.status).toBe(200);
		const { work } = await res.json();
		expect(work.visibility).toBe("released");
		expect(work.releasedAt).toBeTruthy();
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
				access: FREE,
				contents: [{ kind: "text", bodyHtml: "<p>First</p>" }],
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		slug = (await res.json()).post.slug;
	});

	it("logs a timestamped entry when the title changes", async () => {
		// The PATCH response is re-read for the slug, because a title change re-derives
		// it now (Parker, 2026-10-16) — the plain slug form stops answering at the old name.
		const patch = await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `History renamed ${id}` }),
		});
		slug = (await patch.json()).post.slug;
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

describe("Post delete is guarded before it is anything else", () => {
	// Salvaged from the `delete-posts` branch (b4ccf33, 2026-07-06), whose implementation
	// was superseded by the Catalog separation but whose authorization cases were never
	// re-covered: every other delete test here signs in as the owner, so nothing pinned
	// what happens when someone else asks. That is the wrong gap to leave on a
	// destructive endpoint.
	it("refuses a stranger's delete with 404, not 403", async () => {
		const create = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `Guarded ${id}`, body: "mine", isPublished: true }),
		});
		expect(create.status).toBe(201);
		const slug = (await create.json()).post.slug;

		// 404 rather than 403 on purpose: a 403 would confirm the post exists to someone
		// with no business knowing, which is the same reasoning `adminHostOnly` follows.
		const asStranger = await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: stranger },
		});
		expect(asStranger.status).toBe(404);

		// And it really didn't delete it.
		const stillThere = await req(`/api/content/posts/${slug}`);
		expect(stillThere.status).toBe(200);

		const anonymous = await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN },
		});
		expect(anonymous.status).toBe(401);

		// Owner deletes it, and deleting it again is a 404 rather than a 500 — the same
		// answer a stranger gets, so a repeated request leaks nothing either.
		const first = await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(first.status).toBe(204);
		const second = await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(second.status).toBe(404);
	});
});

describe("Post delete never destroys the Work it announced", () => {
	// The opt-in media purge is GONE, deliberately. Under the old model a post OWNED its
	// content, so an explicit "also remove now-unused media?" was the careful thing to
	// offer. A Work stands on its own in the Catalog now and is deleted from there, on
	// purpose, by its own route — and since the embed derives from the body alone, the
	// route has nothing else to purge.
	it("leaves the embedded Work intact, even when asked to purge", async () => {
		const work = await makeReleasedWork(owner, "Survivor build");
		const create = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Purge ${id}`,
				body: `About this build: https://anthers.org/works/${work.slug}-${work.publicId}`,
				isPublished: false,
			}),
		});
		const slug = (await create.json()).post.slug;

		// `?purgeMedia=true` is accepted and ignored so an older client gets a no-op
		// rather than a 400 — but it must not destroy anything.
		const del = await req(`/api/content/posts/${slug}?purgeMedia=true`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(del.status).toBe(204);

		const [survivor] = await db.select().from(works).where(eq(works.id, work.id));
		expect(survivor).toBeDefined();
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
				access: FREE,
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
				access: FREE,
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

	it("stamps publishedAt when the sweep publishes, rather than leaving the draft date", async () => {
		// This is the omission that made the column necessary: the sweep published without
		// recording when, so a post drafted in January and auto-published in March sorted
		// as January for the rest of its life.
		const past = new Date(Date.now() - 60_000).toISOString();
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Sweep stamp ${id}`,
				isPublished: false,
				scheduledFor: past,
			}),
		});
		const slug = (await res.json()).post.slug;

		await publishScheduled();

		const get = await req(`/api/content/posts/${slug}`, { headers: { Cookie: owner } });
		const { post } = await get.json();
		expect(post.isPublished).toBe(true);
		expect(post.publishedAt).toBeTruthy();
		// Published now, not when the draft row was written.
		expect(new Date(post.publishedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
	});
});

/**
 * Two validation gaps found while checking the status report against the code, both in
 * the "a request that looks fine leaves the data wrong" family rather than the "500s"
 * family — which is why neither had coverage.
 */
describe("Delivery-method floor lives on the Work", () => {
	// The floor moved with delivery itself. It still has to be evaluated on the state the
	// edit RESULTS IN, because `.partial()` drops any create-time refine and a request
	// naming ONE field is legal or not depending on the stored value of the other.
	async function makeWork(title: string, body: Record<string, unknown> = {}) {
		const res = await req("/api/content/works", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ type: "game", title, maturityRows: rowsRatedAs("general"), ...body }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).work.id as number;
	}

	it("rejects a PATCH that switches both off", async () => {
		const workId = await makeWork(`BothOff ${id}`, { streamEnabled: true, downloadEnabled: true });
		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ streamEnabled: false, downloadEnabled: false }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects a PATCH that switches off the only one left", async () => {
		const workId = await makeWork(`LastOne ${id}`, {
			streamEnabled: true,
			downloadEnabled: false,
		});
		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ streamEnabled: false }),
		});
		expect(res.status).toBe(400);
	});

	it("allows switching one off while the other stays on", async () => {
		const workId = await makeWork(`SwapOne ${id}`, { streamEnabled: true, downloadEnabled: true });
		const res = await req(`/api/content/works/${workId}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ streamEnabled: false }),
		});
		expect(res.status).toBe(200);
	});

	it("no longer constrains a post at all", async () => {
		// A post has no delivery method to floor. It is words and links.
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `NoDelivery ${id}`, isPublished: true }),
		});
		expect(res.status).toBe(201);
	});
});

describe("A Work embedded in posts deletes freely, and the posts read on", () => {
	// The post_work_refs cascade this describe used to guard against is gone with the
	// table (Parker, 2026-10-16): an embed lives in the post's body, and a deleted Work
	// leaves the link it had exactly where it was — the same decay an embedded video has
	// when its source page goes away. Nothing strips, so nothing refuses; the flag stays
	// accepted (no-op) so an older client doesn't 400.
	async function postUsing(work: { id: number; slug: string; publicId: number }, title: string) {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title,
				body: `Announcing: https://anthers.org/works/${work.slug}-${work.publicId}`,
				isPublished: true,
			}),
		});
		expect(res.status).toBe(201);
		return (await res.json()).post.slug as string;
	}

	it("reports which posts embed a Work, and when they were posted", async () => {
		const work = await makeReleasedWork(owner, "Used build");
		const slug = await postUsing(work, `Uses ${id}`);
		const res = await req(`/api/content/works/${work.id}/usage`, { headers: { Cookie: owner } });
		expect(res.status).toBe(200);
		const { posts } = await res.json();
		expect(posts.length).toBe(1);
		// The posting history Parker asked for: not just where, but when.
		expect(posts[0].postedAt).toBeTruthy();
		await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
	});

	it("deletes the Work unflagged, and the post keeps its link as plain text", async () => {
		const work = await makeReleasedWork(owner, "Deleted build");
		const slug = await postUsing(work, `Linked ${id}`);
		const res = await req(`/api/content/works/${work.id}?force=true`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(res.status).toBe(204);
		const [gone] = await db.select().from(works).where(eq(works.id, work.id));
		expect(gone).toBeUndefined();

		// The post still reads; the embed resolves to nothing (the Work is gone), and
		// the body carries the link exactly as written.
		const detail = await req(`/api/content/posts/${slug}`);
		expect(detail.status).toBe(200);
		const { post } = await detail.json();
		expect((post.body as string).includes(`anthers.org/works/${work.slug}-${work.publicId}`)).toBe(
			true,
		);
		expect(post.linkedWorks.length).toBe(0);
		await req(`/api/content/posts/${slug}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
	});

	it("deletes an unembedded Work without a flag", async () => {
		const work = await makeReleasedWork(owner, "Unused build");
		const res = await req(`/api/content/works/${work.id}`, {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: owner },
		});
		expect(res.status).toBe(204);
	});
});

describe("Gaps the suite looked like it covered", () => {
	async function makeScheduledReadyPost(title: string) {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title,
				streamEnabled: true,
				downloadEnabled: false,
				access: FREE,
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

	it("lets a published post keep its link when the Work goes back to processing", async () => {
		// Formerly a 409: a PATCH to a published post whose media went unready was refused.
		// Publishing is not media-gated any more, so the announcement simply stands while
		// the Work re-encodes — and the Work's own gate is what stops anyone consuming it.
		const work = await makeReleasedWork(owner, "Re-encoding build", "video");
		const workId = work.id;
		const create = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({
				title: `Unready ${id}`,
				body: `Trailer: https://anthers.org/works/${work.slug}-${work.publicId}`,
				isPublished: true,
			}),
		});
		const slug = (await create.json()).post.slug;

		await db
			.insert(transcodingJobs)
			.values({ workId, mediaType: "video", status: "processing", progress: 10 });

		const res = await req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title: `Unready edited ${id}` }),
		});
		expect(res.status).toBe(200);
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

describe("The one pin", () => {
	/** Make a published post and return its slug. */
	async function publish(title: string): Promise<string> {
		const res = await req("/api/content/posts", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ title, body: `${title} body`, isPublished: true }),
		});
		expect(res.status).toBe(201);
		return (await res.json()).post.slug as string;
	}

	function pin(slug: string, isPinned: boolean) {
		return req(`/api/content/posts/${slug}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: owner },
			body: JSON.stringify({ isPinned }),
		});
	}

	async function pinnedSlugs(): Promise<string[]> {
		const res = await req("/api/content/posts?mine=true", { headers: { Cookie: owner } });
		expect(res.status).toBe(200);
		const { posts } = (await res.json()) as { posts: { slug: string; isPinned: boolean }[] };
		return posts.filter((p) => p.isPinned).map((p) => p.slug);
	}

	it("pinning a post takes the creator's only pin slot", async () => {
		const first = await publish(`First pinned ${id}`);
		const second = await publish(`Second pinned ${id}`);

		expect((await pin(first, true)).status).toBe(200);
		expect(await pinnedSlugs()).toEqual([first]);

		// Pinning the second is what the page confirms before doing: the first loses the
		// slot in the same request.
		expect((await pin(second, true)).status).toBe(200);
		expect(await pinnedSlugs()).toEqual([second]);
	});

	it("unpinning one post leaves the others as they were", async () => {
		const only = await publish(`Unpin ${id}`);
		expect((await pin(only, true)).status).toBe(200);
		expect((await pin(only, false)).status).toBe(200);
		expect(await pinnedSlugs()).toEqual([]);
	});
});
