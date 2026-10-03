// SPDX-License-Identifier: Apache-2.0
/**
 * The monthly close package — the entry's splits, the honesty of its boundaries, and the two
 * reconciliation controls.
 *
 * The properties pinned here are the ones a close turns on:
 *
 * 1. **The exact splits, from the rows.** The invoice event debits Stripe clearing net of the
 *    recorded processing fee; the purchase event debits clearing for Anthers' share only
 *    (tax plus the platform side of the price — never the creator's share); Badge revenue and
 *    the creator liability are separate accounts; the Time Pool books one line per funding,
 *    because a supporter's pool and a free account's pool are different kinds of money.
 * 2. **Debits equal credits always**, including on a settled month with nothing in it.
 * 3. **The unbuilt events are stated, not invented** — the 14-day transfer, the payout-fee
 *    recharge, disputes and the bank payout each appear as a zero line with the why.
 * 4. **Both controls answer**: Due to creators ties to the `creator_credits` rows and fails
 *    plainly when it disagrees; Stripe clearing states it is entry-implied.
 * 5. **An unsettled month is refused rather than estimated**, and the gate holds: no session
 *    → 401, a signed-in Anthers account → 401, the whole surface 404s off the admin host.
 *
 * Rows are written directly rather than driven through Stripe or `settle-cycle`, the same
 * discipline as `admin-books.test.ts`: the webhook path is `payments-stripe.test.ts`'s subject
 * and the settlement run is `settle-cycle.test.ts`'s, and this suite tests the reading of rows
 * that already carry their figures.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	creatorCredits,
	invoiceLines,
	invoices,
	monthSettlements,
	purchases,
} from "@anthers/db/schema";
import Decimal from "decimal.js";
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
/**
 * A month far enough back that no other suite's rows can land in it — and, because the
 * Due-to-creators control ties to every `creator_credits` row, a month late enough that
 * nothing else's cycles fall inside or before it.
 */
const PERIOD = "2019-11";
const CYCLE = "2019-11-01";
const EMPTY_PERIOD = "2019-10";
const UNSETTLED_PERIOD = "2019-09";

interface CloseLine {
	event: string;
	account: string;
	debit: string;
	credit: string;
	memo: string;
	unbuilt?: boolean;
}

interface Package {
	period: { key: string; label: string; cycle: string; settledAt: string };
	empty: boolean;
	entry: { lines: CloseLine[]; totalDebits: string; totalCredits: string; balanced: boolean };
	schedules: {
		invoices: { rows: unknown[]; count: number; totals: Record<string, string> };
		purchases: { rows: unknown[]; count: number; totals: Record<string, string> };
		settlement: {
			credits: { kind: string; fundedBy: string; count: number; total: string }[];
			remainder: unknown[];
			refundShortfalls: unknown[];
		};
	};
	controls: {
		stripeClearing: {
			monthMovement: string;
			impliedBalance: string;
			verifiable: boolean;
			note: string;
		};
		dueToCreators: {
			opening: string;
			movement: string;
			implied: string;
			expected: string;
			difference: string;
			pass: boolean;
			note: string;
		};
	};
	notes: string[];
}

let adminCookie: string;
let plainCookie: string;
let buyerId: number;
let creatorId: number;
/** The Stripe ids this suite inserted, so nothing else's rows are touched. */
const invoiceStripeIds: string[] = [];
const intentIds: string[] = [];
/** The cycles this suite marked settled — `month_settlements` is purged by nothing else. */
const markedCycles: string[] = [];

beforeAll(async () => {
	savedAdminUrl = process.env.ADMIN_URL;
	process.env.ADMIN_URL = ADMIN_HOST;

	adminCookie = (await createAdminFixture("close")).cookie;
	const buyer = await createAccount(`close_buyer_${run}`);
	const creator = await createAccount(`close_creator_${run}`);
	plainCookie = buyer.cookie;
	buyerId = buyer.userId;
	creatorId = creator.userId;
}, DB_SETUP_TIMEOUT);

async function insertInvoice(opts: {
	subtotal: string;
	tax: string;
	processingFee: string;
	status?: string;
	settledAt?: Date | null;
	creatorLine?: string | null;
}) {
	const id = `in_close_${run}_${invoiceStripeIds.length}`;
	invoiceStripeIds.push(id);
	const total = new Decimal(opts.subtotal).plus(opts.tax).toFixed(2);
	const [row] = await db
		.insert(invoices)
		.values({
			userId: buyerId,
			stripeInvoiceId: id,
			stripePaymentIntentId: `pi_close_${run}_${invoiceStripeIds.length}`,
			billingCycle: CYCLE,
			subtotal: opts.subtotal,
			tax: opts.tax,
			total,
			processingFee: opts.processingFee,
			status: opts.status ?? "paid",
			settledAt: opts.settledAt === undefined ? new Date("2019-11-02T06:00:00Z") : opts.settledAt,
			paidAt: new Date("2019-11-01T03:00:00Z"),
		})
		.returning();
	// The Anthers line is the residual of the subtotal, which is how `recordPaidInvoice`
	// splits a charge — so a creator line is written and the Badge line is not.
	if (opts.creatorLine != null) {
		await db
			.insert(invoiceLines)
			.values({ invoiceId: row.id, creatorId, amount: opts.creatorLine });
	}
	return row;
}

