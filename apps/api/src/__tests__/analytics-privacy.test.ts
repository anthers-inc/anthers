// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Creators never see who watched what" — the privacy policy's sharpest claim,
 * pinned.
 *
 * 51.05 says it as a commitment rather than a description: *"Analytics are
 * aggregated by Work and by date, and your identity is never part of them. A creator
 * can see that a Work was watched for forty hours; they cannot see that it was
 * watched by you. This is a design commitment, not a current limitation, and it is
 * enforced in the code that produces those figures."*
 *
 * Until this file, it was enforced by nothing — it held because every query in
 * `routes/integrations.ts` happens to filter on `creatorId` and aggregate by Work or
 * by date, and **nothing would have failed loudly if someone added a `groupBy(userId)`
 * or selected the column**. 51.05's own notes flag it as one of two claims that were
 * "promises about code that is currently only a habit".
 *
 * That is exactly the family of defect the third-party-requests work named: **where a
 * document claims an absence, that absence needs a test**, because absences rot
 * silently — there is no feature to exercise, nothing errors, and reading the code
 * shows you the code as it is today rather than as the next person will leave it.
 *
 * So the assertion is deliberately NOT "the queries group by workId". That would
 * restate the implementation and agree with it forever. It is: **two identified
 * viewers generate attention, the creator reads every analytics surface, and nothing
 * that comes back can be traced to either of them** — which stays true as a test of a
 * new field nobody has written yet.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { users } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
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
		body: JSON.stringify({ username, email: `${username}@example.com`, password: "testpass123" }),
	});
	expect(res.status).toBe(201);
	return res.headers.get("Set-Cookie")!.split(";")[0];
}

const id = crypto.randomUUID().slice(0, 8);
const creatorName = `apriv_creator_${id}`;
const viewerAName = `apriv_watcher_alpha_${id}`;
const viewerBName = `apriv_watcher_beta_${id}`;

let creator: string;
let creatorId: number;
let viewerAId: number;
let viewerBId: number;
let workId: number;

/** Every analytics surface a creator can read. If a fourth appears, it belongs here. */
const ANALYTICS_ROUTES = [
	"/api/integrations/analytics/overview",
	"/api/integrations/analytics/content",
	"/api/integrations/analytics/timeseries",
] as const;

/**
 * Walk a JSON tree and collect every key, at any depth.
 *
 * The identity check below is a *shape* assertion rather than a value one, because a
 * value scan only finds what it already knows to look for. A creator-facing payload
 * that grew a `viewers: [...]` array would slip past a search for one username the
 * moment the field held a display name, an avatar URL, or an id.
 */
function allKeys(value: unknown, out: string[] = []): string[] {
	if (Array.isArray(value)) {
		for (const v of value) allKeys(v, out);
	} else if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out.push(k);
			allKeys(v, out);
		}
	}
	return out;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${viewerAName}, ${viewerBName})`,
	);
	creator = await signUp(creatorName);
	const viewerA = await signUp(viewerAName);
	const viewerB = await signUp(viewerBName);
	await db.execute(sql`UPDATE users SET is_creator = true WHERE username = ${creatorName}`);

	const idOf = async (username: string) => {
		const [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
		return row.id;
	};
	creatorId = await idOf(creatorName);
	viewerAId = await idOf(viewerAName);
	viewerBId = await idOf(viewerBName);

	const workRes = await post("/api/content/works", creator, {
		type: "video",
		title: `Analytics privacy fixture ${id}`,
	});
	expect(workRes.status).toBe(201);
	workId = (await workRes.json()).work.id;

	// Released and free, so the attention events are eligible — an ineligible event is
	// dropped at the write boundary and would leave nothing for analytics to leak.
	const release = await req(`/api/content/works/${workId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: creator },
		body: JSON.stringify({
			visibility: "released",
			anthersAccess: [{ threshold: 0, allow: true, price: "0" }],
		}),
	});
	expect(release.status).toBe(200);

	// Two DIFFERENT viewers, with different amounts of time, so a leak would have
	// something to distinguish. One viewer would let a per-user figure masquerade as
	// a total.
	for (const [cookie, seconds] of [
		[viewerA, 120],
		[viewerB, 45],
	] as const) {
		const res = await post("/api/subscriptions/attention", cookie, {
			events: [{ creatorId, eventType: "watch", durationSeconds: seconds, workId }],
		});
		expect(res.status).toBe(200);
	}
}, DB_SETUP_TIMEOUT);

