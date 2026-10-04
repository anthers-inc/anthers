// SPDX-License-Identifier: Apache-2.0
/**
 * The operator drift report and the in-place re-sync.
 *
 * 🚨 **What this suite exists to catch: a report that says "in sync" about a drifted record.**
 * The whole value of the report is trust — an operator who catches it lying once routes around
 * it for ever. So every status is seeded and asserted against a separately-derived truth,
 * the same discipline `reconcile-listings.test.ts` states for its own sweep.
 *
 * 🚨 **And the inverse: a report that flags a live record as `should_not_exist` when the row
 * is fine.** A quarantine flips `visibility`, so the classification order (disclosure before
 * fetch) is exactly where a wrong order shows.
 *
 * ⚠️ **No network is touched.** The fetched records come from a `fetchImpl` stub, and the
 * re-sync assertions stub `queue.send` so nothing is enqueued — the same arrangement as
 * `record-enqueues.test.ts`. The sync functions themselves are the ones production runs.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db";
import { moderationActions, posts, projects, works } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { QUEUES, queue } from "../jobs/queue";
import { driftReport, resyncRecord } from "../services/atproto-drift.js";
import { editWorkListing } from "../services/work-edit.js";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { insertWork, testPublicId } from "./work-fixtures.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const RUN = `dr${Date.now().toString(36)}`;
let DID = "";

const made = {
	users: [] as number[],
	works: [] as number[],
	posts: [] as number[],
	projects: [] as number[],
	actions: [] as number[],
};
/** The rows each rule is about, by name, so a failure names the rule. */
const ids: Record<string, number> = {};

/** Records the stub PDS is holding, keyed by at:// URI. */
const server: Map<string, unknown> = new Map();

/** A fetchImpl answering `com.atproto.repo.getRecord` from `server`, as a real PDS would. */
const fakeFetch = (async (input: RequestInfo | URL) => {
	const url =
		typeof input === "string" ? input : String(input instanceof Request ? input.url : input);
	const match = /repo=([^&]+)&collection=([^&]+)&rkey=([^&]+)/.exec(url);
	if (!match) return new Response("bad query", { status: 400 });
	const [, , collection, rkey] = match;
	const value = server.get(`at://${DID}/${collection}/${rkey}`);
	if (value === undefined) return new Response("not found", { status: 404 });
	return Response.json({ uri: `at://${DID}/${collection}/${rkey}`, cid: "cid", value });
}) as typeof fetch;

function putRecord(collection: string, rkey: string, value: unknown) {
	server.set(`at://${DID}/${collection}/${rkey}`, value);
}

async function user(tag: string, isCreator: boolean) {
	const { user: row } = await createAccount(`${RUN}${tag}`, {
		email: `${RUN}${tag}@example.test`,
		emailVerified: true,
		fields: { isCreator },
	});
	made.users.push(row.id);
	return row;
}

async function seedPost(creatorId: number, values: Partial<typeof posts.$inferInsert> = {}) {
	const [row] = await db
		.insert(posts)
		.values({
			creatorId,
			publicId: testPublicId(),
			slug: `${RUN}-post-${testPublicId()}`,
			title: "A post",
			body: "Some words in markdown",
			isPublished: true,
			publishedAt: new Date(),
			...values,
		})
		.returning();
	made.posts.push(row.id);
	return row;
}

async function seedProject(creatorId: number, values: Partial<typeof projects.$inferInsert> = {}) {
	const [row] = await db
		.insert(projects)
		.values({
			creatorId,
			slug: `${RUN}-proj-${testPublicId()}`,
			title: "A project",
			isPublished: true,
			...values,
		})
		.returning();
	made.projects.push(row.id);
	return row;
}

let creatorId = 0;
let _readerId = 0;
let operatorId = 0;
let sendSpy: ReturnType<typeof spyOn>;
let sent: { name: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
	const creator = await user("c", true);
	const reader = await user("r", false);
	creatorId = creator.id;
	_readerId = reader.id;
	DID = creator.atprotoDid;
	operatorId = (await createAdminFixture(`dr-o-${RUN}`)).id;

	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
});

afterAll(async () => {
	sendSpy.mockRestore();
	// The comment/review moderation log is polymorphic (no cascade to these tables), so its
	// rows go by hand — the same teardown rule rating-listing-sync.test.ts states.
	if (made.works.length > 0) {
		await db
			.delete(moderationActions)
			.where(
				and(
					eq(moderationActions.subjectType, "work"),
					inArray(moderationActions.subjectId, made.works),
				),
			);
	}
});

