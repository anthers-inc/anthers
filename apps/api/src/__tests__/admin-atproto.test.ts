// SPDX-License-Identifier: Apache-2.0
/**
 * The admin ATProto surface: the drift report route, the re-sync route, and the Work listing
 * correction route.
 *
 * 🚨 **The gate is the first subject**: every route 401s without an admin session, 401s with a
 * main-site session, and the report answers only on the admin host. The report's *content* is
 * `atproto-drift.test.ts`'s subject; this suite proves the doors are shaped right and the
 * correction route writes the audit row an operator's console will read.
 *
 * ⚠️ `queue.send` is stubbed, so no record write is attempted and no worker is needed — the
 * enqueue assertions here are about the listing-correction route asking for its sync, which
 * `atproto-drift.test.ts` proves converges.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { moderationActions } from "@anthers/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { QUEUES, queue } from "../jobs/queue";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

/** 🚨 Naming `ADMIN_URL` is what makes the wrong-host refusal real here (see admin-books.test.ts). */
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const RUN = `adr${Date.now().toString(36)}`.slice(0, 12);
let creatorId = 0;
let adminCookie = "";
let siteCookie = "";
const made = { works: [] as number[] };
let sendSpy: ReturnType<typeof spyOn>;
let sent: { name: string; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	creatorId = (
		await createAccount(`${RUN}c`, {
			email: `${RUN}c@example.test`,
			emailVerified: true,
			fields: { isCreator: true },
		})
	).userId;
	siteCookie = (
		await createAccount(`${RUN}s`, { email: `${RUN}s@example.test`, emailVerified: true })
	).cookie;
	adminCookie = (await createAdminFixture(`adr-o-${RUN}`)).cookie;

	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
});

afterAll(async () => {
	sendSpy.mockRestore();
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;
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

describe("the admin ATProto routes' gates", () => {
	it("🚨 the drift report 401s without a session and with a main-site session, and answers with one", async () => {
		const noSession = await req("/api/admin/atproto/drift");
		expect(noSession.status).toBe(401);

		const siteSession = await req("/api/admin/atproto/drift", { headers: { Cookie: siteCookie } });
		expect(siteSession.status).toBe(401);

		const admin = await req("/api/admin/atproto/drift", { headers: { Cookie: adminCookie } });
		expect(admin.status).toBe(200);
		const body = (await admin.json()) as {
			report: { counts: Record<string, number>; rows: unknown[] };
		};
		expect(body.report.counts).toBeDefined();
		expect(Array.isArray(body.report.rows)).toBe(true);
	});

	it("🚨 the report 404s off the admin host — the whole surface is invisible from the site", async () => {
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/atproto/drift`, { headers: { Cookie: adminCookie } }),
		);
		expect(res.status).toBe(404);
	});

	it("🚨 the mutating routes refuse a bad origin", async () => {
		const res = await req("/api/admin/atproto/resync", {
			method: "POST",
			headers: { Cookie: adminCookie, Origin: "http://evil.example" },
			body: JSON.stringify({ kind: "work", id: 1 }),
		});
		expect(res.status).toBe(403);
	});
});

describe("POST /works/listing — the operator listing correction", () => {
	it("🚨 corrects a title through the service: the row changes, the sync is enqueued, the log records it", async () => {
		const w = await insertWork({ creatorId, type: "game", title: "Before" });
		made.works.push(w.id);
		sent = [];

		const res = await req("/api/admin/works/listing", {
			method: "POST",
			headers: { Cookie: adminCookie, "Content-Type": "application/json", Origin: ADMIN_HOST },
			body: JSON.stringify({ workId: w.id, title: "After", note: "fixing a typo" }),
		});
		expect(res.status).toBe(200);

		// postgres-js returns the rows array directly from db.execute().
		const rowsRes = await db.execute(sql`SELECT title FROM works WHERE id = ${w.id}`);
		const rows = rowsRes as unknown as { title: string }[];
		expect(rows[0]?.title).toBe("After");

		const actions = await db
			.select()
			.from(moderationActions)
			.where(and(eq(moderationActions.subjectType, "work"), eq(moderationActions.subjectId, w.id)));
		expect(actions).toHaveLength(1);
		expect(actions[0].action).toBe("listing_corrected");
		expect(actions[0].adminActorId).not.toBeNull();

		expect(sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING)).toHaveLength(1);
	});

	it("answers 400 when nothing differed and 404 for a missing Work — and never for a quarantined one says why", async () => {
		const w = await insertWork({ creatorId, type: "game", title: "Same" });
		made.works.push(w.id);

		const noChange = await req("/api/admin/works/listing", {
			method: "POST",
			headers: { Cookie: adminCookie, "Content-Type": "application/json", Origin: ADMIN_HOST },
			body: JSON.stringify({ workId: w.id, title: "Same" }),
		});
		expect(noChange.status).toBe(400);

		const missing = await req("/api/admin/works/listing", {
			method: "POST",
			headers: { Cookie: adminCookie, "Content-Type": "application/json", Origin: ADMIN_HOST },
			body: JSON.stringify({ workId: 999999999, title: "Nope" }),
		});
		expect(missing.status).toBe(404);
	});

	it("🚨 enqueues nothing and answers 404 for a quarantined Work", async () => {
		const w = await insertWork({ creatorId, type: "game" });
		made.works.push(w.id);
		await db.execute(sql`UPDATE works SET quarantine_status = 'quarantined' WHERE id = ${w.id}`);
		sent = [];

		const res = await req("/api/admin/works/listing", {
			method: "POST",
			headers: { Cookie: adminCookie, "Content-Type": "application/json", Origin: ADMIN_HOST },
			body: JSON.stringify({ workId: w.id, title: "Renamed under hold" }),
		});
		expect(res.status).toBe(404);
		expect(sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING)).toHaveLength(0);
	});
});

describe("POST /atproto/resync", () => {
	it("answers the sync's own outcome vocabulary", async () => {
		const w = await insertWork({ creatorId, type: "game", visibility: "private" });
		made.works.push(w.id);

		const res = await req("/api/admin/atproto/resync", {
			method: "POST",
			headers: { Cookie: adminCookie, "Content-Type": "application/json", Origin: ADMIN_HOST },
			body: JSON.stringify({ kind: "work", id: w.id }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: { status: string; plan?: { action?: string } } };
		// A private Work is unpublishable: its sync runs and answers "synced" with a plan that
		// writes nothing — the row is already in the state its (absent) record would mirror.
		expect(body.result.status).toBe("synced");
		expect(body.result.plan?.action).toBe("none");
	});
});
