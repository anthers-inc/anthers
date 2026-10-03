// SPDX-License-Identifier: Apache-2.0
/**
 * The sales-tax return worksheet — what the rows produce, and the honesty they owe.
 *
 * The properties pinned here are the ones a filing turns on:
 *
 * 1. **Per-jurisdiction totals from the rows.** A period with purchases and invoices totals
 *    each buyer state's tax and taxable sales, and each Colorado city buyers named, with
 *    refunded purchases excluded (their tax went back with the sale).
 * 2. **The empty period is a complete zero worksheet, not an error** — a missed zero return
 *    accrues penalties the same as a missed filing with tax due, so a period with nothing
 *    collected renders every total at zero with `empty: true`.
 * 3. **Delta and Telluride are flagged when they appear**, because each is filed with
 *    directly, outside SUTS.
 * 4. **A bad period name is a 400, and the gate holds**: no session → 401, a signed-in
 *    Anthers account → 401, and the whole surface 404s off the admin host.
 *
 * Purchases and invoices are written directly rather than driven through Stripe: the webhook
 * path is `payments-stripe.test.ts`'s subject, and this suite tests the reading of rows that
 * already carry their tax and location.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { invoices, purchases } from "@anthers/db/schema";
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
 * 🚨 **Naming `ADMIN_URL` is what makes the wrong-host refusal real here.** With it unset the
 * admin host falls back to "any host in a checkout" (`isAdminHost`), so nothing can 404 — the
 * same reason `admin-auth.test.ts` pins it before asserting host behavior. While it is set,
 * every request in this suite goes to the admin host it names.
 */