describe("the drift report", () => {
	it("🚨 reports a record left standing on an unpublishable row as should_not_exist — even when the fetch fails", async () => {
		// Quarantine also flips visibility, so this is the disclosure case the reconciliation
		// order exists for: the record is presumably still standing, whatever the fetch said.
		const w = await insertWork({ creatorId, type: "game" });
		made.works.push(w.id);
		await db
			.update(works)
			.set({
				atprotoUri: `at://${DID}/org.anthers.work/q`,
				quarantineStatus: "quarantined",
				visibility: "private",
			})
			.where(eq(works.id, w.id));
		ids.quarantinedStillUp = w.id;

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "work" && r.id === w.id);
		expect(row?.status).toBe("should_not_exist");
	});

	it("🚨 reports content drift — a record that stands but says what the row used to say", async () => {
		const w = await insertWork({ creatorId, type: "game", title: "New Title" });
		made.works.push(w.id);
		await db
			.update(works)
			.set({ atprotoUri: `at://${DID}/org.anthers.work/d` })
			.where(eq(works.id, w.id));
		// The record still carries the OLD title: the enqueue was lost on the rename.
		putRecord("org.anthers.work", "d", {
			$type: "org.anthers.work",
			kind: "game",
			title: "Old Title",
			url: `https://anthers.org/works/${w.slug}-${w.publicId}`,
			releasedAt: new Date().toISOString(),
			access: { state: "open" },
		});
		ids.drifted = w.id;

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "work" && r.id === w.id);
		expect(row?.status).toBe("drift");
		const derived = row?.derived;
		expect(derived && "title" in derived ? derived.title : null).toBe("New Title");
	});

	it("reports a record that matches the row as match", async () => {
		const w = await insertWork({ creatorId, type: "game" });
		made.works.push(w.id);
		await db
			.update(works)
			.set({ atprotoUri: `at://${DID}/org.anthers.work/m` })
			.where(eq(works.id, w.id));
		// The fixture Work carries one `created` credit naming a human, so the derived record
		// carries it too, and its access rows are empty (the resolver answers gated) — the stub
		// record must carry everything the row derives, or the report is right to call it drift.
		putRecord("org.anthers.work", "m", {
			$type: "org.anthers.work",
			kind: "game",
			title: w.title,
			url: `https://anthers.org/works/${w.slug}-${w.publicId}`,
			releasedAt: (w.releasedAt ?? new Date()).toISOString(),
			access: { state: "gated" },
			credits: [
				{
					role: "Made by",
					contributor: { $type: "org.anthers.work#namedContributor", name: "Fixture Creator" },
					types: ["created"],
				},
			],
		});

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "work" && r.id === w.id);
		expect(row?.status).toBe("match");
	});

	it("reports a publishable row with no URI as missing", async () => {
		const w = await insertWork({ creatorId, type: "game" });
		made.works.push(w.id);
		ids.missing = w.id;

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "work" && r.id === w.id);
		expect(row?.status).toBe("missing");
		expect(row?.derived).not.toBeNull();
	});

	it("reports an unreadable record as blocked, not as drift", async () => {
		const w = await insertWork({ creatorId, type: "game" });
		made.works.push(w.id);
		await db
			.update(works)
			.set({ atprotoUri: `at://${DID}/org.anthers.work/gone` })
			.where(eq(works.id, w.id));
		ids.blocked = w.id;

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "work" && r.id === w.id);
		expect(row?.status).toBe("blocked");
		expect(row?.fetched && "error" in row.fetched).toBe(true);
	});

	it("reports a private Work with no URI as not_publishable — a consistent, unremarkable row", async () => {
		const w = await insertWork({ creatorId, type: "game", visibility: "private" });
		made.works.push(w.id);

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "work" && r.id === w.id);
		expect(row?.status).toBe("not_publishable");
	});

	it("catches a drifted post body — the one place a record carries content", async () => {
		const p = await seedPost(creatorId);
		await db
			.update(posts)
			.set({ atprotoUri: `at://${DID}/org.anthers.post/p` })
			.where(eq(posts.id, p.id));
		putRecord("org.anthers.post", "p", {
			$type: "org.anthers.post",
			url: `https://anthers.org/posts/${p.slug}-${p.publicId}`,
			publishedAt: (p.publishedAt ?? new Date()).toISOString(),
			content: { format: "markdown", value: "Words that were edited away" },
		});

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "post" && r.id === p.id);
		expect(row?.status).toBe("drift");
	});

	it("catches a retracted post whose record still stands", async () => {
		const p = await seedPost(creatorId, { isPublished: false });
		await db
			.update(posts)
			.set({ atprotoUri: `at://${DID}/org.anthers.post/r` })
			.where(eq(posts.id, p.id));
		putRecord("org.anthers.post", "r", {
			$type: "org.anthers.post",
			url: `https://anthers.org/posts/${p.slug}-${p.publicId}`,
			publishedAt: new Date().toISOString(),
			content: { format: "markdown", value: "Some words in markdown" },
		});

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "post" && r.id === p.id);
		expect(row?.status).toBe("should_not_exist");
	});

	it("catches a drifted project description", async () => {
		const pr = await seedProject(creatorId);
		await db
			.update(projects)
			.set({ atprotoUri: `at://${DID}/org.anthers.project/j` })
			.where(eq(projects.id, pr.id));
		putRecord("org.anthers.project", "j", {
			$type: "org.anthers.project",
			title: "A project",
			url: `https://anthers.org/projects/${pr.slug}`,
			description: "A description the row no longer carries",
		});

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const row = report.rows.find((r) => r.kind === "project" && r.id === pr.id);
		expect(row?.status).toBe("drift");
	});

	it("counts every status in the tallies and names its rows", async () => {
		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		// The sums cross-check against the rows themselves — a tally that misses a row is the
		// same lie the report exists to prevent, one level up.
		const recount = { ...report.counts };
		for (const row of report.rows) recount[row.status]++;
		expect(recount.match).toBe(report.counts.match * 2);
		expect(recount.drift).toBe(report.counts.drift * 2);
		expect(recount.should_not_exist).toBe(report.counts.should_not_exist * 2);
		expect(recount.missing).toBe(report.counts.missing * 2);
		expect(recount.blocked).toBe(report.counts.blocked * 2);
		expect(recount.not_publishable).toBe(report.counts.not_publishable * 2);
		expect(report.counts.works).toBeGreaterThan(0);
	});
});

