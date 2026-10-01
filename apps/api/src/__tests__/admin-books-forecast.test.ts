// SPDX-License-Identifier: Apache-2.0
/**
 * The sales-tax threshold forecast — what the purchase rows say about each state's threshold,
 * and the honesty the forecast owes while renewal rows carry no buyer location.
 *
 * The properties pinned here are the ones the vendor decision turns on:
 *
 * 1. **Per-state counts against each state's own window.** A purchase counts toward the state
 *    the buyer was in and the window that state measures over — a calendar-year state ignores
 *    last year's rows, and a refunded purchase still counts, because the charge crossed the
 *    threshold when it was made.
 * 2. **The OR vs AND distinction.** A state that has crossed only its transaction prong has
 *    crossed under OR and has not under AND.
 * 3. **The trajectory is a straight-line projection** of the elapsed window, labeled as such.
 * 4. **A crossed state says what crossing starts**, on the state's own clock.
 * 5. **The support-renewal boundary is stated in the response**, not silently missing.
 * 6. **The gate holds**: no session → 401, a signed-in Anthers account → 401, and the whole
 *    surface 404s off the admin host.
 *
 * Purchases are written directly rather than driven through Stripe, the same as
 * `admin-books.test.ts`: the webhook path is `payments-stripe.test.ts`'s subject, and this
 * suite tests the reading of rows that already carry their location.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { purchases } from "@anthers/db/schema";
import { STATE_THRESHOLDS, windowFor } from "@anthers/shared/sales-tax-thresholds";
import { eq } from "drizzle-orm";
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
 * 🚨 **Naming `ADMIN_URL` is what makes the wrong-host refusal real here** — the same pin as
 * `admin-books.test.ts`, and for the same reason: with it unset the admin host falls back to
 * "any host in a checkout", so nothing can 404.
 */
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);

interface ForecastState {
	state: string;
	name: string;
	homeState: boolean;
	noSalesTax: boolean;
	verified: boolean;
	effectivelyAlwaysOn: boolean;
	dollars: string;
	transactions: number;
	dollarThreshold: number | null;
	transactionThreshold: number | null;
	relation: "or" | "and" | null;
	dollarFraction: number;
	transactionFraction: number;
	status: "clear" | "approaching" | "crossed";
	firesFirst: "dollar" | "transactions" | null;
	projection: { dollars: string; transactions: number; elapsedFraction: number } | null;
	window: { label: string; start: string; end: string } | null;
	note: string | null;
	crossingStarts: string | null;
}

interface Forecast {
	states: ForecastState[];
	notes: string[];
	asOf: string;
}

let adminCookie: string;
let plainCookie: string;
let buyerId: number;
/** The payment-intent ids this suite inserted, so nothing else's rows are touched. */
const intentIds: string[] = [];

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("forecast")).cookie;
	const buyer = await createAccount(`forecast_buyer_${run}`);
	plainCookie = buyer.cookie;
	buyerId = buyer.userId;
}, DB_SETUP_TIMEOUT);

/** A purchase as the webhook stamps one, in the buyer's state, on the day named. */
async function insertPurchase(opts: {
	state: string | null;
	amount: string;
	day: string;
	status?: string;
	count?: number;
}) {
	for (let i = 0; i < (opts.count ?? 1); i++) {
		const pi = `pi_forecast_${run}_${intentIds.length}`;
		intentIds.push(pi);
		await db.insert(purchases).values({
			buyerId,
			type: "digital",
			amount: opts.amount,
			processingFee: "0.45",
			crfFee: "0.00",
			salesTax: "1.00",
			creatorEarnings: opts.amount,
			stripePaymentIntentId: pi,
			status: opts.status ?? "completed",
			buyerCountry: opts.state ? "US" : null,
			buyerState: opts.state,
			buyerCity: null,
			createdAt: new Date(`${opts.day}T12:00:00Z`),
		});
	}
}

async function forecast(): Promise<Forecast> {
	const res = await req("/api/admin/books/sales-tax-forecast", {
		headers: { Cookie: adminCookie },
	});
	expect(res.status).toBe(200);
	return (await res.json()) as Forecast;
}

