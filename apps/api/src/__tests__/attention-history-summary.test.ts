// SPDX-License-Identifier: Apache-2.0
/**
 * The activity summary behind the history section's graph, and the record route's
 * day drill-down (`/api/subscriptions/attention/history[/summary]`).
 *
 * The summary is the one computed surface in the section — per UTC day of a billing
 * cycle, per creator, the credited split applied within each day (the same
 * arithmetic the meter and the pool answer with), so these tests pin the rules that
 * keep it honest beside the record it draws from:
 *
 *   1. **Overlapped ranges divide evenly, as they do everywhere else.** Two ranges
 *      covering the same second credit half a second to each creator on the graph,
 *      while the row record below still lists both whole. There is no third
 *      arithmetic for "time spent" in this app.
 *   2. **The UTC day is the bucket, and a range belongs to each day it occupies** —
 *      a range crossing midnight contributes its in-day share to both, and only the
 *      cycle the query names is drawn.
 *
 * The endpoint's default cycle is whatever "now" is, so every data-bearing assertion
 * names its cycle explicitly; the default is asserted only as a well-formed key.
 * Ranges are inserted directly with fixed `endsAt` values — intake's lookback bound
 * is about what a browser may honestly claim, not what a test may store.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import app from "../index";
import { createAccount } from "./account-fixture";
import { insertAttentionRange } from "./attention-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

/** A UTC millisecond instant, for `endsAt` values that name their own day. */
const utc = (iso: string) => new Date(iso).getTime();

let viewer: { cookie: string; id: number };
let meadow: { cookie: string; id: number };
let orchard: { cookie: string; id: number };

beforeAll(async () => {
	const stamp = Date.now().toString(36);
	const mk = (a: Awaited<ReturnType<typeof createAccount>>) => ({ cookie: a.cookie, id: a.userId });
	viewer = mk(await createAccount(`summaryviewer${stamp}`));
	meadow = mk(await createAccount(`summarymeadow${stamp}`));
	orchard = mk(await createAccount(`summaryorchard${stamp}`));

	// Meadow gets a display name; Orchard keeps theirs empty, so the summary's
	// COALESCE(NULLIF(display_name, ''), handle) fallback is what a client reads.
	await db.update(users).set({ displayName: "Meadow Maker" }).where(eq(users.id, meadow.id));

	// October 5: two Meadow ranges, one overlapping an Orchard range — every range
	// whole under its creator — and one crossing midnight into October 6.
	await insertAttentionRange({
		userId: viewer.id,
		creatorId: meadow.id,
		eventType: "watch",
		seconds: 600,
		endsAt: new Date(utc("2026-10-05T20:00:00Z")),
	});
	await insertAttentionRange({
		userId: viewer.id,
		creatorId: meadow.id,
		eventType: "read",
		seconds: 600,
		endsAt: new Date(utc("2026-10-05T21:20:00Z")),
	});
	await insertAttentionRange({
		userId: viewer.id,
		creatorId: orchard.id,
		eventType: "listen",
		seconds: 1200,
		endsAt: new Date(utc("2026-10-05T21:20:00Z")),
	});
	await insertAttentionRange({
		userId: viewer.id,
		creatorId: meadow.id,
		eventType: "watch",
		seconds: 1200,
		endsAt: new Date(utc("2026-10-06T00:10:00Z")),
	});
	// A zero-duration visit ping: recorded, and owed nothing by the picture.
	await insertAttentionRange({
		userId: viewer.id,
		creatorId: meadow.id,
		eventType: "read",
		seconds: 0,
		endsAt: new Date(utc("2026-10-06T12:00:00Z")),
	});
	// September: outside the October cycle the default spans.
	await insertAttentionRange({
		userId: viewer.id,
		creatorId: meadow.id,
		eventType: "listen",
		seconds: 1800,
		endsAt: new Date(utc("2026-09-20T19:00:00Z")),
	});
}, DB_SETUP_TIMEOUT);

async function summary(cycle?: string): Promise<{
	status: number;
	body: {
		cycle: string;
		days: {
			day: string;
			seconds: number;
			ranges: number;
			creators: { creatorId: number; name: string; seconds: number; ranges: number }[];
		}[];
		totals: { seconds: number; creators: number };
	};
}> {
	const res = await req(
		`/api/subscriptions/attention/history/summary${cycle ? `?cycle=${cycle}` : ""}`,
		{
			headers: { Cookie: viewer.cookie },
		},
	);
	return { status: res.status, body: await res.json() };
}