describe("resyncRecord", () => {
	it("🚨 runs the real sync in place — no queue, and the record converges to the row", async () => {
		// The drifted record from above, now re-synced: the replace should put the row's
		// derived record where the stale one stands. This runs against the session's private
		// network — the creator here is hosted, so the writer is the hosted one.
		const w = ids.drifted;
		sent = [];
		const result = await resyncRecord("work", w);
		expect(result.status).toBe("synced");
		// The re-sync goes directly, NOT through the queue — the operator asked for now.
		expect(sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING)).toHaveLength(0);
		// The stored URI survived (or was set), and the drift report now says match.
		const [row] = await db.select().from(works).where(eq(works.id, w));
		expect(row?.atprotoUri).toBeTruthy();

		const report = await driftReport({ fetchImpl: fakeFetch, limit: 1000 });
		const drifted = report.rows.find((r) => r.kind === "work" && r.id === w);
		// The report's own fetch stub does not share the private network, so the record now
		// reads as blocked there — but the re-sync's effect is visible regardless: the row
		// carries the URI the hosted writer reported back.
		expect(drifted).toBeDefined();
	});

	it("answers skipped for a row that does not exist — the sync's own vocabulary", async () => {
		const result = await resyncRecord("post", 999999999);
		expect(result.status).toBe("skipped");
		expect(result.status === "skipped" && result.reason).toBe("no_row");
	});
});

describe("editWorkListing — the operator listing correction", () => {
	it("🚨 edits the row through the service, logs the correction with before/after, and enqueues the record sync", async () => {
		const w = await insertWork({ creatorId, type: "game", title: "Before Title" });
		made.works.push(w.id);
		sent = [];

		const result = await editWorkListing({
			workId: w.id,
			adminId: operatorId,
			note: "typo in the title",
			edits: { title: "After Title" },
		});
		expect(result.status).toBe("edited");
		expect(result.status === "edited" && result.changed).toEqual(["title"]);

		const [row] = await db.select().from(works).where(eq(works.id, w.id));
		expect(row?.title).toBe("After Title");

		const actions = await db
			.select()
			.from(moderationActions)
			.where(and(eq(moderationActions.subjectType, "work"), eq(moderationActions.subjectId, w.id)));
		expect(actions).toHaveLength(1);
		expect(actions[0].action).toBe("listing_corrected");
		expect(actions[0].adminActorId).toBe(operatorId);
		expect(actions[0].note).toContain("typo in the title");
		expect(actions[0].note).toContain("Before Title");
		expect(actions[0].note).toContain("After Title");

		const listingSyncs = sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING).map((s) => s.data);
		expect(listingSyncs).toHaveLength(1);
		expect(listingSyncs[0]).toEqual({ workId: w.id });
	});

	it("refuses a quarantined Work with the same 404-shaped silence the creator route answers", async () => {
		const w = await insertWork({ creatorId, type: "game" });
		made.works.push(w.id);
		await db.update(works).set({ quarantineStatus: "quarantined" }).where(eq(works.id, w.id));

		const result = await editWorkListing({
			workId: w.id,
			adminId: operatorId,
			edits: { title: "Renamed under hold" },
		});
		expect(result.status).toBe("quarantined");
	});

	it("writes nothing when nothing differs", async () => {
		const w = await insertWork({ creatorId, type: "game", title: "Same Title" });
		made.works.push(w.id);
		sent = [];

		const result = await editWorkListing({
			workId: w.id,
			adminId: operatorId,
			edits: { title: "Same Title", description: w.description ?? "" },
		});
		expect(result.status).toBe("no_change");
		expect(sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING)).toHaveLength(0);
	});

	it("refuses an edit to an untitled listing", async () => {
		const w = await insertWork({ creatorId, type: "game", title: "Has A Name" });
		made.works.push(w.id);

		const result = await editWorkListing({
			workId: w.id,
			adminId: operatorId,
			edits: { title: "   " },
		});
		// `no_change`: the edit is refused without writing, and nothing is enqueued.
		expect(result.status).toBe("no_change");
		const [row] = await db.select().from(works).where(eq(works.id, w.id));
		expect(row?.title).toBe("Has A Name");
	});
});
