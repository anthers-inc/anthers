// SPDX-License-Identifier: Apache-2.0
/**
 * The deadlines endpoint — every obligation with a due date, gathered across all sources and
 * listed for the admin home.
 *
 * The properties pinned here are the ones the 2026-09-14 decision turns on:
 *
 * 1. **The gate holds.** No session → 401, a signed-in Anthers account → 401, and the whole
 *    surface 404s off the admin host — the same two gates every admin route answers behind.
 * 2. **The gather is honest about what it excludes.** An open rights request, a DMCA notice with
 *    an open counter-notice window, an unexpired legal hold and the calendar's own obligations are
 *    all in; their resolved, lifted, finalized, restored and indefinite counterparts are all out.
 * 3. **Urgency is the sort.** Past due first, then nearest — a missed deadline outranks a distant
 *    one however far out the distant one is.
 * 4. **The deferred sources are named rather than silently omitted.**
 *
 * Rows are written directly rather than driven through the routes: the routes that create them
 * are other suites' subjects, and this one tests the reading of rows that already carry their
 * dates.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { type DmcaNoticeStatus, dmcaNotices, legalHolds, rightsRequests } from "@anthers/db/schema";
import { inArray } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { createAdminFixture } from "./admin-fixture";
import { purgeAccountsCreatedHere, purgeAdminAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();
purgeAdminAccountsCreatedHere();

const testFetch = app.fetch;

/**
 * 🚨 **Naming `ADMIN_URL` is what makes the wrong-host refusal real here.** With it unset the
 * admin host falls back to "any host in a checkout" (`isAdminHost`), so nothing can 404 — the
 * same reason `admin-books.test.ts` pins it before asserting host behavior.
 */
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const id = crypto.randomUUID().slice(0, 8);
const DAY_MS = 86_400_000;

interface DeadlineRow {
	source: string;
	key: string;
	title: string;
	dueAt: string;
	pastDue: boolean;
	terminal: boolean;
	actUrl: string | null;
}

interface DeadlinesResponse {
	deadlines: DeadlineRow[];
	deferred: { id: string; note: string }[];
}

let adminCookie: string;
let plainCookie: string;
const requestIds: number[] = [];
const noticeIds: number[] = [];
const holdIds: number[] = [];

/** A past-due date and a future one, so every kind of row can sit on both sides of now. */
const PAST = new Date(Date.now() - 5 * DAY_MS);
const FUTURE = new Date(Date.now() + 25 * DAY_MS);

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("deadlines")).cookie;
	const user = await createAccount(`deadlines_${id}`);
	plainCookie = user.cookie;
}, DB_SETUP_TIMEOUT);

/** An open rights request, due when asked. */
async function openRequest(dueAt: Date): Promise<number> {
	const [row] = await db
		.insert(rightsRequests)
		.values({
			userId: null,
			email: `deadlines-${id}@example.com`,
			kind: "access",
			details: `what do you hold ${id}`,
			dueAt,
		})
		.returning({ id: rightsRequests.id });
	requestIds.push(row.id);
	return row.id;
}

/** A DMCA notice in `status`, with the window columns a notice in that status would carry. */
async function notice(
	status: DmcaNoticeStatus,
	extra: {
		counterNoticeDueBy?: Date;
		restoreNoEarlierThan?: Date;
		finalizedAt?: Date;
	} = {},
): Promise<number> {
	const [row] = await db
		.insert(dmcaNotices)
		.values({
			workId: null,
			workTitle: `Deadline fixture ${id}`,
			complainantName: "Copyright Holder",
			complainantEmail: `deadlines-${id}@example.com`,
			complainantAddress: "123 Main St, Anytown, US",
			copyrightedWorkDescription: "An original game.",
			infringingMaterialDescription: "A copy of it.",
			goodFaithStatement: "Not authorized.",
			authorizationStatement: "Authorized to act.",
			fairUseConsidered: true,
			attestationTextSnapshot: "EXAMPLE attestation",
			status,
			...extra,
		})
		.returning({ id: dmcaNotices.id });
	noticeIds.push(row.id);
	return row.id;
}

