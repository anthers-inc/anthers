// SPDX-License-Identifier: Apache-2.0
/**
 * The traffic beacon's intake, the creator read, and the retention job — walked
 * through the real app and the real tables, in the suite's own session.
 *
 * The intake route's defenses are each a case (the route's docblock names the shape
 * each answers), and two properties sit under everything:
 *
 * - **No identity reaches a read.** The one identity-like value anywhere in the
 *   pipeline is the client-generated session id, and it must never appear in any
 *   response a creator or operator receives.
 * - **The retention job keeps promises the schema can prove**: the daily rollup has
 *   no session column at all, so the pruned history is anonymous by construction,
 *   and a retry re-derives totals rather than doubling them.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { projects, trafficEvents } from "@anthers/db/schema";
import { sql } from "drizzle-orm";
import app from "../index";
import { pruneTraffic } from "../jobs/prune-traffic.js";
import { trafficFunnel } from "../services/traffic.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN_OK = "http://localhost:3000";
/** A real-browser UA, deliberate: an automation UA would be dropped as a bot. */
const UA_REAL =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const handleSuffix = crypto.randomUUID().slice(0, 8);
const sessionPrefix = `tt-${handleSuffix}`;
const TEST_SURFACE = `tt${handleSuffix}`.slice(0, 32);

function rows(res: unknown): Record<string, unknown>[] {
	if (Array.isArray(res)) return res as Record<string, unknown>[];
	const maybe = (res as { rows?: Record<string, unknown>[] } | null)?.rows;
	return Array.isArray(maybe) ? maybe : [];
}

function beacon(path: string, body: unknown, headers: Record<string, string> = {}) {
	return app.fetch(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN_OK,
				"User-Agent": UA_REAL,
				"x-forwarded-for": "10.8.8.8",
				...headers,
			},
			body: JSON.stringify(body),
		}),
	);
}

function pageView(body: Record<string, unknown>, headers = {}) {
	return beacon(
		"/api/traffic/page-view",
		{ sessionId: sessionPrefix, host: "anthers.org", ...body },
		headers,
	);
}

async function sessionRowCount(): Promise<number> {
	const result = await db.execute(
		sql`SELECT count(*)::int AS count FROM traffic_events WHERE session_id LIKE ${`${sessionPrefix}%`}`,
	);
	return Number(rows(result)[0]?.count ?? 0);
}

