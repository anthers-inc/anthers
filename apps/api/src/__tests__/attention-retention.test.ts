// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Attention retention — 51.05's promise that a complete history of what someone
 * personally watched **stops existing**.
 *
 * The policy sentence has two halves and they pull against each other, which is why
 * both are asserted here rather than just the deletion:
 *
 * - the per-person rows go, so nobody can reconstruct who watched what;
 * - the creator's earnings history and analytics **survive**, aggregated per Work and
 *   per day, because a retention job that quietly blanks a creator's back catalogue
 *   is a bug wearing a privacy feature's clothes.
 *
 * The failure this file is really guarding against is the second one. Deletion is
 * easy to write and easy to see working; the analytics regression is invisible until
 * a creator opens a year-long chart and finds it empty from six months back, which is
 * exactly the kind of thing nobody notices pre-launch and everybody notices after.
 *
 * `attention_daily` having **no `user_id` column** is asserted directly against
 * `information_schema`, not inferred from what the queries return. A column that
 * exists and isn't selected today is a column somebody selects tomorrow — and the
 * policy's claim is that the data is gone, not that it is unqueried.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { attentionDaily, attentionEvents, users } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import app from "../index";
import { pruneAttention } from "../jobs/prune-attention.js";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function post(path: string, cookie: string, body: unknown) {
	return req(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(body),
	});
}

async function signUp(username: string): Promise<string> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `aret_creator_${id}`;
const viewerAName = `aret_a_${id}`;
const viewerBName = `aret_b_${id}`;

let creator: string;
let creatorId: number;
let viewerAId: number;
let viewerBId: number;
let workId: number;

/**
 * Both days have to sit in a narrow band: **older than the 30-day retention window
 * these tests prune with**, so they get rolled up, but **inside the 365-day analytics
 * period**, so the union assertions can see them. Fixed calendar dates fail the second
 * condition the moment they age out — the first draft used 2024 dates and the
 * analytics tests read zero for a reason that had nothing to do with the code.
 */
