// SPDX-License-Identifier: Apache-2.0
/**
 * Recording what Anthers actually collected — the subledger the books are closed from.
 *
 * ⭐ **Anthers' own tables are the subledger and QuickBooks Online is the general ledger**
 * (Parker, 2026-09-15). Nothing syncs transaction by transaction; the admin app produces a
 * monthly close package of about eight journal lines and reads its schedules from here. So an
 * invoice row carries every figure that entry needs, recorded when it was true.
 *
 * 🚨 **Nothing is credited to a creator from an invoice that has not been paid**, which is the
 * defect this exists to fix: `distribute-pool` credited a whole period's Time Pool from its
 * first night whether or not the renewal was ever collected, and nothing recorded an invoice at
 * all. A row appears here when Stripe says the money arrived, and settlement reads only rows
 * that exist.
 */
import { db } from "@anthers/db/client";
import { accounts, invoiceLines, invoices } from "@anthers/db/schema";
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";
import { itemsFromSub } from "./billing.js";

/** Cents as Stripe reports them, in the dollars the columns hold. */
const dollars = (cents: number) => new Decimal(cents).dividedBy(100).toDecimalPlaces(2);

/**
 * Record a paid invoice and its per-destination split. Returns the row id, or null when there
 * was nothing to record.
 *
 * ⚠️ **Idempotent on Stripe's invoice id**, because a webhook is retried and `invoice.paid`
 * can arrive more than once. The unique constraint is the mechanism rather than a check
 * beforehand, so two concurrent deliveries cannot both pass a lookup and then both insert.
 */
export async function recordPaidInvoice(invoice: Stripe.Invoice): Promise<number | null> {
	if (invoice.status !== "paid" || !invoice.id) return null;

	const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
	if (!customerId) return null;

	const [acct] = await db
		.select({ userId: accounts.userId })
		.from(accounts)
		.where(eq(accounts.stripeCustomerId, customerId))
		.limit(1);
	if (!acct) return null;

	// 🚨 The month this invoice PAYS FOR, read from the period it covers. A mid-month start is
	// charged in full for the month it joins and its reduced renewal pays for the next one, so
	// keying this by payment date would credit the wrong month's viewing — for every account
	// that ever started mid-month, silently, with every total still adding up.
	const billingCycle = cycleKeyFor(new Date((invoice.period_start ?? 0) * 1000));

	const discount = dollars(
		(invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + (d.amount ?? 0), 0),
	);
	const tax = dollars((invoice.total_taxes ?? []).reduce((sum, t) => sum + (t.amount ?? 0), 0));
	const total = dollars(invoice.total ?? 0);
	// What the lines came to net of their discounts — `total` less the tax that was added on
	// top of it, which is the one thing added on top (the wiki's *The Support Model*).
	const subtotal = total.minus(tax);

	const [row] = await db
		.insert(invoices)
		.values({
			userId: acct.userId,
			stripeInvoiceId: invoice.id,
			billingCycle,
			status: "paid",
			subtotal: subtotal.toFixed(2),
			discount: discount.toFixed(2),
			tax: tax.toFixed(2),
			total: total.toFixed(2),
			processingFee: (await processingFeeFor(invoice)).toFixed(2),
			paidAt: new Date((invoice.status_transitions?.paid_at ?? invoice.created) * 1000),
		})
		// A redelivered event finds the row already there and changes nothing.
		.onConflictDoNothing({ target: invoices.stripeInvoiceId })
		.returning({ id: invoices.id });
	if (!row) return null;

	await recordLines(row.id, invoice, subtotal);
	return row.id;
}

/**
 * The per-destination split, which is what makes a creator's credit legible rather than
 * derived.
 *
 * 🚨 **The destination comes from the SUBSCRIPTION's items, not from the invoice line's own
 * metadata.** Stripe documents a subscription line's `metadata` as reflecting the
 * subscription's, which is a different object from the subscription *item* whose stamp
 * `itemsFromSub` reads — and crediting the wrong side is silent, because both are plausible
 * numbers on a well-formed invoice.
 */
