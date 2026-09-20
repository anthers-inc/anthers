// SPDX-License-Identifier: Apache-2.0
/**
 * Scheduling a Work's release, and the sweep that carries it out.
 *
 * 🚨 **The sweep is where this could go wrong quietly**, which is why most of the suite is about
 * it. It releases with nobody making a request, so a sweep that released on the clock alone would
 * walk past every condition the release route exists to hold — an unrated Work, one still
 * processing, one whose creator's payouts lapsed — and nothing on any screen would say so. Each
 * of those is asserted here, in both directions: what waits, and what gives the schedule up.
 *
 * ⚠️ `queue.send` is replaced, so the listing sync a release asks for can be read rather than run.
 */

import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { db } from "@anthers/db/client";
import { notifications, stripeAccounts, transcodingJobs, works } from "@anthers/db/schema";
import { rowsRatedAs } from "@anthers/shared/content-rating-fixtures";
import { and, eq, inArray, sql } from "drizzle-orm";
import app from "../index";
import { CRON_SCHEDULES, QUEUES, queue } from "../jobs/queue";
import { releaseScheduled } from "../jobs/release-scheduled";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayouts } from "./payouts-fixture.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const creatorName = `sched_${run}`;
const unpaidName = `sched_unpaid_${run}`;

let creator = { id: 0, cookie: "" };
let unpaid = { id: 0, cookie: "" };
const workIds: number[] = [];
let sent: Array<{ name: string; data: Record<string, unknown> }> = [];
let sendSpy: ReturnType<typeof spyOn>;

const HOUR = 60 * 60 * 1000;
const inAnHour = () => new Date(Date.now() + HOUR).toISOString();

function call(method: string, path: string, cookie: string, body?: unknown) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
}

/** A private Work, rated unless told otherwise, with no file to wait on. */
async function stage(
	creatorId: number,
	over: Partial<Parameters<typeof insertWork>[0]> = {},
): Promise<number> {
	const row = await insertWork({ creatorId, type: "game", visibility: "private", ...over });
	workIds.push(row.id);
	return row.id;
}

async function row(workId: number) {
	const [found] = await db.select().from(works).where(eq(works.id, workId));
	return found;
}

/** Make a Work due: its scheduled time a minute in the past. */
async function makeDue(workId: number): Promise<Date> {
	const at = new Date(Date.now() - 60_000);
	await db.update(works).set({ scheduledReleaseAt: at }).where(eq(works.id, workId));
	return at;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${creatorName + "@example.com"}`, sql`${unpaidName + "@example.com"}`], sql`, `)})`,
	);
	const a = await createAccount(creatorName);
	await enablePayouts(creatorName);
	creator = { id: a.userId as number, cookie: a.cookie };
	const b = await createAccount(unpaidName, { fields: { isCreator: true } });
	unpaid = { id: b.userId as number, cookie: b.cookie };
	sendSpy = spyOn(queue, "send").mockImplementation((async (name: string, data: unknown) => {
		sent.push({ name, data: data as Record<string, unknown> });
		return "job";
	}) as typeof queue.send);
}, DB_SETUP_TIMEOUT);

// By id, because the account purge sets `works.creator_id` null when it runs first.
afterAll(async () => {
	sendSpy.mockRestore();
	if (workIds.length > 0) await db.delete(works).where(inArray(works.id, workIds));
});

describe("scheduling a release", () => {
	it("stores a time for a rated private Work", async () => {
		const workId = await stage(creator.id);
		const at = inAnHour();
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: at,
		});
		expect(res.status).toBe(200);
		expect(Date.parse((await res.json()).work.scheduledReleaseAt)).toBe(Date.parse(at));
		expect((await row(workId)).visibility).toBe("private");
	});

	it("refuses a time that has already passed", async () => {
		const workId = await stage(creator.id);
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: new Date(Date.now() - HOUR).toISOString(),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("schedule_in_past");
	});

	it("refuses an unrated Work, and takes the rating in the same request", async () => {
		// Nobody is at the screen when the sweep runs, so a schedule that could only be refused
		// is refused now.
		const workId = await stage(creator.id, { maturity: "unrated" });
		const refused = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(refused.status).toBe(409);
		expect((await refused.json()).code).toBe("maturity_undeclared");
		expect((await row(workId)).scheduledReleaseAt).toBeNull();

		const accepted = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			maturityRows: rowsRatedAs("general"),
			scheduledReleaseAt: inAnHour(),
		});
		expect(accepted.status).toBe(200);
	});

	it("refuses a creator whose payouts are not set up", async () => {
		const workId = await stage(unpaid.id);
		const res = await call("PATCH", `/api/content/works/${workId}`, unpaid.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("payouts_required");
	});

	it("accepts a Work whose media is still processing, which is what a schedule waits for", async () => {
		const workId = await stage(creator.id, {
			type: "video",
			sourceKey: `creators/${creator.id}/v`,
		});
		await db.insert(transcodingJobs).values({ workId, mediaType: "video", status: "processing" });
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(200);
	});

	it("refuses a Work that is already released", async () => {
		const workId = await stage(creator.id, { visibility: "released" });
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("schedule_not_private");
	});

	it("is cleared by releasing now", async () => {
		const workId = await stage(creator.id, {
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		});
		await db
			.update(works)
			.set({ scheduledReleaseAt: new Date(Date.now() + HOUR) })
			.where(eq(works.id, workId));
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			visibility: "released",
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(200);
		const stored = await row(workId);
		expect(stored.visibility).toBe("released");
		expect(stored.scheduledReleaseAt).toBeNull();
	});

	it("is refused on create, like a release", async () => {
		const res = await call("POST", "/api/content/works", creator.cookie, {
			type: "game",
			title: `sched ${run}`,
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("release_on_create");
	});

	it("leaves a Work waiting past its time editable", async () => {
		const workId = await stage(creator.id);
		const at = await makeDue(workId);
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			title: "Renamed while waiting",
			scheduledReleaseAt: at.toISOString(),
		});
		expect(res.status).toBe(200);
	});
});