async function insertPurchase(opts: {
	amount: string;
	tax: string;
	processingFee: string;
	creatorEarnings: string;
	status?: string;
	refundedAt?: string | null;
}) {
	const pi = `pi_close_${run}_${intentIds.length}`;
	intentIds.push(pi);
	return db
		.insert(purchases)
		.values({
			buyerId,
			creatorId,
			type: "digital",
			amount: opts.amount,
			processingFee: opts.processingFee,
			salesTax: opts.tax,
			creatorEarnings: opts.creatorEarnings,
			stripePaymentIntentId: pi,
			status: opts.status ?? "completed",
			refundedAt: opts.refundedAt ? new Date(opts.refundedAt) : null,
			buyerCountry: "US",
			buyerState: "CO",
			createdAt: new Date("2019-11-15T12:00:00Z"),
		})
		.returning();
}

async function insertCredit(kind: string, fundedBy: string, amount: string, cycle = CYCLE) {
	return db
		.insert(creatorCredits)
		.values({
			creatorId,
			subscriberId: buyerId,
			billingCycle: cycle,
			kind,
			fundedBy,
			amount,
			settledAt: new Date("2019-11-02T06:00:00Z"),
		})
		.returning();
}

async function markSettled(cycle: string) {
	markedCycles.push(cycle);
	await db
		.insert(monthSettlements)
		.values({ billingCycle: cycle, settledAt: new Date("2019-11-02T06:00:00Z"), invoiceCount: 0 })
		.onConflictDoNothing({ target: monthSettlements.billingCycle });
}

async function closePackage(period: string): Promise<Response> {
	return req(`/api/admin/books/close-package?period=${period}`, {
		headers: { Cookie: adminCookie },
	});
}

async function body(period: string): Promise<Package> {
	const res = await closePackage(period);
	expect(res.status).toBe(200);
	return (await res.json()) as Package;
}

/** The one line for an event and account, so a split's exact figure can be asserted. */
function line(pkg: Package, event: string, account: string): CloseLine | undefined {
	return pkg.entry.lines.find((l) => l.event === event && l.account === account);
}

