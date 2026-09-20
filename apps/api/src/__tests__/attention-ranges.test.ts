// SPDX-License-Identifier: Apache-2.0
/**
 * Range intake on POST /api/subscriptions/attention.
 *
 * Attention seconds are the allocation function for Time Pool money, and every
 * range arriving at this endpoint is client-supplied. Rather than bounding a
 * rolling window of durations (the old clamp), the server stores each range's
 * real start and end and enforces the equal-time principle on READ, by splitting
 * overlapping ranges (`splitOverlappingRanges`). What intake owes the read side:
 *
 *   1. A range must carry its window — start, end, and a stable clientId.
 *   2. Nothing ends in the future; nothing starts earlier than a flush could
 *      honestly have covered (RANGE_LOOKBACK_SECONDS).
 *   3. A retried flush is one range, never two — (user_id, client_id) is unique.
 *   4. The zero-duration visit ping still passes through unchanged.
 *
 * These drive the real endpoint rather than the pure split (covered in
 * packages/shared/src/attention.test.ts), so the DB write path is exercised.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionEvents } from "@anthers/db/schema";
import { MAX_RANGE_SECONDS, RANGE_LOOKBACK_SECONDS } from "@anthers/shared/attention";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const account = await createAccount(username);
	return { cookie: account.cookie, id: account.userId };
}

interface EventSpec {
	creatorId: number;
	eventType: string;
	durationSeconds: number;
	startedAt?: number;
	endedAt?: number;
	clientId?: string;
	surface?: string;
	device?: string;
	playing?: boolean;
}

/** A well-formed range ending one second ago, for the given duration. */
function rangeEvent(
	durationSeconds: number,
	over: Partial<EventSpec> = {},
): EventSpec & { creatorId: number; workId: number } {
	const now = Date.now();
	return {
		creatorId: creator.id,
		workId: earningWorkId,
		eventType: "watch",
		durationSeconds,
		startedAt: now - durationSeconds * 1_000 - 1_000,
		endedAt: now - 1_000,
		clientId: `rng-${Math.random().toString(36).slice(2)}`,
		...over,
	};
}

function postAttention(cookie: string, events: object[]) {
	return req("/api/subscriptions/attention", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify({ events }),
	});
}

/** Seconds stored on a user's rows, as reported (the ground-truth duration column). */
async function reportedSeconds(userId: number): Promise<number> {
	const [row] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(eq(attentionEvents.userId, userId));
	return row?.total ?? 0;
}

let viewer: { cookie: string; id: number };
let creator: { cookie: string; id: number };
let earningWorkId: number;

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	viewer = await signUp(`rangeviewer${stamp}`);
	creator = await signUp(`rangecreator${stamp}`);

	// Inserted rather than created through the API: a video Work queues a transcode,
	// and pg-boss isn't running in the test process.
	earningWorkId = (
		await insertWork({
			creatorId: creator.id,
			type: "video",
			title: "Range Fixture",
			seedAccess: [{ threshold: 0, allow: true, price: "0" }],
		})
	).id;
}, DB_SETUP_TIMEOUT);

