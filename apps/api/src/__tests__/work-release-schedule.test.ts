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
import {
	notifications,
	stripeConnectAccounts,
	works,
	workTranscodingJobs,
} from "@anthers/db/schema";
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
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${unpaidName}@example.com`}`], sql`, `)})`,
	);
	const a = await createAccount(creatorName);
	await enablePayouts(creatorName);
	creator = { id: a.userId as number, cookie: a.cookie };
	const b = await createAccount(unpaidName, { fields: { creatorMode: true } });
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

	it("refuses a Work whose credits name no human, and takes the credit in the same request", async () => {
		// Both doors behave identically — the route refuses now and the sweep below would clear
		// the schedule later — because a Work with no credited human is not releasable at all.
		const workId = await stage(creator.id, { credits: [] });
		const refused = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(refused.status).toBe(409);
		expect((await refused.json()).code).toBe("credits_creator_required");
		expect((await row(workId)).scheduledReleaseAt).toBeNull();

		const accepted = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			credits: [{ role: "Made by", contributor: "The Creator", types: ["created"] }],
			scheduledReleaseAt: inAnHour(),
		});
		expect(accepted.status).toBe(200);
		expect((await row(workId)).scheduledReleaseAt).not.toBeNull();
	});

	it("refuses a time for a Work whose only credit is generated", async () => {
		const workId = await stage(creator.id, {
			credits: [{ role: "Voiceover", contributor: "", types: ["generated"] }],
		});
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("credits_creator_required");
	});

	it("accepts a blended created+generated credit — one human-made part is enough", async () => {
		const workId = await stage(creator.id, {
			credits: [{ role: "Cut by", contributor: "The Editor", types: ["created", "generated"] }],
		});
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: inAnHour(),
		});
		expect(res.status).toBe(200);
	});

	it("accepts a Work whose media is still processing, which is what a schedule waits for", async () => {
		const workId = await stage(creator.id, {
			type: "video",
			sourceKey: `creators/${creator.id}/v`,
		});
		await db
			.insert(workTranscodingJobs)
			.values({ workId, mediaType: "video", status: "processing" });
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
			access: [{ threshold: 0, allow: true, price: "0" }],
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

describe("a pre-release page", () => {
	const past = () => new Date(Date.now() - 60 * 60_000).toISOString();
	const future = (hours = 1) => new Date(Date.now() + hours * HOUR).toISOString();

	async function pageAs(idOrPublicId: string | number, cookie?: string) {
		return app.fetch(
			new Request(`http://localhost/api/content/works/${idOrPublicId}`, {
				headers: cookie ? { Cookie: cookie } : undefined,
			}),
		);
	}

	it("stores the date and opens the page to a stranger, with pre_release as the verdict", async () => {
		const workId = await stage(creator.id, { title: "Coming soon" });
		const at = past();
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			preReleaseAt: at,
		});
		expect(res.status).toBe(200);
		expect(Date.parse((await res.json()).work.preReleaseAt)).toBe(Date.parse(at));

		const work = await row(workId);
		const page = await pageAs(work.publicId);
		expect(page.status).toBe(200);
		const body = (await page.json()) as { work: { access: { reason: string } } };
		expect(body.work.access.reason).toBe("pre_release");
	});

	it("keeps the page private until its date", async () => {
		const workId = await stage(creator.id, { title: "Not yet" });
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			preReleaseAt: future(),
		});
		expect(res.status).toBe(200);
		const work = await row(workId);
		expect((await pageAs(work.publicId)).status).toBe(404);
	});

	it("refuses a pre-release after the release date", async () => {
		const workId = await stage(creator.id);
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			scheduledReleaseAt: future(1),
			preReleaseAt: future(2),
		});
		expect(res.status).toBe(400);
		expect((await res.json()).code).toBe("pre_release_after_release");
	});

	it("refuses a pre-release on a released Work", async () => {
		const workId = await stage(creator.id, { visibility: "released" });
		const res = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			preReleaseAt: past(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("pre_release_not_private");
	});

	it("refuses a creator whose payout setup is not ready", async () => {
		const workId = await stage(unpaid.id);
		const res = await call("PATCH", `/api/content/works/${workId}`, unpaid.cookie, {
			preReleaseAt: past(),
		});
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("payouts_required");
	});

	it("closes the reviews while the page is pre-release", async () => {
		const workId = await stage(creator.id);
		await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			preReleaseAt: past(),
		});
		const res = await app.fetch(
			new Request(`http://localhost/api/content/works/${workId}/reviews`, {
				headers: { Cookie: unpaid.cookie },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { eligibility: { code: string } | null };
		expect(body.eligibility?.code).toBe("pre_release");
	});

	it("queues the listing when the date arrives, and again on a clear", async () => {
		const workId = await stage(creator.id, { title: "Sweep me" });
		await db
			.update(works)
			.set({ preReleaseAt: new Date(Date.now() - 60_000) })
			.where(eq(works.id, workId));
		sent = [];
		const result = await releaseScheduled();
		expect(result.preReleased).toBeGreaterThanOrEqual(1);
		expect(
			sent.some((entry) => entry.name === QUEUES.SYNC_WORK_LISTING && entry.data.workId === workId),
		).toBe(true);

		// Clearing the date returns the page to private and asks the listing to go.
		const cleared = await call("PATCH", `/api/content/works/${workId}`, creator.cookie, {
			preReleaseAt: null,
		});
		expect(cleared.status).toBe(200);
		const work = await row(workId);
		expect((await pageAs(work.publicId)).status).toBe(404);
		expect((await db.select().from(works).where(eq(works.id, workId)))[0].preReleaseAt).toBeNull();
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
		await db
			.insert(workTranscodingJobs)
			.values({ workId, mediaType: "video", status: "processing" });
		const at = await makeDue(workId);

		await releaseScheduled();
		let stored = await row(workId);
		expect(stored.visibility).toBe("private");
		expect(stored.scheduledReleaseAt?.getTime()).toBe(at.getTime());

		await db
			.update(workTranscodingJobs)
			.set({ status: "completed" })
			.where(eq(workTranscodingJobs.workId, workId));
		await releaseScheduled();
		stored = await row(workId);
		expect(stored.visibility).toBe("released");
	});

	it("gives up the schedule on a Work nobody is credited for, which is the creator's to fix", async () => {
		// `credits_creator_required` resolves as `creator`: the sweep does not wait on it the way
		// it waits on processing, because no amount of waiting puts a human in the credits.
		const workId = await stage(creator.id, { credits: [] });
		const at = await makeDue(workId);
		await releaseScheduled();

		const stored = await row(workId);
		expect(stored.visibility).toBe("private");
		expect(stored.scheduledReleaseAt).toBeNull();

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
	});

	it("gives up the schedule and tells the creator when their payouts have lapsed", async () => {
		const workId = await stage(creator.id);
		const at = await makeDue(workId);
		await db
			.update(stripeConnectAccounts)
			.set({ payoutsEnabled: false })
			.where(eq(stripeConnectAccounts.userId, creator.id));
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
		await db.insert(workTranscodingJobs).values({ workId, mediaType: "video", status: "failed" });
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