describe("creator analytics never expose per-viewer identity", () => {
	it("names no viewer in any analytics response", async () => {
		for (const route of ANALYTICS_ROUTES) {
			const res = await req(route, { headers: { Cookie: creator } });
			expect(res.status).toBe(200);
			const body = await res.json();
			const serialized = JSON.stringify(body);

			// Neither viewer's username, nor their ids under any key name.
			expect(serialized).not.toContain(viewerAName);
			expect(serialized).not.toContain(viewerBName);
			expect(serialized).not.toContain("watcher_alpha");
			expect(serialized).not.toContain("watcher_beta");
		}
	});

	it("carries no viewer-identifying FIELD, whatever it might be called", async () => {
		for (const route of ANALYTICS_ROUTES) {
			const res = await req(route, { headers: { Cookie: creator } });
			const keys = allKeys(await res.json());

			// The allowlist is an explicit set rather than a looser pattern, so adding a
			// viewer-ish field is a deliberate edit here with a reason attached — this
			// assertion has already caught one addition (`uniqueViewersWindowDays`, added
			// with the retention rollup), which is the behaviour wanted.
			//
			//   `uniqueViewers`           — a COUNT. How many, never who. A creator knowing
			//                               two people watched reveals nothing about either.
			//   `uniqueViewersWindowDays` — how far back that count reaches, in days. A
			//                               property of the query, not of any person.
			const COUNTS_NOT_IDENTITIES = new Set(["uniqueViewers", "uniqueViewersWindowDays"]);

			const identityish = keys.filter(
				(k) =>
					/user|viewer|watcher|account|member|audience/i.test(k) && !COUNTS_NOT_IDENTITIES.has(k),
			);
			expect(identityish).toEqual([]);
		}
	});

	it("aggregates rather than omits — the figures are real, they just aren't per-person", async () => {
		// The counterpart assertion, and the reason the two above aren't satisfiable by
		// returning nothing at all. A creator IS owed their numbers; what they're not
		// owed is whose they are.
		const overview = await (
			await req(ANALYTICS_ROUTES[0], { headers: { Cookie: creator } })
		).json();
		expect(overview.uniqueViewers).toBe(2);
		expect(overview.events.watches).toBe(2);
		// 120 + 45 seconds as hours, which the overview rounds to two places. The exact
		// figure is asserted below off `/content`, where it arrives unrounded.
		expect(overview.totalDurationHours).toBeCloseTo(165 / 3600, 2);

		const content = await (await req(ANALYTICS_ROUTES[1], { headers: { Cookie: creator } })).json();
		const row = (content.content as { id: number; totalDuration: number }[]).find(
			(r) => r.id === workId,
		);
		expect(row).toBeDefined();
		// Per-WORK totals are the aggregation axis the policy names, and both viewers'
		// time is summed into one figure.
		expect(row!.totalDuration).toBe(165);
	});

	it("shows a creator nothing about a DIFFERENT creator's audience", async () => {
		// The other half of the same promise. Analytics filter on `creatorId`, so a
		// creator with no attention of their own must see zero rather than the platform's.
		const otherName = `apriv_other_${id}`;
		await db.execute(sql`DELETE FROM users WHERE username = ${otherName}`);
		const other = await signUp(otherName);
		await db.execute(sql`UPDATE users SET is_creator = true WHERE username = ${otherName}`);

		const overview = await (await req(ANALYTICS_ROUTES[0], { headers: { Cookie: other } })).json();
		expect(overview.uniqueViewers).toBe(0);
		expect(overview.events.total).toBe(0);
		expect(overview.totalDurationHours).toBe(0);
	});

	it("the viewer ids ARE in the table — this is a read-time property, not an absence of data", async () => {
		// Worth pinning explicitly, because it is what makes the promise a real one and
		// what makes it fragile. `attention_events.user_id` exists and is populated —
		// the Time Pool cannot pay by watch-time without it, and the clamp cannot bound
		// a person's credited seconds without knowing which person. So the identity is
		// always one `groupBy` away, and the guarantee is entirely about what the
		// analytics queries choose to select.
		//
		// If this assertion ever fails it means the retention job dropped these rows,
		// and the tests above became vacuous — they would pass against an empty table.
		const [row] = await db.execute(
			sql`SELECT count(*)::int AS n FROM attention_events
			    WHERE creator_id = ${creatorId} AND user_id IN (${viewerAId}, ${viewerBId})`,
		);
		expect(Number((row as { n: number }).n)).toBe(2);
	});
});