/** An unlifted legal hold, expiring when asked — or never, when `expiresAt` is null. */
async function hold(expiresAt: Date | null): Promise<number> {
	const [row] = await db
		.insert(legalHolds)
		.values({
			subjectType: "user",
			subjectId: 1,
			reason: `fixture hold ${id}`,
			expiresAt,
		})
		.returning({ id: legalHolds.id });
	holdIds.push(row.id);
	return row.id;
}

async function deadlines(): Promise<DeadlinesResponse> {
	const res = await req("/api/admin/deadlines", { headers: { Cookie: adminCookie } });
	expect(res.status).toBe(200);
	return (await res.json()) as DeadlinesResponse;
}

describe("GET /api/admin/deadlines — the gate", () => {
	it("401s with no session", async () => {
		const res = await req("/api/admin/deadlines");
		expect(res.status).toBe(401);
	});

	it("401s for a signed-in Anthers account, which opens nothing here", async () => {
		const res = await testFetch(
			new Request(`${ADMIN_HOST}/api/admin/deadlines`, { headers: { Cookie: plainCookie } }),
		);
		expect(res.status).toBe(401);
	});

	it("404s off the admin host", async () => {
		const res = await testFetch(new Request(`${SITE_HOST}/api/admin/deadlines`));
		expect(res.status).toBe(404);
	});
});

describe("GET /api/admin/deadlines — the gather", () => {
	it("carries an open rights request, and not a resolved one", async () => {
		const openId = await openRequest(FUTURE);
		const [resolved] = await db
			.insert(rightsRequests)
			.values({
				userId: null,
				email: `deadlines-resolved-${id}@example.com`,
				kind: "access",
				dueAt: FUTURE,
				status: "resolved",
				resolutionNote: "answered",
			})
			.returning({ id: rightsRequests.id });
		requestIds.push(resolved.id);

		const body = await deadlines();
		const keys = body.deadlines.map((d) => d.key);
		expect(keys).toContain(`rights-request:${openId}`);
		expect(keys).not.toContain(`rights-request:${resolved}`);
	});

	it("carries a DMCA counter-notice window, and not a finalized, restored or rejected notice", async () => {
		const openId = await notice("actioned", { counterNoticeDueBy: FUTURE });
		const [finalId, restoredId, rejectedId] = await Promise.all([
			notice("actioned", { counterNoticeDueBy: FUTURE, finalizedAt: new Date() }),
			notice("restored", { counterNoticeDueBy: FUTURE }),
			notice("rejected", {}),
		]);

		const body = await deadlines();
		const keys = body.deadlines.map((d) => d.key);
		expect(keys).toContain(`dmca-counter-notice:${openId}`);
		expect(keys).not.toContain(`dmca-counter-notice:${finalId}`);
		expect(keys).not.toContain(`dmca-counter-notice:${restoredId}`);
		expect(keys).not.toContain(`dmca-counter-notice:${rejectedId}`);
	});

	it("carries a counter-noticed notice's restore window, and not one with a suit recorded", async () => {
		const openId = await notice("counter_noticed", { restoreNoEarlierThan: FUTURE });
		const [suitedId] = await db
			.insert(dmcaNotices)
			.values({
				workId: null,
				workTitle: `Suit fixture ${id}`,
				complainantName: "Copyright Holder",
				complainantEmail: `deadlines-suit-${id}@example.com`,
				complainantAddress: "123 Main St, Anytown, US",
				copyrightedWorkDescription: "An original game.",
				infringingMaterialDescription: "A copy of it.",
				goodFaithStatement: "Not authorized.",
				authorizationStatement: "Authorized to act.",
				fairUseConsidered: true,
				attestationTextSnapshot: "EXAMPLE attestation",
				status: "counter_noticed",
				restoreNoEarlierThan: FUTURE,
				suitFiledAt: new Date(),
			})
			.returning({ id: dmcaNotices.id });
		noticeIds.push(suitedId.id);

		const body = await deadlines();
		const keys = body.deadlines.map((d) => d.key);
		expect(keys).toContain(`dmca-restore:${openId}`);
		expect(keys).not.toContain(`dmca-restore:${suitedId}`);
	});

	it("carries an unexpired legal hold, and not a lifted one or an indefinite one", async () => {
		const activeId = await hold(FUTURE);
		const [liftedId] = await db
			.insert(legalHolds)
			.values({
				subjectType: "user",
				subjectId: 1,
				reason: `lifted fixture ${id}`,
				expiresAt: FUTURE,
				liftedAt: new Date(),
			})
			.returning({ id: legalHolds.id });
		holdIds.push(liftedId.id);
		const indefiniteId = await hold(null);

		const body = await deadlines();
		const keys = body.deadlines.map((d) => d.key);
		expect(keys).toContain(`legal-hold:${activeId}`);
		expect(keys).not.toContain(`legal-hold:${liftedId}`);
		expect(keys).not.toContain(`legal-hold:${indefiniteId}`);
	});

	it("carries the calendar's own obligations, with terminal flags on exactly three", async () => {
		const body = await deadlines();
		const calendar = body.deadlines.filter((d) => d.source === "compliance-calendar");
		expect(calendar.length).toBeGreaterThanOrEqual(8);
		const terminal = body.deadlines.filter((d) => d.terminal).map((d) => d.key);
		for (const key of terminal) {
			// A terminal flag anywhere but the calendar would widen the Calendar's rule, which
			// names exactly three obligations.
			expect(key.startsWith("compliance-calendar:")).toBe(true);
		}
		// The three the Calendar names, as calendar keys: periodic-report, dmca-designated-agent,
		// form-990. Instance dates vary by read time, so the assertion is on the key's head.
		const heads = terminal.map((k) => k.split(":")[1]);
		expect(heads).toContain("periodic-report");
		expect(heads).toContain("dmca-designated-agent");
		expect(heads).toContain("form-990");
	});

	it("points each database item at its admin screen, and says honestly that calendar items have none", async () => {
		const body = await deadlines();
		for (const row of body.deadlines) {
			if (row.source === "rights-request") expect(row.actUrl).toBe("/legal/rights-requests");
			if (row.source === "dmca-counter-notice" || row.source === "dmca-restore")
				expect(row.actUrl).toBe("/legal/dmca");
			if (row.source === "legal-hold") expect(row.actUrl).toBe("/legal/holds");
			if (row.source === "compliance-calendar") expect(row.actUrl).toBeNull();
		}
	});
});