describe("the release-scheduled sweep", () => {
	it("releases a due Work that is ready, and asks for its listing", async () => {
		const workId = await stage(creator.id);
		await makeDue(workId);
		sent = [];
		await releaseScheduled();
		const stored = await row(workId);
		expect(stored.visibility).toBe("released");
		expect(stored.releasedAt).not.toBeNull();
		expect(stored.scheduledReleaseAt).toBeNull();
		expect(
			sent.filter((s) => s.name === QUEUES.SYNC_WORK_LISTING).map((s) => s.data),
		).toContainEqual({
			workId,
		});
	});

	it("leaves a Work alone until its time comes", async () => {
		const workId = await stage(creator.id);
		await db
			.update(works)
			.set({ scheduledReleaseAt: new Date(Date.now() + HOUR) })
			.where(eq(works.id, workId));
		await releaseScheduled();
		expect((await row(workId)).visibility).toBe("private");
	});

	it("waits on processing, keeps the schedule, and releases once it is done", async () => {
		const workId = await stage(creator.id, {
			type: "video",
			sourceKey: `creators/${creator.id}/v2`,
		});
		await db.insert(transcodingJobs).values({ workId, mediaType: "video", status: "processing" });
		const at = await makeDue(workId);

		await releaseScheduled();
		let stored = await row(workId);
		expect(stored.visibility).toBe("private");
		expect(stored.scheduledReleaseAt?.getTime()).toBe(at.getTime());

		await db
			.update(transcodingJobs)
			.set({ status: "completed" })
			.where(eq(transcodingJobs.workId, workId));
		await releaseScheduled();
		stored = await row(workId);
		expect(stored.visibility).toBe("released");
	});

	it("gives up the schedule and tells the creator when their payouts have lapsed", async () => {
		const workId = await stage(creator.id);
		const at = await makeDue(workId);
		await db
			.update(stripeAccounts)
			.set({ payoutsEnabled: false })
			.where(eq(stripeAccounts.userId, creator.id));
		try {
			await releaseScheduled();
			await releaseScheduled();
		} finally {
			await enablePayouts(creatorName);
		}

		const stored = await row(workId);
		expect(stored.visibility).toBe("private");
		expect(stored.scheduledReleaseAt).toBeNull();

		// Told once, however many times the sweep ran.
		const notices = await db
			.select()
			.from(notifications)
			.where(
				and(
					eq(notifications.userId, creator.id),
					eq(notifications.dedupeKey, `scheduled-release-refused:${workId}:${at.toISOString()}`),
				),
			);
		expect(notices).toHaveLength(1);
		expect(notices[0].kind).toBe("scheduled_release_refused");
		expect(notices[0].category).toBe("essential");
		expect(notices[0].body).toContain("payout setup");
	});

	it("gives up the schedule on a failed encode, which nothing will finish", async () => {
		const workId = await stage(creator.id, {
			type: "video",
			sourceKey: `creators/${creator.id}/v3`,
		});
		await db.insert(transcodingJobs).values({ workId, mediaType: "video", status: "failed" });
		await makeDue(workId);
		await releaseScheduled();
		const stored = await row(workId);
		expect(stored.visibility).toBe("private");
		expect(stored.scheduledReleaseAt).toBeNull();
	});

	it("does not touch a quarantined Work", async () => {
		const workId = await stage(creator.id);
		const at = await makeDue(workId);
		await db.update(works).set({ quarantineStatus: "quarantined" }).where(eq(works.id, workId));
		await releaseScheduled();
		const stored = await row(workId);
		expect(stored.visibility).toBe("private");
		expect(stored.scheduledReleaseAt?.getTime()).toBe(at.getTime());
	});

	it("is registered to run every minute", () => {
		// The sweep is tested by calling it directly, which never starts pg-boss, so nothing else
		// checks that anything calls it. A dropped registration reads as releases that never come.
		const entry = CRON_SCHEDULES.find(([q]) => q === QUEUES.RELEASE_SCHEDULED);
		expect(entry?.[1]).toBe("* * * * *");
	});
});