function daysAgo(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const OLD_DAY = daysAgo(100);
/** Two events on this one, so a daily rollup has something to collapse. */
const OLDER_DAY = daysAgo(120);

async function idOf(username: string): Promise<number> {
	const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	return row.id;
}

/** Insert a raw attention row directly, back-dated — the endpoint always stamps now(). */
async function seedEvent(
	userId: number,
	day: string,
	eventType: string,
	durationSeconds: number,
	work: number | null = workId,
) {
	await db.execute(sql`
		INSERT INTO attention_events (user_id, creator_id, work_id, event_type, duration_seconds, created_at)
		VALUES (${userId}, ${creatorId}, ${work}, ${eventType}, ${durationSeconds}, ${`${day}T12:00:00Z`})
	`);
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerAName}, ${viewerBName})`,
	);
	creator = await signUp(creatorName);
	await signUp(viewerAName);
	await signUp(viewerBName);
	await db.execute(sql`UPDATE users SET is_creator = true WHERE username = ${creatorName}`);

	creatorId = await idOf(creatorName);
	viewerAId = await idOf(viewerAName);
	viewerBId = await idOf(viewerBName);

	const workRes = await post("/api/content/works", creator, {
		type: "video",
		title: `Retention fixture ${id}`,
	});
	expect(workRes.status).toBe(201);
	workId = (await workRes.json()).work.id;

	// Two viewers on one day, one viewer twice on another, plus a null-Work visit ping —
	// which is the row the COALESCE key exists for.
	await seedEvent(viewerAId, OLD_DAY, "watch", 120);
	await seedEvent(viewerBId, OLD_DAY, "watch", 45);
	await seedEvent(viewerAId, OLDER_DAY, "watch", 30);
	await seedEvent(viewerAId, OLDER_DAY, "watch", 10);
	await seedEvent(viewerAId, OLD_DAY, "page_view", 0, null);
}, DB_SETUP_TIMEOUT);

describe("the rollup table cannot hold an identity", () => {
	it("has no user_id column at all — asserted against the catalog, not inferred", async () => {
		const rows = await db.execute(sql`
			SELECT column_name FROM information_schema.columns
			WHERE table_name = 'attention_daily'
		`);
		const columns = (rows as unknown as { column_name: string }[]).map((r) => r.column_name);

		expect(columns).toContain("creator_id");
		expect(columns).toContain("total_seconds");
		// The whole point. Not "we don't select it" — it isn't there to select.
		expect(columns).not.toContain("user_id");
		expect(columns.filter((c) => /user|viewer|subscriber/.test(c))).toEqual(["unique_viewers"]);
	});
});

describe("pruning drops the people and keeps the totals", () => {
	it("aggregates per (Work, day, event type) and deletes the raw rows", async () => {
		const before = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(attentionEvents)
			.where(eq(attentionEvents.creatorId, creatorId));
		expect(Number(before[0].n)).toBe(5);

		const result = await pruneAttention({ retentionDays: 30 });
		expect(result.rowsDeleted).toBeGreaterThanOrEqual(5);

		// Every raw row for this creator is gone.
		const after = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(attentionEvents)
			.where(eq(attentionEvents.creatorId, creatorId));
		expect(Number(after[0].n)).toBe(0);

		// And with them, any way to ask what a particular person watched.
		const perPerson = await db.execute(sql`
			SELECT count(*)::int AS n FROM attention_events WHERE user_id IN (${viewerAId}, ${viewerBId})
		`);
		expect(Number((perPerson as unknown as { n: number }[])[0].n)).toBe(0);

		// The creator's history survives, at the granularity the policy promises.
		const daily = await db
			.select()
			.from(attentionDaily)
			.where(eq(attentionDaily.creatorId, creatorId));

		const watchOld = daily.find((d) => d.day === OLD_DAY && d.eventType === "watch");
		expect(watchOld).toBeDefined();
		expect(watchOld!.totalSeconds).toBe(165); // 120 + 45
		expect(watchOld!.eventCount).toBe(2);
		expect(watchOld!.uniqueViewers).toBe(2);

		// Same viewer twice in a day is two events but ONE unique viewer — the figure
		// would be meaningless if it just counted rows.
		const watchOlder = daily.find((d) => d.day === OLDER_DAY && d.eventType === "watch");
		expect(watchOlder!.totalSeconds).toBe(40);
		expect(watchOlder!.eventCount).toBe(2);
		expect(watchOlder!.uniqueViewers).toBe(1);

		// The null-Work visit ping rolled up too, rather than being dropped or crashing
		// the ON CONFLICT — this is the row the COALESCE(work_id, -1) key is for.
		const ping = daily.find((d) => d.eventType === "page_view");
		expect(ping).toBeDefined();
		expect(ping!.workId).toBeNull();
	});

	it("is idempotent — a second run neither doubles the totals nor errors", async () => {
		// The realistic path is a crash between aggregate and delete, which the
		// per-day transaction rolls back. This asserts the weaker-but-cheaper property
		// that matters if that ever stops holding: re-running writes `excluded` rather
		// than adding, so totals are re-derived instead of accumulated.
		await seedEvent(viewerBId, OLD_DAY, "watch", 45);
		await pruneAttention({ retentionDays: 30 });

		const rows = await db
			.select()
			.from(attentionDaily)
			.where(and(eq(attentionDaily.creatorId, creatorId), eq(attentionDaily.eventType, "watch")));
		// Still one row per day, not two.
		expect(rows.filter((r) => r.day === OLD_DAY).length).toBe(1);
		// And the total is what the re-derivation found, not 165 + 45 piled on top.
		expect(rows.find((r) => r.day === OLD_DAY)!.totalSeconds).toBe(45);
	});

	it("leaves rows inside the retention window completely alone", async () => {
		// A recent event — the ordinary case, and the one that must never be touched:
		// distribute-pool has not paid it out yet.
		await db.execute(sql`
			INSERT INTO attention_events (user_id, creator_id, work_id, event_type, duration_seconds)
			VALUES (${viewerAId}, ${creatorId}, ${workId}, 'watch', 90)
		`);

		const result = await pruneAttention({ retentionDays: 30 });
		expect(result.rowsDeleted).toBe(0);

		const remaining = await db
			.select({ n: sql<number>`count(*)::int` })
			.from(attentionEvents)
			.where(eq(attentionEvents.creatorId, creatorId));
		expect(Number(remaining[0].n)).toBe(1);
	});
});

describe("analytics survive the prune", () => {
	it("still reports the creator's older history rather than silently reading zero", async () => {
		// The regression this file exists for. Analytics read raw events; once pruning
		// starts, anything reading ONLY the raw table returns zero for the older part of
		// a long window — no error, no log, just a history that stops.
		const res = await req("/api/integrations/analytics/overview?period=365", {
			headers: { Cookie: creator },
		});
		expect(res.status).toBe(200);
		const overview = await res.json();

		// 45 (the re-derived old day) + 40 (the older day) + 90 (the live row) = 175s,
		// spanning both the rolled-up and the raw side of the boundary.
		expect(overview.totalDurationHours).toBeCloseTo(175 / 3600, 2);
		expect(overview.events.watches).toBe(4);
		// The page_view ping is in the rollup too.
		expect(overview.events.views).toBe(1);
	});

	it("reports uniqueViewers over the raw window only, and says so", async () => {
		const overview = await (
			await req("/api/integrations/analytics/overview?period=365", { headers: { Cookie: creator } })
		).json();

		// Only the one live row's viewer. Adding the rollup's daily distinct counts would
		// give a bigger number that double-counts anyone who came back on another day —
		// and with the identities gone there is nothing left to deduplicate against. The
		// window is named rather than the overstatement being made quietly.
		expect(overview.uniqueViewers).toBe(1);
		expect(overview.uniqueViewersWindowDays).toBeGreaterThan(0);
	});

	it("merges a Work that straddles the boundary instead of listing it twice", async () => {
		const content = await (
			await req("/api/integrations/analytics/content?period=365", { headers: { Cookie: creator } })
		).json();

		const rows = (content.content as { id: number; totalDuration: number }[]).filter(
			(r) => r.id === workId,
		);
		// One entry, not one per source table.
		expect(rows.length).toBe(1);
		expect(rows[0].totalDuration).toBe(175);
	});

	it("merges the timeseries by date across both sources", async () => {
		const series = await (
			await req("/api/integrations/analytics/timeseries?period=365", {
				headers: { Cookie: creator },
			})
		).json();

		const days = (series.timeseries as { date: string }[]).map((r) => r.date);
		// No duplicate dates, and the rolled-up days are present.
		expect(new Set(days).size).toBe(days.length);
		expect(days).toContain(OLD_DAY);
		expect(days).toContain(OLDER_DAY);
	});
});