describe("GET /api/admin/deadlines — urgency and honesty", () => {
	it("sorts past due first, then nearest", async () => {
		// A past-due rights request and a future one: the past-due one must sort above every
		// upcoming item in the list, including calendar items years out.
		await openRequest(PAST);
		await openRequest(new Date(Date.now() + 40 * DAY_MS));

		const body = await deadlines();
		// In a correctly sorted list every past-due item sits above every upcoming one, so the
		// count of past-due items is the boundary, and each half then ascends by due date.
		const pastDueCount = body.deadlines.filter((d) => d.pastDue).length;
		expect(pastDueCount).toBeGreaterThan(0);
		for (let i = 0; i < pastDueCount; i++) {
			expect(body.deadlines[i].pastDue).toBe(true);
		}
		for (let i = pastDueCount; i < body.deadlines.length; i++) {
			expect(body.deadlines[i].pastDue).toBe(false);
		}
		const dueTimes = body.deadlines.map((d) => new Date(d.dueAt).getTime());
		const pastDueTimes = dueTimes.slice(0, pastDueCount);
		const upcomingTimes = dueTimes.slice(pastDueCount);
		expect([...pastDueTimes].sort((a, b) => a - b)).toEqual(pastDueTimes);
		expect([...upcomingTimes].sort((a, b) => a - b)).toEqual(upcomingTimes);
	});

	it("names the deferred sources rather than omitting them silently", async () => {
		const body = await deadlines();
		const ids = body.deferred.map((d) => d.id);
		expect(ids).toContain("sales-tax-filing-periods");
		expect(ids).toContain("out-of-state-thresholds");
		expect(ids).toContain("collect-and-pay-out");
		for (const d of body.deferred) {
			expect(d.note.length).toBeGreaterThan(0);
		}
	});
});

afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	if (requestIds.length > 0) {
		await db.delete(rightsRequests).where(inArray(rightsRequests.id, requestIds));
	}
	if (noticeIds.length > 0) {
		await db.delete(dmcaNotices).where(inArray(dmcaNotices.id, noticeIds));
	}
	if (holdIds.length > 0) {
		await db.delete(legalHolds).where(inArray(legalHolds.id, holdIds));
	}
});
