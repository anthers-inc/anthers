// SPDX-License-Identifier: Apache-2.0
/**
 * The subledger — what a paid invoice records, and what it deliberately does not.
 *
 * 🚨 **The figure worth guarding hardest is `billing_cycle`**, because getting it wrong is
 * silent and expensive: it is the month the invoice PAYS FOR, never the month the money
 * arrived. A mid-month start is charged in full for the month it joins, and its reduced
 * renewal on the 1st pays for the next one — so keying by payment date would credit the wrong
 * month's viewing for every account that ever started mid-month, with every total still
 * adding up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, invoiceLines, invoices, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe, setStripeClient } from "../lib/stripe";
import { markInvoiceMoneyReturned, recordPaidInvoice } from "../services/invoices";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
const CUSTOMER = `cus_invoice_${run}`;
const SUB_ID = `sub_invoice_${run}`;
const PAYMENT_INTENT = `pi_EXAMPLE_${run}`;
/** What the fake Stripe lists when an invoice says it has more lines than it embeds. */
let listedLines: unknown[] = [];

let realClient: Stripe | null;
let supporterId: number;
let creatorId: number;

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** A Stripe client covering only what `recordPaidInvoice` reaches for. */
function fakeStripe(feeCents = 59) {
	return {
		subscriptions: {
			retrieve: async () => ({
				id: SUB_ID,
				items: {
					data: [
						{
							id: "si_anthers",
							quantity: 1,
							price: { unit_amount: 600 },
							metadata: { destination: "anthers" },
						},
						{
							id: "si_creator",
							quantity: 1,
							price: { unit_amount: 400 },
							metadata: { destination: String(creatorId) },
						},
					],
				},
			}),
		},
		// The invoice's payment is listed rather than read off the event, which never carries it.
		invoicePayments: {
			list: async () => ({
				data: [{ payment: { type: "payment_intent", payment_intent: PAYMENT_INTENT } }],
			}),
		},
		invoices: {
			listLineItems: () => ({
				async *[Symbol.asyncIterator]() {
					yield* listedLines;
				},
			}),
		},
		paymentIntents: {
			retrieve: async () => ({ latest_charge: { balance_transaction: { fee: feeCents } } }),
		},
	} as unknown as Stripe;
}

/** One month before a unix time, as Stripe dates a renewal invoice's own period. */
const monthBefore = (unix: number) => {
	const d = new Date(unix * 1000);
	return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000);
};

/**
 * A paid invoice in the shape Stripe sends it.
 *
 * 🚨 **The invoice's own `period_start` is the month BEFORE the one it pays for**, as Stripe sets
 * it on every renewal, and only the lines' `period` names the month paid for. A fixture putting
 * the paid-for month on `period_start` is how a recorder reading that field passed every test
 * here and credited real renewals to the wrong month.
 */
function paidInvoice(opts: {
	id?: string;
	/** The month the invoice pays for, which only its lines say. */
	paysFor?: number;
	lines?: { item: string; dollars: number; discountCents?: number }[];
	taxCents?: number;
	discountCents?: number;
	totalCents?: number;
	status?: string;
}) {
	const lines = opts.lines ?? [
		{ item: "si_anthers", dollars: 6 },
		{ item: "si_creator", dollars: 4 },
	];
	const taxCents = opts.taxCents ?? 0;
	const lineCents = lines.reduce(
		(s, l) => s + Math.round(l.dollars * 100) - (l.discountCents ?? 0),
		0,
	);
	const paysFor = opts.paysFor ?? Math.floor(Date.UTC(2026, 9, 1) / 1000);
	return {
		id: opts.id ?? `in_${uid()}`,
		object: "invoice",
		status: opts.status ?? "paid",
		customer: CUSTOMER,
		period_start: monthBefore(paysFor),
		period_end: paysFor,
		created: Math.floor(Date.UTC(2026, 9, 1) / 1000),
		status_transitions: { paid_at: Math.floor(Date.UTC(2026, 9, 1, 3) / 1000) },
		total: opts.totalCents ?? lineCents + taxCents,
		total_taxes: taxCents > 0 ? [{ amount: taxCents }] : [],
		total_discount_amounts: opts.discountCents ? [{ amount: opts.discountCents }] : [],
		parent: { subscription_details: { subscription: SUB_ID } },
		lines: {
			data: lines.map((l) => ({
				id: `il_${l.item}`,
				// Before its discount, as Stripe reports a line; the discount is beside it.
				amount: Math.round(l.dollars * 100),
				discount_amounts: l.discountCents
					? [{ amount: l.discountCents, discount: "di_EXAMPLE" }]
					: [],
				period: { start: paysFor, end: paysFor + 30 * 86400 },
				parent: {
					type: "subscription_item_details",
					subscription_item_details: { subscription_item: l.item, proration: false },
				},
			})),
			has_more: false,
		},
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built subset of Stripe's type
	} as any;
}