describe("attention range intake", () => {
	it("records an ordinary range in full, with its window and evidence", async () => {
		const ev = rangeEvent(30, { surface: "work", device: "desktop", playing: true });
		const res = await postAttention(viewer.cookie, [ev]);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.recorded).toBe(1);

		const [row] = await db
			.select()
			.from(attentionEvents)
			.where(eq(attentionEvents.clientId, ev.clientId as string));
		expect(row.startedAt?.getTime()).toBe(ev.startedAt);
		expect(row.endedAt?.getTime()).toBe(ev.endedAt);
		expect(row.durationSeconds).toBe(30);
		expect(row.surface).toBe("work");
		expect(row.device).toBe("desktop");
		expect(row.playing).toBe(true);
	});

	it("a retried flush is one range, never two — (user_id, client_id) is unique", async () => {
		const ev = rangeEvent(45);
		await postAttention(viewer.cookie, [ev]);
		const before = await reportedSeconds(viewer.id);
		// A network drop re-delivers the identical batch; it must not double-count.
		const res = await postAttention(viewer.cookie, [ev]);
		expect(res.status).toBe(200);
		expect(await reportedSeconds(viewer.id)).toBe(before);
	});

	it("drops a range ending in the future", async () => {
		const now = Date.now();
		const ev = rangeEvent(30, { startedAt: now, endedAt: now + 60_000 });
		const res = await postAttention(viewer.cookie, [ev]);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.malformed).toBe(1);
		const [row] = await db
			.select()
			.from(attentionEvents)
			.where(eq(attentionEvents.clientId, ev.clientId as string));
		expect(row).toBeUndefined();
	});

	it("drops a range starting earlier than a flush could have covered", async () => {
		const now = Date.now();
		const old = RANGE_LOOKBACK_SECONDS + 120;
		const ev = rangeEvent(60, {
			startedAt: Math.floor(now - old * 1_000),
			endedAt: Math.floor(now - old * 1_000 + 60_000),
		});
		const res = await postAttention(viewer.cookie, [ev]);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.malformed).toBe(1);
		const [row] = await db
			.select()
			.from(attentionEvents)
			.where(eq(attentionEvents.clientId, ev.clientId as string));
		expect(row).toBeUndefined();
	});

	it("drops a range with no clientId — a timed claim has to be dedupable", async () => {
		const ev = rangeEvent(30);
		const { clientId: _omit, ...noId } = ev;
		const res = await postAttention(viewer.cookie, [noId]);
		expect(res.status).toBe(200);
		expect((await res.json()).malformed).toBe(1);
	});

	it("drops a range whose window is inverted or empty", async () => {
		const now = Date.now();
		const backwards = rangeEvent(30, { startedAt: now - 1_000, endedAt: now - 31_000 });
		const res = await postAttention(viewer.cookie, [backwards]);
		expect(res.status).toBe(200);
		expect((await res.json()).malformed).toBe(1);
	});

	it("still records a zero-duration visit ping, which claims no window", async () => {
		const before = await reportedSeconds(viewer.id);
		const res = await postAttention(viewer.cookie, [
			{ creatorId: creator.id, eventType: "page_view", durationSeconds: 0 },
		]);
		expect(res.status).toBe(200);
		expect((await res.json()).recorded).toBe(1);
		expect(await reportedSeconds(viewer.id)).toBe(before);
	});

	it("a range longer than the bound is refused by validation, not written", async () => {
		// MAX_RANGE_SECONDS is the intake cap; the schema validator enforces it.
		const ev = rangeEvent(MAX_RANGE_SECONDS + 1, {
			startedAt: Date.now() - (MAX_RANGE_SECONDS + 1) * 1_000 - 1_000,
		});
		const res = await postAttention(viewer.cookie, [ev]);
		expect(res.status).toBe(400);
	});

	it("bounds each user independently", async () => {
		const fresh = await signUp(`rangeother${Date.now().toString(36)}`);
		const res = await postAttention(fresh.cookie, [rangeEvent(45)]);
		expect(res.status).toBe(200);
		expect((await res.json()).recorded).toBe(1);
		expect(await reportedSeconds(fresh.id)).toBe(45);
	});

	it("two tabs claiming the SAME half hour charge the meter one half hour — equal-time, end to end", async () => {
		// The case the whole change exists for: a video in one tab and an article in
		// another, honestly reported, must not charge the account sixty minutes for
		// thirty. Each tab sends its own ranges — overlapping exactly — and the meter,
		// splitting on read, must see half of what was reported.
		const { cookie, id } = await signUp(`rangetwo${Date.now().toString(36)}`);
		const now = Date.now();
		// A range may run at most MAX_RANGE_SECONDS and must start inside the flush
		// lookback — so each tab's honest half hour arrives as three 500s consecutive
		// chunks, the shape a real client's periodic flushes produce.
		const ranges = (name: string) =>
			[0, 1, 2].map((chunk) => ({
				creatorId: creator.id,
				workId: earningWorkId,
				eventType: "watch",
				durationSeconds: 500,
				startedAt: now - (chunk + 1) * 500_000 - 1_000,
				endedAt: now - chunk * 500_000 - 1_000,
				clientId: `${name}-${chunk}`,
			}));
		const res = await postAttention(cookie, [...ranges("tab-a"), ...ranges("tab-b")]);
		expect(res.status).toBe(200);
		const posted = await res.json();
		expect(posted.malformed).toBe(0);
		expect(posted.recorded).toBe(6);

		// Stored ground truth: both twenty-five-minute totals are there, unsplit.
		expect(await reportedSeconds(id)).toBe(3000);
		// Read out through the meter's split: twenty-five minutes, not fifty.
		const budget = await (
			await req("/api/subscriptions/public-access", { headers: { Cookie: cookie } })
		).json();
		expect(budget.usedSeconds).toBe(1500);
	});

	it("requires authentication", async () => {
		const res = await req("/api/subscriptions/attention", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ events: [rangeEvent(30)] }),
		});
		expect(res.status).toBe(401);
	});
});