describe("Admin close package", () => {
	// ── The gate ────────────────────────────────────────────────────────────
	it("rejects unauthenticated requests with 401", async () => {
		expect((await req(`/api/admin/books/close-package?period=${PERIOD}`)).status).toBe(401);
	});

	it("refuses a signed-in Anthers account, whose session cookie is not an admin session", async () => {
		const res = await req(`/api/admin/books/close-package?period=${PERIOD}`, {
			headers: { Cookie: plainCookie },
		});
		expect(res.status).toBe(401);
	});

	it("does not advertise the surface off the admin host (404, not 401)", async () => {
		const res = await testFetch(
			new Request(`${SITE_HOST}/api/admin/books/close-package?period=${PERIOD}`, {
				headers: { Cookie: adminCookie },
			}),
		);
		expect(res.status).toBe(404);
	});

	it("refuses a period that is not a month, and a month that has not settled", async () => {
		const bad = await closePackage("2026-Q3");
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { code: string }).code).toBe("bad_period");

		const unsettled = await closePackage(UNSETTLED_PERIOD);
		expect(unsettled.status).toBe(400);
		const unsetBody = (await unsettled.json()) as { code: string; error: string };
		expect(unsetBody.code).toBe("not_settled");
		// The refusal says why rather than leaving the operator to guess.
		expect(unsetBody.error.toLowerCase()).toContain("has not settled");
	});

	// ── A settled month with nothing in it ──────────────────────────────────
	it("closes an empty settled month as a stated-empty, balanced package", async () => {
		await markSettled(`${EMPTY_PERIOD}-01`);
		const pkg = await body(EMPTY_PERIOD);
		expect(pkg.empty).toBe(true);
		expect(pkg.entry.totalDebits).toBe("0.00");
		expect(pkg.entry.totalCredits).toBe("0.00");
		expect(pkg.entry.balanced).toBe(true);
		// The only lines are the unbuilt events, at zero.
		expect(pkg.entry.lines.every((l) => l.unbuilt)).toBe(true);
		// Both controls still answer, and the empty month ties.
		expect(pkg.controls.dueToCreators.pass).toBe(true);
		expect(pkg.controls.stripeClearing.verifiable).toBe(false);
	});

	// ── The entry's splits, from the rows ────────────────────────────────────
	it("books the month's charges with the exact splits, and debits equal credits", async () => {
		await markSettled(CYCLE);
		// A paid, settled invoice: $10 directed at the creator, $7 to Anthers, $1.02 tax,
		// $0.82 processing — so the clearing debit is $17.20 net, not the $18.02 charged.
		await insertInvoice({
			subtotal: "17.00",
			tax: "1.02",
			processingFee: "0.82",
			creatorLine: "10.00",
		});
		// A paused renewal: charged on the card, credited to nobody while the suspension
		// stands — held, not booked.
		await insertInvoice({
			subtotal: "5.00",
			tax: "0.30",
			processingFee: "0.45",
			status: "paused",
			settledAt: null,
		});
		// A refunded renewal that never settled: paid before its money went back, so both
		// events appear and net — $8 directed, $4 to Anthers.
		await insertInvoice({
			subtotal: "12.00",
			tax: "0.72",
			processingFee: "0.65",
			status: "refunded",
			settledAt: null,
			creatorLine: "8.00",
		});
		// A completed purchase: $10 price, $0.92 tax, $0.59 processing, $9.41 to the
		// creator by destination charge — so clearing takes Anthers' share only: $1.51.
		await insertPurchase({
			amount: "10.00",
			tax: "0.92",
			processingFee: "0.59",
			creatorEarnings: "9.41",
		});
		// A purchase refunded inside the month: booked at the sale, reversed at the refund.
		await insertPurchase({
			amount: "20.00",
			tax: "1.84",
			processingFee: "0.88",
			creatorEarnings: "19.12",
			status: "refunded",
			refundedAt: "2019-11-20T12:00:00Z",
		});
		// Settlement: support credited net of the creator-borne share of card processing,
		// and both Time Pool fundings — a supporter's and a free account's.
		await insertCredit("support", "supporter", "9.71");
		await insertCredit("time_pool", "supporter", "3.00");
		await insertCredit("time_pool", "anthers", "0.25");

		const pkg = await body(PERIOD);
		expect(pkg.empty).toBe(false);

		// The invoice event: clearing NET of the recorded fee, the fee expensed, the tax
		// payable, and Badge revenue separate from the creator liability.
		expect(line(pkg, "An invoice is paid", "Stripe clearing")).toMatchObject({ debit: "29.27" });
		expect(line(pkg, "An invoice is paid", "Payment processing expense")).toMatchObject({
			debit: "1.47",
		});
		expect(line(pkg, "An invoice is paid", "Sales tax payable")).toMatchObject({ credit: "1.74" });
		expect(line(pkg, "An invoice is paid", "Support collected not yet settled")).toMatchObject({
			credit: "18.00",
		});
		expect(line(pkg, "An invoice is paid", "Badge revenue")).toMatchObject({ credit: "11.00" });

		// The settlement event bridges gross to net through the expense account: $10.00 of
		// directed lines relieved, $9.71 credited, the $0.29 creator-borne fee returned.
		expect(line(pkg, "A month settles", "Support collected not yet settled")).toMatchObject({
			debit: "10.00",
		});
		expect(line(pkg, "A month settles", "Due to creators")).toMatchObject({ credit: "9.71" });
		expect(line(pkg, "A month settles", "Payment processing expense")).toMatchObject({
			credit: "0.29",
		});

		// The Time Pool books one line per funding — a supporter's pool is a pass-through
		// against Badge revenue, a free account's is Anthers' own money spent.
		const poolLines = pkg.entry.lines.filter(
			(l) =>
				l.event === "The Time Pool is distributed" &&
				l.account === "Time Pool distributions (program)",
		);
		expect(poolLines.map((l) => l.debit).sort()).toEqual(["0.25", "3.00"]);

		// The purchase event: clearing takes Anthers' share ONLY — tax plus the platform
		// side of the price — never the creator's $28.53 of earnings; the creator's fee
		// share is credited, not expensed, because creators bear card processing at cost.
		expect(line(pkg, "A Work is purchased", "Stripe clearing")).toMatchObject({ debit: "4.23" });
		expect(line(pkg, "A Work is purchased", "Sales tax payable")).toMatchObject({ credit: "2.76" });
		expect(line(pkg, "A Work is purchased", "Payment processing expense")).toMatchObject({
			credit: "1.47",
		});

		// The refund events, both halves.
		expect(line(pkg, "A refund or chargeback", "Stripe clearing")).toMatchObject({
			credit: "15.44",
		});
		expect(line(pkg, "A refund or chargeback", "Sales tax payable")).toMatchObject({
			debit: "2.56",
		});
		// The purchase refund's sunk processing is an Anthers expense — debited at the
		// refund event, distinct from the invoice-paid fee debit.
		expect(
			pkg.entry.lines.find(
				(l) => l.account === "Payment processing expense" && l.event === "A refund or chargeback",
			),
		).toMatchObject({ debit: "0.88" });
		expect(line(pkg, "A refund or chargeback", "Support collected not yet settled")).toMatchObject({
			debit: "8.00",
		});
		expect(line(pkg, "A refund or chargeback", "Badge revenue")).toMatchObject({ debit: "4.00" });

		// Debits equal credits, and the package says so.
		expect(pkg.entry.totalDebits).toBe(pkg.entry.totalCredits);
		expect(pkg.entry.balanced).toBe(true);

		// The schedules tie every figure to its rows, with counts and totals.
		expect(pkg.schedules.invoices.count).toBe(3);
		expect(pkg.schedules.invoices.totals.subtotal).toBe("34.00");
		expect(pkg.schedules.purchases.count).toBe(2);
		expect(pkg.schedules.purchases.totals.creatorEarnings).toBe("28.53");
		const supportCredit = pkg.schedules.settlement.credits.find(
			(c) => c.kind === "support" && c.fundedBy === "supporter",
		);
		expect(supportCredit).toMatchObject({ count: 1, total: "9.71" });
		const freePool = pkg.schedules.settlement.credits.find(
			(c) => c.kind === "time_pool" && c.fundedBy === "anthers",
		);
		expect(freePool).toMatchObject({ total: "0.25" });

		// The clearing control is entry-implied and says it cannot verify Stripe's number.
		expect(pkg.controls.stripeClearing.verifiable).toBe(false);
		expect(pkg.controls.stripeClearing.monthMovement).toBe("18.06");

		// The Due-to-creators control ties to the ledger rows.
		expect(pkg.controls.dueToCreators.movement).toBe("12.96");
		expect(pkg.controls.dueToCreators.expected).toBe("12.96");
		expect(pkg.controls.dueToCreators.pass).toBe(true);

		// The unbuilt events are stated as zero lines with their why, never invented.
		const unbuilt = pkg.entry.lines.filter((l) => l.unbuilt);
		expect(unbuilt.length).toBe(4);
		expect(unbuilt.every((l) => l.debit === "0.00" && l.credit === "0.00")).toBe(true);
		expect(unbuilt.some((l) => l.event.includes("transfer"))).toBe(true);
		expect(unbuilt.some((l) => l.event.includes("payout fees"))).toBe(true);
		// The boundary is stated in the notes too, with the liability terms the decision uses.
		expect(pkg.notes.some((n) => n.includes("never touch the profit and loss"))).toBe(true);
		expect(pkg.notes.some((n) => n.includes("are not built yet"))).toBe(true);
	});

	it("fails the Due-to-creators control plainly when the ledger disagrees", async () => {
		// A credit for a cycle after the month being closed: regenerating an old package
		// after later months settled is one of the two causes the control's note names.
		await insertCredit("support", "supporter", "4.44", "2019-12-01");
		const pkg = await body(PERIOD);
		expect(pkg.controls.dueToCreators.pass).toBe(false);
		expect(pkg.controls.dueToCreators.difference).toBe("4.44");
		// The entry itself still balances — the disagreement is in the control, not the lines.
		expect(pkg.entry.balanced).toBe(true);
		await db.delete(creatorCredits).where(eq(creatorCredits.billingCycle, "2019-12-01"));
	});
});

// The rows this suite wrote go by their own keys, in afterAll on success or failure — the
// fixture-account purge takes the invoices, purchases and credits with the accounts, but the
// settlement markers name a month and nothing else deletes them.
afterAll(async () => {
	if (savedAdminUrl === undefined) delete process.env.ADMIN_URL;
	else process.env.ADMIN_URL = savedAdminUrl;

	for (const id of invoiceStripeIds) {
		await db.delete(invoices).where(eq(invoices.stripeInvoiceId, id));
	}
	for (const pi of intentIds) {
		await db.delete(purchases).where(eq(purchases.stripePaymentIntentId, pi));
	}
	for (const cycle of markedCycles) {
		await db.delete(monthSettlements).where(eq(monthSettlements.billingCycle, cycle));
	}
	await db.delete(creatorCredits).where(eq(creatorCredits.billingCycle, CYCLE));
	await db.delete(creatorCredits).where(eq(creatorCredits.billingCycle, "2019-12-01"));
});