async function recordLines(
	invoiceId: number,
	invoice: Stripe.Invoice,
	subtotal: Decimal,
): Promise<void> {
	const stripe = getStripe();
	const subscriptionId = subscriptionOf(invoice);
	const creatorOfItem = new Map<string, number | null>();
	if (stripe && subscriptionId) {
		const sub = await stripe.subscriptions.retrieve(subscriptionId);
		for (const item of itemsFromSub(sub)) creatorOfItem.set(item.itemId, item.creatorId);
	}

	const byCreator = new Map<number | null, Decimal>();
	for (const line of invoice.lines?.data ?? []) {
		const itemId = line.parent?.subscription_item_details?.subscription_item;
		// An unmapped line is credited to Anthers, which is `itemsFromSub`'s documented
		// fallback for an unstamped item and the migration path for an older subscription.
		const creatorId = itemId ? (creatorOfItem.get(itemId) ?? null) : null;
		const amount = dollars(line.amount ?? 0);
		byCreator.set(creatorId, (byCreator.get(creatorId) ?? new Decimal(0)).plus(amount));
	}

	const rows = [...byCreator.entries()]
		.filter(([, amount]) => !amount.isZero())
		.map(([creatorId, amount]) => ({ invoiceId, creatorId, amount: amount.toFixed(2) }));
	if (rows.length > 0) await db.insert(invoiceLines).values(rows);

	/**
	 * ⚠️ **The lines must reconstruct the subtotal, and a mismatch is reported rather than
	 * corrected.** Stripe's exact division between line-level and invoice-level discounts is
	 * the part of this most likely to be subtly wrong, and a settlement built on lines that do
	 * not add up to what was collected would move real money by the difference. Anthers is
	 * pre-launch, so the honest response to a disagreement is a loud log and a row that still
	 * records what Stripe said — never a silent adjustment that makes the sum work.
	 */
	const lineTotal = rows.reduce((sum, r) => sum.plus(r.amount), new Decimal(0));
	if (!lineTotal.equals(subtotal)) {
		console.error(
			`invoice ${invoice.id}: lines sum to $${lineTotal.toFixed(2)} but the subtotal is $${subtotal.toFixed(2)} — settlement would credit the difference to nobody. Check how this invoice's discounts were applied.`,
		);
	}
}

/**
 * What Stripe actually took, read from the balance transaction.
 *
 * 🚨 **Stripe's own figure, never `cardFee()`.** One of the two reconciliation controls in the
 * bookkeeping decision is that the Stripe clearing balance in the general ledger equals
 * Stripe's reported balance at period end, and that only holds if the expense booked is the
 * expense charged. `cardFee()` is the *model* — what the buyer's price was built to absorb —
 * and it is a rate that can change, so a settlement recomputing it would restate history every
 * time the rate moved.
 *
 * Falls back to zero rather than to an estimate when the charge cannot be read: a zero is
 * visibly missing in a reconciliation, where a plausible estimate is not.
 */
async function processingFeeFor(invoice: Stripe.Invoice): Promise<Decimal> {
	const stripe = getStripe();
	if (!stripe) return new Decimal(0);
	const payment = invoice.payments?.data?.[0]?.payment;
	const chargeId =
		typeof payment?.charge === "string" ? payment.charge : (payment?.charge?.id ?? null);
	if (!chargeId) return new Decimal(0);
	try {
		const charge = await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] });
		const bt = charge.balance_transaction;
		if (bt && typeof bt !== "string") return dollars(bt.fee ?? 0);
	} catch (error) {
		console.error(`invoice ${invoice.id}: could not read the processing fee:`, error);
	}
	return new Decimal(0);
}

/**
 * The subscription an invoice belongs to.
 *
 * ⚠️ **Read from `parent`, not from a top-level `subscription` field**, which moved in the
 * 2025-03 API version. Both are read so a replayed older event is not silently ignored.
 */
function subscriptionOf(invoice: Stripe.Invoice): string | null {
	const fromParent = invoice.parent?.subscription_details?.subscription;
	if (fromParent) return typeof fromParent === "string" ? fromParent : fromParent.id;
	const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
	if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
	return null;
}