beforeAll(async () => {
	realClient = getStripe();
	const supporter = await createAccount(`inv_sub_${run}`);
	const creator = await createAccount(`inv_creator_${run}`);
	const [s] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, `inv_sub_${run}`));
	const [c] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, `inv_creator_${run}`));
	supporterId = s.id;
	creatorId = c.id;
	void supporter;
	void creator;
	await db
		.insert(accounts)
		.values({ userId: supporterId, stripeCustomerId: CUSTOMER })
		.onConflictDoUpdate({ target: accounts.userId, set: { stripeCustomerId: CUSTOMER } });
	setStripeClient(fakeStripe());
}, DB_SETUP_TIMEOUT);

afterAll(() => {
	setStripeClient(realClient);
});

beforeEach(async () => {
	await db.delete(invoices).where(eq(invoices.userId, supporterId));
});

async function rowFor(stripeId: string) {
	const [row] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, stripeId));
	return row;
}

describe("recording a paid invoice", () => {
	it("keys the month the invoice PAYS FOR, not the month it was paid in", async () => {
		// Period opens 1 October; the charge clears in the small hours of 1 October UTC. Both
		// point at October here, which is the ordinary case — the next test is the one that
		// separates them.
		const invoice = paidInvoice({ paysFor: Math.floor(Date.UTC(2026, 9, 1) / 1000) });
		// The invoice's own period says September, exactly as Stripe dates an October renewal.
		expect(new Date(invoice.period_start * 1000).getUTCMonth()).toBe(8);
		await recordPaidInvoice(invoice);
		expect((await rowFor(invoice.id)).billingCycle).toBe("2026-10-01");
	});

	it("credits a late-paid invoice to the month it paid for", async () => {
		// A September renewal that failed and finally cleared in October belongs to September,
		// against September's recorded time. Keying by payment date would pay October's
		// creators with September's money.
		const invoice = paidInvoice({
			paysFor: Math.floor(Date.UTC(2026, 8, 1) / 1000),
		});
		invoice.status_transitions = { paid_at: Math.floor(Date.UTC(2026, 9, 12) / 1000) };
		await recordPaidInvoice(invoice);
		const row = await rowFor(invoice.id);
		expect(row.billingCycle).toBe("2026-09-01");
		expect(new Date(row.paidAt as Date).getUTCMonth()).toBe(9); // October
	});

	it("🚨 credits each line what was charged for it, net of its discount", async () => {
		// A renewal carrying the day-exact reduction: each line's `amount` is still the full
		// price, and its discount sits beside it. Crediting the amount pays a creator the money
		// the supporter was given back.
		const invoice = paidInvoice({
			lines: [
				{ item: "si_anthers", dollars: 6, discountCents: 300 },
				{ item: "si_creator", dollars: 4, discountCents: 200 },
			],
		});
		const id = await recordPaidInvoice(invoice);
		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, id ?? 0));
		const byCreator = Object.fromEntries(
			lines.map((l) => [l.creatorId === null ? "anthers" : String(l.creatorId), Number(l.amount)]),
		);
		expect(byCreator).toEqual({ anthers: 3, [String(creatorId)]: 2 });
		expect(Number((await rowFor(invoice.id)).subtotal)).toBe(5);
	});

	it("reads every line, beyond the ten an invoice carries", async () => {
		const invoice = paidInvoice({});
		// Stripe embeds the first lines and says there are more; the rest are listed.
		listedLines = invoice.lines.data;
		invoice.lines = { data: invoice.lines.data.slice(0, 1), has_more: true };
		const id = await recordPaidInvoice(invoice);
		listedLines = [];
		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, id ?? 0));
		expect(lines).toHaveLength(2);
	});

	it("splits the charge by destination, so a creator's credit is legible", async () => {
		const invoice = paidInvoice({});
		const id = await recordPaidInvoice(invoice);
		const lines = await db
			.select()
			.from(invoiceLines)
			.where(eq(invoiceLines.invoiceId, id ?? 0));
		const byCreator = Object.fromEntries(
			lines.map((l) => [l.creatorId === null ? "anthers" : String(l.creatorId), Number(l.amount)]),
		);
		expect(byCreator).toEqual({ anthers: 6, [String(creatorId)]: 4 });
	});

	it("records tax separately, because tax is the only thing added on top", async () => {
		const invoice = paidInvoice({ taxCents: 92 });
		await recordPaidInvoice(invoice);
		const row = await rowFor(invoice.id);
		expect(Number(row.tax)).toBeCloseTo(0.92, 2);
		expect(Number(row.subtotal)).toBeCloseTo(10, 2);
		expect(Number(row.total)).toBeCloseTo(10.92, 2);
		// The parts have to reconstruct what the card was charged, or the close package's
		// Stripe-clearing control cannot tie out.
		expect(Number(row.subtotal) + Number(row.tax)).toBeCloseTo(Number(row.total), 2);
	});

	/**
	 * 🚨 Stripe's own figure, never `cardFee()`. The bookkeeping decision's reconciliation
	 * control is that Stripe clearing in the general ledger equals Stripe's reported balance,
	 * and that only holds if the expense booked is the expense charged.
	 */
	it("records what Stripe actually took, from a payment the webhook's invoice does not carry", async () => {
		// The invoice here has no `payments`, exactly as an `invoice.paid` event delivers it.
		setStripeClient(fakeStripe(59));
		const invoice = paidInvoice({});
		await recordPaidInvoice(invoice);
		const row = await rowFor(invoice.id);
		expect(Number(row.processingFee)).toBeCloseTo(0.59, 2);
		// And the payment intent a refund or a dispute will name, since neither names the invoice.
		expect(row.stripePaymentIntentId).toBe(PAYMENT_INTENT);
	});

	it("is idempotent, because Stripe retries a webhook", async () => {
		const invoice = paidInvoice({});
		expect(await recordPaidInvoice(invoice)).not.toBeNull();
		expect(await recordPaidInvoice(invoice)).toBeNull();
		const rows = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoice.id));
		expect(rows).toHaveLength(1);
	});

	it("records nothing for an invoice that is not paid", async () => {
		// A renewal inside Stripe's retry window produces no row at all, which is what lets it
		// be credited later against the month it paid for rather than the month it arrived.
		const invoice = paidInvoice({ status: "open" });
		expect(await recordPaidInvoice(invoice)).toBeNull();
		expect(await rowFor(invoice.id)).toBeUndefined();
	});

	it("records nothing for a customer Anthers does not know", async () => {
		const invoice = paidInvoice({});
		invoice.customer = "cus_a_stranger";
		expect(await recordPaidInvoice(invoice)).toBeNull();
	});

	it("leaves an invoice unsettled when it is written", async () => {
		// Settlement is a separate act. A row that arrived already settled would be credited
		// before anybody decided the month was closed.
		const invoice = paidInvoice({});
		await recordPaidInvoice(invoice);
		expect((await rowFor(invoice.id)).settledAt).toBeNull();
	});
});

describe("money that goes back after an invoice was paid", () => {
	it("marks the invoice a refund or a dispute names, so settlement never credits it", async () => {
		const invoice = paidInvoice({});
		await recordPaidInvoice(invoice);

		expect(await markInvoiceMoneyReturned(PAYMENT_INTENT, "disputed")).toBe(1);
		expect((await rowFor(invoice.id)).status).toBe("disputed");
	});

	it("changes nothing for a payment intent that paid no invoice", async () => {
		const invoice = paidInvoice({});
		await recordPaidInvoice(invoice);

		// A Work purchase's refund arrives through the same event, and is not an invoice's.
		expect(await markInvoiceMoneyReturned("pi_EXAMPLE_a_purchase", "refunded")).toBe(0);
		expect((await rowFor(invoice.id)).status).toBe("paid");
	});
});
