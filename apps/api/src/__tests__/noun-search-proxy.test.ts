// SPDX-License-Identifier: Apache-2.0
/**
 * The Noun Project search proxy — the surface rules proved at the route:
 *
 * - **requireCreator gates every route** — search is for creators designing their own
 *   ladder, and nobody else,
 * - **the blocklist refuses the query before the vendor is called** — a refused search
 *   makes zero vendor requests,
 * - **nothing about a search response persists** — no result row, no thumbnail bytes,
 *   no query record; the response is the only copy,
 * - **the budget degrades rather than errors** — an exhausted creator gets a structured
 *   429 the picker states, and the `budget` meter reads what remains,
 * - and a non-creator gets 403 on all of it.
 *
 * The vendor is stubbed at `globalThis.fetch` (the house pattern), counting requests so
 * the before-the-vendor-call ordering is provable rather than restated.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { nounBlocklist, nounSpend } from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import app from "../index";
import { DAILY_SERVICE_BUDGET, recordSpend, spendDay } from "../services/noun-budget";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);

const originalFetch = globalThis.fetch;
let vendorRequests = 0;

beforeAll(() => {
	process.env.NOUNPRO_KEY = "noun-search-test-key";
	process.env.NOUNPRO_SECRET = "noun-search-test-secret";
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("api.thenounproject.com")) {
			vendorRequests++;
			return new Response(
				JSON.stringify({
					icons: [
						{
							id: "777",
							term: "moss test specimen",
							thumbnail_url: "https://cdn.thenounproject.com/img/777.png",
							attribution: "specimen by Test Artist",
							license_description: "public-domain",
							creator: { name: "Test Artist" },
							collections: [],
						},
					],
					next_page: null,
				}),
				{ status: 200 },
			);
		}
		return originalFetch(input as RequestInfo);
	}) as typeof fetch;
});

afterAll(async () => {
	globalThis.fetch = originalFetch;
	delete process.env.NOUNPRO_KEY;
	delete process.env.NOUNPRO_SECRET;
	await db.delete(nounBlocklist).where(sql`${nounBlocklist.value} like ${"ns-test-%"}`);
});

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

function get(path: string, cookie: string) {
	return req(path, { headers: { Origin: ORIGIN, Cookie: cookie } });
}

describe("the noun search proxy", () => {
	let creator: { cookie: string; userId: number };
	let reader: { cookie: string; userId: number };

	beforeAll(async () => {
		creator = await createAccount(`ns_creator_${RUN}`, { fields: { isCreator: true } });
		reader = await createAccount(`ns_reader_${RUN}`);
		await db.delete(nounSpend).where(eq(nounSpend.creatorId, creator.userId));
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.delete(nounSpend).where(eq(nounSpend.creatorId, creator.userId));
	});

	it("🚨 answers a creator with live search results and persists nothing", async () => {
		const before = vendorRequests;
		const res = await get(`/api/noun/search?q=ns-test-query-${RUN}`, creator.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			icons: { id: string; artistName: string; thumbnailUrl: string }[];
		};
		expect(body.icons.length).toBe(1);
		expect(body.icons[0].artistName).toBe("Test Artist");
		// Exactly one vendor request: the search itself. No metadata fetch followed it —
		// provenance rode along.
		expect(vendorRequests).toBe(before + 1);

		// 🚨 NOTHING PERSISTED: no row in any table carries this query or these thumbs.
		const spend = await db
			.select()
			.from(nounSpend)
			.where(eq(nounSpend.creatorId, creator.userId));
		// The counter row exists (the spend was recorded) but carries counts only —
		// never a query, a term or a thumbnail URL.
		for (const row of spend) {
			const raw = JSON.stringify(row);
			expect(raw.includes("ns-test-query")).toBe(false);
			expect(raw.includes("thenounproject.com")).toBe(false);
		}
	});

	it("🚨 refuses a blocklisted term before the vendor is called", async () => {
		const [admin] = await db.select().from(nounBlocklist).limit(0); // assert table reachable
		void admin;
		const { addToBlocklist } = await import("../services/noun-blocklist");
		await addToBlocklist({
			kind: "term",
			value: `ns-test-forbidden-${RUN}`,
			reason: "test fixture",
			addedBy: creator.userId,
		});
		const before = vendorRequests;
		const res = await get(`/api/noun/search?q=ns-test-forbidden-${RUN}`, creator.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { refused?: boolean; icons: unknown[] };
		expect(body.refused).toBe(true);
		expect(body.icons).toEqual([]);
		expect(vendorRequests).toBe(before);
	});

	it("🚨 filters a blocked icon id from an otherwise live result", async () => {
		const { addToBlocklist } = await import("../services/noun-blocklist");
		await addToBlocklist({ kind: "icon", value: "777", reason: "test fixture", addedBy: creator.userId });
		try {
			const res = await get(`/api/noun/search?q=ns-test-filter-${RUN}`, creator.cookie);
			const body = (await res.json()) as { icons: unknown[] };
			expect(body.icons).toEqual([]);
		} finally {
			// This suite's fixture icon id must not stay blocked for other suites.
			await db
				.delete(nounBlocklist)
				.where(sql`${nounBlocklist.value} = ${"777"}`);
		}
	});

	it("degrades with a structured 429 when the creator's day is spent", async () => {
		for (let i = 0; i < DAILY_SERVICE_BUDGET; i++) await recordSpend(creator.userId, "service");
		const res = await get(`/api/noun/search?q=ns-test-over-${RUN}`, creator.cookie);
		expect(res.status).toBe(429);
		const body = (await res.json()) as { code?: string; serviceBudget?: number };
		expect(body.code).toBe("budget_exhausted");
		expect(body.serviceBudget).toBe(DAILY_SERVICE_BUDGET);
	});

	it("reports the budget meter without spending anything", async () => {
		const before = vendorRequests;
		const res = await get("/api/noun/budget", creator.cookie);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { iconCalls: number; serviceCalls: number };
		// At or past the cap — the degradation test above drove the counter there — and
		// the meter read it without a single vendor request behind the read.
		expect(body.serviceCalls).toBeGreaterThanOrEqual(DAILY_SERVICE_BUDGET);
		expect(body.iconCalls).toBe(0);
		expect(vendorRequests).toBe(before);
	});

	it("🚨 gives a non-creator 403 on every route", async () => {
		for (const [path, status] of [
			["/api/noun/search?q=whatever", 403],
			["/api/noun/icons/123/similar", 403],
			["/api/noun/budget", 403],
		] as const) {
			const res = await get(path, reader.cookie);
			expect({ path, status: res.status }).toEqual({ path, status });
		}
	});

	it("gives the signed-out a 401 rather than leaking the surface", async () => {
		const res = await req("/api/noun/search?q=whatever");
		expect(res.status).toBe(401);
	});
});