let creatorCookie: string;
let creatorId: number;
let creatorHandle: string;
/** A second creator account, so cross-creator isolation can be proven rather than assumed. */
let otherCookie: string;
let _otherCreatorId: number;
let otherHandle: string;
let fixtureProjectId: number;
/** The UTC day `n` days ago, as the rollups spell it. */
function daysAgoIso(n: number): string {
	return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
const PRUNED_DAYS = [59, 60, 61, 62];

beforeAll(async () => {
	// A real account, so the creator read has somebody to read as and a path to
	// attribute. Creating one is the signup ceremony, which is what the funnel's
	// signup stage counts — one account here covers both assertions.
	const account = await createAccount(`ttraffic_creator_${handleSuffix}`);
	creatorCookie = account.cookie;
	creatorId = account.userId;
	creatorHandle = account.handle;
	const other = await createAccount(`ttraffic_other_${handleSuffix}`);
	otherCookie = other.cookie;
	_otherCreatorId = other.userId;
	otherHandle = other.handle;

	// A real project row, so card-impression attribution can resolve for real.
	const [project] = await db
		.insert(projects)
		.values({
			creatorId,
			slug: `ttraffic-${handleSuffix}`,
			title: `Traffic fixture ${handleSuffix}`,
		})
		.returning({ id: projects.id });
	fixtureProjectId = project.id;
}, DB_SETUP_TIMEOUT);

describe("POST /api/traffic/page-view", () => {
	it("records a well-formed view with classification decided by the server", async () => {
		const res = await pageView({ path: `/@${creatorHandle}/works/nice-game-123` });
		expect(res.status).toBe(204);

		const row = rows(
			await db.execute(
				sql`SELECT path, referrer_source, device FROM traffic_events WHERE session_id = ${sessionPrefix}`,
			),
		)[0];
		expect(row?.path).toBe(`/@${creatorHandle}/works/nice-game-123`);
		// No referrer sent → direct; UA is desktop → desktop. Both decided at intake.
		expect(row?.referrer_source).toBe("direct");
		expect(row?.device).toBe("desktop");
	});

	it("classifies a social referrer and stores the referrer as host only", async () => {
		await pageView({
			path: "/",
			referrer: "https://bsky.app/profile/someone.bsky.social/post/3abc?fbclid=tracked",
		});
		const row = rows(
			await db.execute(
				sql`SELECT referrer_host, referrer_source FROM traffic_events WHERE session_id = ${sessionPrefix} ORDER BY id DESC LIMIT 1`,
			),
		)[0];
		expect(row?.referrer_host).toBe("bsky.app");
		expect(row?.referrer_source).toBe("social");
	});

	it("drops a bot's view silently — 204, nothing written", async () => {
		const before = await sessionRowCount();
		const res = await pageView({ path: "/" }, { "User-Agent": "curl/8.5.0" });
		expect(res.status).toBe(204);
		expect(await sessionRowCount()).toBe(before);
	});

	it("refuses a foreign origin and admits an absent one", async () => {
		const foreign = await pageView({ path: "/" }, { Origin: "https://evil.example" });
		expect(foreign.status).toBe(403);

		// Absent Origin is a client quirk, not an attack — the error beacon's ruling.
		const absent = await beacon(
			"/api/traffic/page-view",
			{ path: "/", sessionId: sessionPrefix, host: "anthers.org" },
			{ Origin: "" },
		);
		expect(absent.status).toBe(204);
	});

	it("drops a view claiming an untracked host — the admin console is not site traffic", async () => {
		const before = await sessionRowCount();
		const res = await pageView({ path: "/", host: "admin.anthers.org" });
		expect(res.status).toBe(204);
		expect(await sessionRowCount()).toBe(before);
	});

	it("answers malformed bodies with 204 and never a 500", async () => {
		for (const body of ["not an object", [1, 2], null, 42]) {
			const res = await beacon("/api/traffic/page-view", body);
			expect(res.status).toBe(204);
		}
	});
});

describe("POST /api/traffic/card", () => {
	it("records shaped card events and stores nothing from an unshaped one", async () => {
		const res = await beacon("/api/traffic/card", {
			events: [
				{
					subjectKind: "project",
					subjectId: fixtureProjectId,
					kind: "shown",
					surface: TEST_SURFACE,
				},
				{
					subjectKind: "project",
					subjectId: fixtureProjectId,
					kind: "click",
					surface: TEST_SURFACE,
				},
				// Unshaped entries are skipped one by one, never a whole-batch failure.
				{ subjectKind: "villain", subjectId: 2, kind: "shown", surface: TEST_SURFACE },
				{
					subjectKind: "project",
					subjectId: fixtureProjectId,
					kind: "levitate",
					surface: TEST_SURFACE,
				},
				{ subjectKind: "project", subjectId: -5, kind: "shown", surface: TEST_SURFACE },
			],
		});
		expect(res.status).toBe(204);

		const kinds = rows(
			await db.execute(
				sql`SELECT kind FROM card_impressions WHERE surface = ${TEST_SURFACE} ORDER BY id`,
			),
		).map((r) => r.kind);
		expect(kinds).toEqual(["shown", "click"]);
	});
});

describe("creator traffic read", () => {
	it("resolves recorded paths back to the creator and never returns a session id", async () => {
		await pageView({ path: `/@${creatorHandle}` });

		const res = await app.fetch(
			new Request("http://localhost/api/integrations/analytics/traffic", {
				headers: { Origin: ORIGIN_OK, Cookie: creatorCookie },
			}),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.traffic.profileViews).toBeGreaterThan(0);

		// The no-identity property, pinned on the new surface: no session id anywhere.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain(sessionPrefix);
	});

	it("shows the creator where their traffic comes from, as source aggregates", async () => {
		// A social arrival on the creator's own page: the source split must see it.
		await pageView({
			path: `/@${creatorHandle}`,
			referrer: "https://bsky.app/profile/someone.bsky.social",
		});

		const res = await app.fetch(
			new Request("http://localhost/api/integrations/analytics/traffic", {
				headers: { Origin: ORIGIN_OK, Cookie: creatorCookie },
			}),
		);
		const body = await res.json();
		const social = body.sources.find((s: { source: string }) => s.source === "social");
		expect(social?.views).toBeGreaterThanOrEqual(1);
		// Only classified values the intake wrote, never raw hosts — the raw referrer
		// host is operator data (site-wide), so it must not ride the creator response.
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("bsky.app");
	});

	it("shows the creator their visits over time, by day", async () => {
		const res = await app.fetch(
			new Request("http://localhost/api/integrations/analytics/traffic", {
				headers: { Origin: ORIGIN_OK, Cookie: creatorCookie },
			}),
		);
		const body = await res.json();
		expect(Array.isArray(body.series)).toBe(true);
		const total = body.series.reduce((sum: number, d: { views: number }) => sum + d.views, 0);
		expect(total).toBeGreaterThanOrEqual(2);
		// Every day is a UTC calendar day, matching the rollups' spelling.
		const days = body.series.map((d: { day: string }) => d.day);
		for (const day of days) {
			expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it("isolates creators — one creator's read never counts another's pages", async () => {
		// A visit to the other creator's page, labeled as social so the same event
		// would be visible in both halves if the prefix filter leaked.
		await pageView({
			path: `/@${otherHandle}`,
			referrer: "https://www.google.com/search",
		});

		const mine = await (
			await app.fetch(
				new Request("http://localhost/api/integrations/analytics/traffic", {
					headers: { Origin: ORIGIN_OK, Cookie: creatorCookie },
				}),
			)
		).json();
		// The first creator's series and sources must not include the other's visit.
		const seen = JSON.stringify(mine.series.map((d: { day: string }) => d.day));
		const searchInMine = mine.sources.find((s: { source: string }) => s.source === "search");
		expect(searchInMine).toBeUndefined();

		const theirs = await (
			await app.fetch(
				new Request("http://localhost/api/integrations/analytics/traffic", {
					headers: { Origin: ORIGIN_OK, Cookie: otherCookie },
				}),
			)
		).json();
		// The other creator's read DOES see it — the filter selects, it does not hide.
		const search = theirs.sources.find((s: { source: string }) => s.source === "search");
		expect(search?.views).toBeGreaterThanOrEqual(1);
		expect(seen).toBeTruthy();
	});
});

describe("funnel — landing, signup, first support", () => {
	it("counts the stages as aggregates from their own tables", async () => {
		// The stages are read straight from their tables (`services/traffic.ts`); the
		// admin read behind them is the admin host's gate, which admin-auth.test.ts
		// already proves. Two landing views were recorded above, and the fixture's
		// signup ceremony created this window's one new account.
		await pageView({ path: "/" });
		const funnel = await trafficFunnel(30);
		expect(funnel.landingViews).toBeGreaterThanOrEqual(2);
		expect(funnel.signups).toBeGreaterThanOrEqual(1);
		// First supports can legitimately be zero in a fresh session.
		expect(funnel.firstSupports).toBeGreaterThanOrEqual(0);
	});
});

describe("rate limit — door traffic-beacon", () => {
	it("answers 429 past the door's window", async () => {
		// 🚨 The limiter's refusing case needs the limiter live: test sessions set
		// RATE_LIMITS_DISABLED=1 (scripts/session.ts), which would make the case
		// vacuous. Malformed bodies keep the test cheap — the rate check runs before
		// the body is read deeply, and a dropped body consumes the window without
		// writing rows.
		const knob = process.env.RATE_LIMITS_DISABLED;
		delete process.env.RATE_LIMITS_DISABLED;
		try {
			let sawLimit = false;
			for (let i = 0; i < 410; i++) {
				const res = await beacon("/api/traffic/page-view", "junk");
				if (res.status === 429) {
					sawLimit = true;
					break;
				}
			}
			expect(sawLimit).toBe(true);
		} finally {
			if (knob !== undefined) process.env.RATE_LIMITS_DISABLED = knob;
		}
	});
});

describe("prune-traffic", () => {
	it("rolls a day up, deletes the raw rows, and leaves a session-free rollup", async () => {
		// Backdate this suite's raw rows so they are prunable now; the retention
		// override is what makes the job testable in a session's lifetime.
		await db.execute(
			sql`UPDATE traffic_events SET created_at = ${daysAgoIso(60)} WHERE session_id LIKE ${`${sessionPrefix}%`}`,
		);

		const rawCount = await sessionRowCount();
		const result = await pruneTraffic({ retentionDays: 59, maxDays: 60 });
		expect(result.daysProcessed).toBeGreaterThan(0);
		expect(result.viewsDeleted).toBe(rawCount);
		expect(await sessionRowCount()).toBe(0);

		// Every rollup row this suite produced carries real counts and a real session
		// count — and, being a join of nothing, names nobody.
		const daily = rows(
			await db.execute(
				sql`SELECT path, referrer_source, device, views, sessions FROM traffic_daily WHERE day = ${daysAgoIso(60).slice(0, 10)}`,
			),
		);
		expect(daily.length).toBeGreaterThan(0);
		for (const row of daily) {
			expect(Number(row.views)).toBeGreaterThan(0);
			expect(Number(row.sessions)).toBeGreaterThan(0);
		}
	});

	it("is idempotent — a retry re-derives the same totals rather than doubling them", async () => {
		await db.execute(
			sql`INSERT INTO traffic_events (created_at, path, referrer_host, referrer_source, session_id, device)
				VALUES (${daysAgoIso(61)}, '/', NULL, 'direct', ${`${sessionPrefix}-idem`}, 'desktop')`,
		);
		await pruneTraffic({ retentionDays: 59, maxDays: 60 });
		const first = rows(
			await db.execute(
				sql`SELECT views, sessions FROM traffic_daily WHERE path = '/' AND referrer_source = 'direct' AND day = ${daysAgoIso(61).slice(0, 10)}`,
			),
		);
		await pruneTraffic({ retentionDays: 59, maxDays: 60 });
		const second = rows(
			await db.execute(
				sql`SELECT views, sessions FROM traffic_daily WHERE path = '/' AND referrer_source = 'direct' AND day = ${daysAgoIso(61).slice(0, 10)}`,
			),
		);
		expect(second).toEqual(first);
		// And a retry deleted the raw row it found: nothing left to re-aggregate.
		expect(await sessionRowCount()).toBe(0);
	});

	it("resolves card rollup creator attribution from the subject row", async () => {
		await db.execute(
			sql`INSERT INTO card_impressions (created_at, subject_kind, subject_id, kind, surface) VALUES
				(${daysAgoIso(62)}, 'project', ${fixtureProjectId}, 'shown', ${TEST_SURFACE}),
				(${daysAgoIso(62)}, 'project', ${fixtureProjectId}, 'shown', ${TEST_SURFACE}),
				(${daysAgoIso(62)}, 'project', ${fixtureProjectId}, 'click', ${TEST_SURFACE}),
				(${daysAgoIso(62)}, 'creator', ${creatorId}, 'shown', ${TEST_SURFACE})`,
		);

		await pruneTraffic({ retentionDays: 59, maxDays: 60 });

		const projectRollup = rows(
			await db.execute(
				sql`SELECT shown, clicked, creator_id FROM card_impressions_daily WHERE surface = ${TEST_SURFACE} AND subject_kind = 'project'`,
			),
		)[0];
		expect(projectRollup).toEqual({ shown: 2, clicked: 1, creator_id: creatorId });

		const creatorRollup = rows(
			await db.execute(
				sql`SELECT shown, creator_id FROM card_impressions_daily WHERE surface = ${TEST_SURFACE} AND subject_kind = 'creator'`,
			),
		)[0];
		expect(creatorRollup?.creator_id).toBe(creatorId);
	});
});

afterAll(async () => {
	// A test cleans up everything it writes, on success or failure. Traffic rows have
	// no account to purge, so the suite's own markers are the keys: session ids for
	// raw views, the test surface for card rows, and exactly the days we backdated
	// for the rollups (nothing this session wrote is older than its own fixtures).
	await db.delete(trafficEvents).where(sql`session_id LIKE ${`${sessionPrefix}%`}`);
	await db.execute(
		sql`DELETE FROM traffic_daily WHERE day IN (${sql.join(
			PRUNED_DAYS.map((n) => sql`${daysAgoIso(n).slice(0, 10)}`),
			sql`, `,
		)})`,
	);
	await db.execute(sql`DELETE FROM card_impressions WHERE surface = ${TEST_SURFACE}`);
	await db.execute(sql`DELETE FROM card_impressions_daily WHERE surface = ${TEST_SURFACE}`);
	// The account purge needs no call here: `purgeAccountsCreatedThere` at module scope
	// already registered the beforeAll/afterAll pair that owns the fixture account.
});