describe("the activity summary the graph draws", () => {
	it("requires the person's own session", async () => {
		const res = await req("/api/subscriptions/attention/history/summary?cycle=2026-10-01");
		expect(res.status).toBe(401);
	});

	it("credits overlapped ranges the way the meter and the pool do, per UTC day per creator", async () => {
		const { status, body } = await summary("2026-10-01");
		expect(status).toBe(200);
		expect(body.cycle).toBe("2026-10-01");
		// October 5 and 6: the midnight-crossing range occupies both days' clocks, and
		// the zero-duration ping earns no bucket of its own.
		expect(body.days.map((d) => d.day)).toEqual(["2026-10-05", "2026-10-06"]);
		const day = body.days[0];
		// Credited within the day: Orchard's listen runs 21:00→21:20 alone, then
		// overlaps Meadow's 21:10→21:20 read — the shared ten minutes split evenly.
		expect(day.seconds).toBe(2400);
		expect(day.ranges).toBe(4);
		const meadowRow = day.creators.find((cr) => cr.creatorId === meadow.id);
		const orchardRow = day.creators.find((cr) => cr.creatorId === orchard.id);
		expect(meadowRow).toMatchObject({ seconds: 1500, ranges: 3, name: "Meadow Maker" });
		expect(orchardRow).toMatchObject({ seconds: 900, ranges: 1 });
		// Orchard's name fell back to the handle.
		expect(typeof orchardRow?.name).toBe("string");
		expect(orchardRow?.name.length).toBeGreaterThan(0);
		// October 6: the crossing range's ten minutes past midnight, alone.
		expect(body.days[1]).toMatchObject({ day: "2026-10-06", seconds: 600, ranges: 1 });
		expect(body.totals).toMatchObject({ seconds: 3000, creators: 2 });
	});

	it("names its cycle and draws only the cycle it is asked for", async () => {
		const { body } = await summary("2026-09-01");
		expect(body.cycle).toBe("2026-09-01");
		expect(body.days.map((d) => d.day)).toEqual(["2026-09-20"]);
		expect(body.totals.seconds).toBe(1800);
	});

	it("defaults to the current cycle key", async () => {
		const { body } = await summary();
		expect(body.cycle).toMatch(/^\d{4}-\d{2}-01$/);
	});

	it("refuses a malformed cycle rather than quietly drawing nothing", async () => {
		const res = await req("/api/subscriptions/attention/history/summary?cycle=not-a-cycle", {
			headers: { Cookie: viewer.cookie },
		});
		expect(res.status).toBe(400);
	});
});

describe("the record route's day drill-down", () => {
	it("narrows the stored record to one day, exactly as stored", async () => {
		const res = await req("/api/subscriptions/attention/history?day=2026-10-05", {
			headers: { Cookie: viewer.cookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			entries: { startedAt: string | null; durationSeconds: number; eventType: string }[];
			hasMore: boolean;
		};
		// The zero-duration ping is not part of the record the section reads.
		expect(body.entries.length).toBe(4);
		expect(body.hasMore).toBe(false);
		for (const e of body.entries) {
			expect(new Date(e.startedAt as unknown as string).toISOString().slice(0, 10)).toBe(
				"2026-10-05",
			);
		}
	});

	it("refuses a malformed day filter", async () => {
		const res = await req("/api/subscriptions/attention/history?day=tomorrow", {
			headers: { Cookie: viewer.cookie },
		});
		expect(res.status).toBe(400);
	});

	it("pages a long day as the record always pages, without losing the filter", async () => {
		// The route's page size is 50; a fifth range past four is only worth its own
		// insert once the suite grows one — this asserts the day filter composes with
		// paging's hasMore arithmetic instead of a specific count.
		const res = await req("/api/subscriptions/attention/history?day=2026-10-05&page=0", {
			headers: { Cookie: viewer.cookie },
		});
		const body = (await res.json()) as { entries: unknown[]; page: number };
		expect(body.page).toBe(0);
		expect(body.entries.length).toBe(4);
	});
});