function stateOf(body: Forecast, code: string): ForecastState {
	const row = body.states.find((s) => s.state === code);
	if (!row) throw new Error(`${code} missing from the forecast`);
	return row;
}

describe("Admin sales-tax forecast", () => {
	// ── The gate ────────────────────────────────────────────────────────────
	it("rejects unauthenticated requests with 401", async () => {
		expect((await req("/api/admin/books/sales-tax-forecast")).status).toBe(401);
	});

	it("refuses a signed-in Anthers account, whose session cookie is not an admin session", async () => {
		const res = await req("/api/admin/books/sales-tax-forecast", {
			headers: { Cookie: plainCookie },
		});
		expect(res.status).toBe(401);
	});

	it("does not advertise the surface off the admin host (404, not 401)", async () => {
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/books/sales-tax-forecast`, {
				headers: { Cookie: adminCookie },
			}),
		);
		expect(res.status).toBe(404);
	});

	// ── The response carries every state with its own window ────────────────
	it("answers for every row of the threshold table, with the window each is measured over", async () => {
		const body = await forecast();
		expect(body.states).toHaveLength(STATE_THRESHOLDS.length);
		// A current-or-prior-calendar-year state: the current year, which "as of" pins.
		const asOf = new Date(body.asOf);
		const az = stateOf(body, "AZ");
		expect(az.window?.start).toBe(`${asOf.getUTCFullYear()}-01-01T00:00:00.000Z`);
		// A previous-calendar-year state: last year's span.
		const fl = stateOf(body, "FL");
		expect(fl.window?.start).toBe(`${asOf.getUTCFullYear() - 1}-01-01T00:00:00.000Z`);
		// Colorado and the no-tax states carry no window at all.
		expect(stateOf(body, "CO").window).toBeNull();
		expect(stateOf(body, "OR").window).toBeNull();
		expect(stateOf(body, "CO").homeState).toBe(true);
	});

	it("states the support-renewal boundary rather than silently undercounting", async () => {
		const body = await forecast();
		expect(
			body.notes.some((n) => n.includes("Support renewals are not yet counted by state")),
		).toBe(true);
	});

	// ── The counts, against each state's own window ─────────────────────────
	it("counts a state's purchases in its own window only, and refunded charges still count", async () => {
		// Maryland (OR, $100,000 / 200 tx, current calendar year): five purchases this year.
		const year = new Date().getUTCFullYear();
		await insertPurchase({ state: "MD", amount: "20.00", day: `${year}-03-10`, count: 3 });
		await insertPurchase({
			state: "MD",
			amount: "25.00",
			day: `${year}-04-10`,
			status: "refunded",
		});
		// A purchase in the previous year: the calendar-year window must not count it. A
		// Florida purchase in the same year lands inside Florida's own previous-calendar-year
		// window, so each state's count is its own.
		await insertPurchase({ state: "MD", amount: "500.00", day: `${year - 1}-06-01` });
		await insertPurchase({ state: "FL", amount: "500.00", day: `${year - 1}-06-01` });

		const body = await forecast();
		const md = stateOf(body, "MD");
		expect(md.transactions).toBe(4); // three completed plus the refunded one
		expect(md.dollars).toBe("85.00");
		// The out-of-window purchase is nowhere in Maryland's count.
		expect(md.dollarFraction).toBeCloseTo(85 / 100_000, 6);

		// The prior-year row lands in Florida's window, not Maryland's — FL's count is its own.
		const fl = stateOf(body, "FL");
		expect(fl.transactions).toBe(1);
		expect(fl.dollars).toBe("500.00");
	});

	it("crosses an OR state on the transaction prong alone, and does not cross an AND state on one prong", async () => {
		// Maryland's 4 purchases above sit far under 200 tx, so give the OR case its own
		// state: DC (OR, $100,000 / 200 tx, current calendar year) with 200 transactions.
		const year = new Date().getUTCFullYear();
		await insertPurchase({ state: "DC", amount: "1.00", day: `${year}-05-01`, count: 200 });

		// Connecticut is the AND state: $100,000 AND 200 tx, 12 months ending Sept 30.
		// 200 transactions alone must leave it uncrossed. The day is placed inside CT's
		// own window via `windowFor` — the same helper the service reads — because a day
		// picked by hand lands on the wrong side of the Sept 30 boundary half the year.
		const ctWindow = windowFor("CT", new Date())!;
		const mid = new Date((ctWindow.start.getTime() + ctWindow.end.getTime()) / 2);
		const ctDay = mid.toISOString().slice(0, 10);
		await insertPurchase({ state: "CT", amount: "1.00", day: ctDay, count: 200 });

		const body = await forecast();
		const dc = stateOf(body, "DC");
		expect(dc.status).toBe("crossed"); // OR: 200 tx crossed it on the tx prong
		expect(dc.crossingStarts).not.toBeNull(); // and the row says what crossing starts

		const ct = stateOf(body, "CT");
		expect(ct.status).not.toBe("crossed"); // AND: both prongs required, only tx is over
		expect(ct.transactionFraction).toBeGreaterThanOrEqual(1);
	});

	it("projects the window's end from the elapsed portion, as a straight line", async () => {
		const body = await forecast();
		// Maryland again: its projection is the count scaled by the elapsed window.
		const md = stateOf(body, "MD");
		expect(md.projection).not.toBeNull();
		const asOf = new Date(body.asOf);
		const jan1 = Date.UTC(asOf.getUTCFullYear(), 0, 1);
		const jan1Next = Date.UTC(asOf.getUTCFullYear() + 1, 0, 1);
		const elapsed = (asOf.getTime() - jan1) / (jan1Next - jan1);
		expect(md.projection!.elapsedFraction).toBeCloseTo(elapsed, 6);
		const projectedDollars = Number(md.projection!.dollars);
		expect(projectedDollars).toBeGreaterThan(85); // scaled up by 1/elapsed
		expect(projectedDollars).toBeLessThan((85 / elapsed) * 1.001);
		// The transaction prong fires first at this pace: $85 projected against $100,000
		// never crosses, and the projected tx count is the nearer prong.
		expect(md.firesFirst).toBe("transactions");
	});

	it("marks a state at or over 70% of a prong as approaching", async () => {
		// Oklahoma: $10,000, trailing 12 months — the effectively always-on one. The day
		// is placed inside OK's own window via `windowFor`, since "mid this month" can sit
		// past `now` on the first of a month and a future row must not count.
		const okWindow = windowFor("OK", new Date())!;
		const mid = new Date((okWindow.start.getTime() + okWindow.end.getTime()) / 2);
		const day = mid.toISOString().slice(0, 10);
		await insertPurchase({ state: "OK", amount: "7500.00", day });
		const body = await forecast();
		const ok = stateOf(body, "OK");
		expect(ok.status).toBe("approaching");
		expect(ok.effectivelyAlwaysOn).toBe(true);
		// The Oklahoma row reads as effectively always-on in the response itself.
		expect(ok.note).toContain("effectively always-on");
	});

	it("sorts by proximity to threshold, nearest state on top", async () => {
		const body = await forecast();
		const crossed = stateOf(body, "DC");
		const index = body.states.findIndex((s) => s.state === crossed.state);
		// DC at 100% of its tx prong sits above Maryland at 85/100,000.
		const mdIndex = body.states.findIndex((s) => s.state === "MD");
		expect(index).toBeLessThan(mdIndex);
		// The whole board is monotone by its own proximity measure.
		for (let i = 1; i < body.states.length; i++) {
			const prev = body.states[i - 1]!;
			const here = body.states[i]!;
			const p = (s: ForecastState) => Math.max(s.dollarFraction, s.transactionFraction);
			expect(p(prev)).toBeGreaterThanOrEqual(p(here));
		}
	});

	it("carries the Playbook's unverified marks to the response", async () => {
		const body = await forecast();
		expect(stateOf(body, "KY").verified).toBe(false);
		expect(stateOf(body, "MI").verified).toBe(false);
		expect(stateOf(body, "AZ").verified).toBe(true);
	});
});

// The purchases this suite wrote go by their own payment-intent ids, in afterAll on success
// or failure — the same sweep as `admin-books.test.ts`, and a bail before any insert leaves
// the list empty and the loop a no-op.
afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	for (const pi of intentIds) {
		await db.delete(purchases).where(eq(purchases.stripePaymentIntentId, pi));
	}
});