const ADMIN_HOST = "http://admin.anthers.test";
const SITE_HOST = "http://anthers.test";
let savedAdminUrl: string | undefined;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`${ADMIN_HOST}${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
/** A period far enough back that no other suite's rows can land in it. */
const PERIOD = "2020-06";

interface JurisdictionTotals {
	state: string;
	city: string | null;
	purchases: number;
	taxable: string;
	tax: string;
}

interface Worksheet {
	period: { kind: string; label: string; start: string; end: string };
	empty: boolean;
	totals: {
		taxCollected: string;
		taxableSales: string;
		purchaseTax: string;
		purchaseTaxable: string;
		purchaseCount: number;
		invoiceTax: string;
		invoiceTaxable: string;
		invoiceCount: number;
	};
	byState: JurisdictionTotals[];
	byCity: JurisdictionTotals[];
	directFileCities: JurisdictionTotals[];
	notes: string[];
}

let adminCookie: string;
let plainCookie: string;
let buyerId: number;
/** The payment-intent ids this suite inserted, so nothing else's rows are touched. */
const intentIds: string[] = [];
const invoiceIds: string[] = [];

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("books")).cookie;
	const buyer = await createAccount(`books_buyer_${run}`);
	plainCookie = buyer.cookie;
	buyerId = buyer.userId;
}, DB_SETUP_TIMEOUT);

/** A completed purchase in the period, with the location the webhook stamps. */
async function insertPurchase(opts: {
	city: string | null;
	state: string | null;
	amount: string;
	tax: string;
	status?: string;
}) {
	const pi = `pi_books_${run}_${intentIds.length}`;
	intentIds.push(pi);
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId,
			type: "digital",
			amount: opts.amount,
			processingFee: "0.45",
			salesTax: opts.tax,
			creatorEarnings: opts.amount,
			stripePaymentIntentId: pi,
			status: opts.status ?? "completed",
			buyerCountry: opts.state ? "US" : null,
			buyerState: opts.state,
			buyerPostalCode: opts.state === "CO" ? "80000" : null,
			buyerCity: opts.city,
			createdAt: new Date("2020-06-15T12:00:00Z"),
		})
		.returning();
	return row;
}

/** A collected invoice for the period's month, as `recordPaidInvoice` writes one. */
async function insertInvoice(tax: string, status = "paid") {
	const id = `in_books_${run}_${invoiceIds.length}`;
	invoiceIds.push(id);
	return db
		.insert(invoices)
		.values({
			userId: buyerId,
			stripeInvoiceId: id,
			billingCycle: "2020-06-01",
			subtotal: "17.00",
			total: "17.00",
			tax,
			status,
			paidAt: new Date("2020-06-01T03:00:00Z"),
		})
		.returning();
}

async function worksheet(period = PERIOD): Promise<Response> {
	return req(`/api/admin/books/sales-tax-worksheet?period=${period}`, {
		headers: { Cookie: adminCookie },
	});
}

describe("Admin sales-tax worksheet", () => {
	// ── The gate ────────────────────────────────────────────────────────────
	it("rejects unauthenticated requests with 401", async () => {
		expect((await req(`/api/admin/books/sales-tax-worksheet?period=${PERIOD}`)).status).toBe(401);
	});

	it("refuses a signed-in Anthers account, whose session cookie is not an admin session", async () => {
		const res = await req(`/api/admin/books/sales-tax-worksheet?period=${PERIOD}`, {
			headers: { Cookie: plainCookie },
		});
		expect(res.status).toBe(401);
	});

	it("does not advertise the surface off the admin host (404, not 401)", async () => {
		// With `ADMIN_URL` pinned above, a request whose URL carries some other host is
		// refused by `adminHostOnly` before the session is even read — the same 404 (not
		// 401) that keeps the main site from learning this surface exists.
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/books/sales-tax-worksheet?period=${PERIOD}`, {
				headers: { Cookie: adminCookie },
			}),
		);
		expect(res.status).toBe(404);
	});

	it("refuses a period that is not a month, quarter or year with 400", async () => {
		const res = await worksheet("not-a-period");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { code: string };
		expect(body.code).toBe("bad_period");
		// And the shapes that parse still answer, whichever frequency the caller names.
		expect((await worksheet("2020-Q2")).status).toBe(200);
		expect((await worksheet("2020")).status).toBe(200);
	});

	// ── An empty period ─────────────────────────────────────────────────────
	it("renders a period with nothing collected as a complete zero worksheet", async () => {
		const res = await worksheet();
		expect(res.status).toBe(200);
		const body = (await res.json()) as Worksheet;
		expect(body.empty).toBe(true);
		expect(body.totals.taxCollected).toBe("0.00");
		expect(body.totals.taxableSales).toBe("0.00");
		expect(body.totals.purchaseCount).toBe(0);
		expect(body.totals.invoiceCount).toBe(0);
		expect(body.byState).toHaveLength(0);
		expect(body.byCity).toHaveLength(0);
		expect(body.directFileCities).toHaveLength(0);
		// The boundary notes reach an empty period too: the person filing still needs them.
		expect(body.notes.length).toBeGreaterThan(0);
	});

	// ── Totals from the rows ────────────────────────────────────────────────
	it("totals each state and each named Colorado city, excluding refunded purchases", async () => {
		// A Delta purchase (the direct-file flag), a Denver one, a Texas one, a refunded
		// Denver one that must not count, and a collected renewal invoice.
		await insertPurchase({ city: "Delta", state: "CO", amount: "10.00", tax: "0.90" });
		await insertPurchase({ city: "Denver", state: "CO", amount: "20.00", tax: "1.80" });
		await insertPurchase({ city: "Austin", state: "TX", amount: "30.00", tax: "2.40" });
		await insertPurchase({
			city: "Denver",
			state: "CO",
			amount: "40.00",
			tax: "3.60",
			status: "refunded",
		});
		await insertInvoice("0.70");

		const res = await worksheet();
		expect(res.status).toBe(200);
		const body = (await res.json()) as Worksheet;

		// Refunded tax went back to the buyer, so it is nowhere in the totals.
		expect(body.empty).toBe(false);
		expect(body.totals.purchaseCount).toBe(3);
		expect(body.totals.purchaseTaxable).toBe("60.00");
		expect(body.totals.purchaseTax).toBe("5.10");
		expect(body.totals.invoiceCount).toBe(1);
		expect(body.totals.invoiceTaxable).toBe("17.00");
		expect(body.totals.invoiceTax).toBe("0.70");
		expect(body.totals.taxableSales).toBe("77.00");
		expect(body.totals.taxCollected).toBe("5.80");

		const co = body.byState.find((r) => r.state === "CO");
		expect(co?.purchases).toBe(2);
		expect(co?.taxable).toBe("30.00");
		expect(co?.tax).toBe("2.70");

		const tx = body.byState.find((r) => r.state === "TX");
		expect(tx?.purchases).toBe(1);
		expect(tx?.tax).toBe("2.40");

		// Cities are Colorado only, as the buyer entered them. The state's "Unknown"
		// bucket cannot appear here because buyer_state = 'CO' is the query's own filter.
		expect([...body.byCity.map((r) => r.city)].sort()).toEqual(["Delta", "Denver"]);

		// Delta is flagged for a direct return, outside SUTS.
		expect(body.directFileCities).toHaveLength(1);
		expect(body.directFileCities[0]?.city).toBe("Delta");
		expect(body.directFileCities[0]?.tax).toBe("0.90");

		// The boundary is stated on the worksheet itself, not left in the module's docblock.
		expect(body.notes.length).toBeGreaterThan(0);
	});

	it("flags Telluride alongside Delta when both appear", async () => {
		await insertPurchase({ city: "Telluride", state: "CO", amount: "5.00", tax: "0.45" });
		const res = await worksheet();
		const body = (await res.json()) as Worksheet;
		const names = body.directFileCities.map((c) => c.city).sort();
		expect(names).toEqual(["Delta", "Telluride"]);
	});

	it("keeps a purchase outside the period out of it", async () => {
		// A purchase created in July: the June worksheet above must not grow.
		const pi = `pi_books_${run}_out`;
		intentIds.push(pi);
		await db.insert(purchases).values({
			buyerId,
			type: "digital",
			amount: "99.00",
			processingFee: "0.45",
			salesTax: "9.00",
			creatorEarnings: "99.00",
			stripePaymentIntentId: pi,
			status: "completed",
			buyerCountry: "US",
			buyerState: "CO",
			buyerCity: "Denver",
			createdAt: new Date("2020-07-15T12:00:00Z"),
		});
		const body = (await (await worksheet()).json()) as Worksheet;
		expect(body.totals.purchaseCount).toBe(4); // Delta, Denver, Austin, Telluride
		expect(body.totals.taxCollected).toBe("6.25");
	});
});

// The invoices this suite wrote go by their own Stripe ids, in afterAll on success or
// failure — `purgeAccountIds` deletes `invoices` by user id, but purchases keyed by this
// suite's payment-intent ids need their own sweep, and a bail before any insert leaves the
// lists empty and the loop a no-op.
afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	for (const pi of intentIds) {
		await db.delete(purchases).where(eq(purchases.stripePaymentIntentId, pi));
	}
	for (const id of invoiceIds) {
		await db.delete(invoices).where(eq(invoices.stripeInvoiceId, id));
	}
});
