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
import { accounts, invoiceLines, invoices, users } from "@anthers/db/schema";
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";
import { itemsFromSub } from "./billing.js";
import { allInvoiceLines, cycleInvoicePaysFor } from "./stripe-invoice.js";

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

	/**
	 * 🚨 **A RENEWAL whose supporter is suspended is not recorded, and not charged for.**
	 * The account keeps its Stripe subscription for the whole suspension — nothing is
	 * `cancel_at_period_end`'d away, and the renewal fires and is paid on the card on
	 * file — but it credits nobody: suspension stops the support's earnings from accruing,
	 * and a renewal recorded here and settled would credit them anyway. So it is dropped
	 * on the way in and the money is simply unbooked — which is why a suspended
	 * subscriber's renewal is NOT refunded by this (they already have it, and refunds are
	 * initiated by the person or a refund path, not by moderation).
	 *
	 * The pause is read off the ACCOUNT ROW rather than computed per charge, and the
	 * resume is its mirror: the row is written HERE with status `paused` rather than
	 * refused, so the Stripe id, the amount and the month it paid for are on the books
	 * and the months that ran under suspension are legible — which a deleted record would
	 * erase. `resumePausedRenewals` re-keys the paused rows at reinstatement against the
	 * month it lands in, which is where their credits actually run. "Not deleting, not
	 * canceling" is the design: this row is what it looks like written down.
	 *
	 * Only `subscription_cycle` invoices are paused. A mid-month start charged today was
	 * paid for days the account was in good standing, and that money is already owed to
	 * the destinations it names — withholding it would be a forfeiture path dressed as a
	 * moderation one.
	 */
	let paused = false;
	if (invoice.billing_reason === "subscription_cycle") {
		const [holder] = await db
			.select({ suspendedAt: users.suspendedAt })
			.from(users)
			.where(eq(users.id, acct.userId))
			.limit(1);
		paused = holder?.suspendedAt != null;
	}

	// 🚨 The month this invoice PAYS FOR, read from its lines. A mid-month start is charged in
	// full for the month it joins and its reduced renewal pays for the next one, so keying this
	// by payment date — or by `invoice.period_start`, which on a renewal is the month before —
	// would credit the wrong month's viewing, silently, with every total still adding up.
	const billingCycle = cycleInvoicePaysFor(invoice);

	const discount = dollars(
		(invoice.total_discount_amounts ?? []).reduce((sum, d) => sum + (d.amount ?? 0), 0),
	);
	const tax = dollars((invoice.total_taxes ?? []).reduce((sum, t) => sum + (t.amount ?? 0), 0));
	const total = dollars(invoice.total ?? 0);
	// What the lines came to net of their discounts — `total` less the tax that was added on
	// top of it, which is the one thing added on top (the wiki's *The Support Model*).
	const subtotal = total.minus(tax);

	const payment = await paymentOf(invoice.id);

	const [row] = await db
		.insert(invoices)
		.values({
			userId: acct.userId,
			stripeInvoiceId: invoice.id,
			stripePaymentIntentId: payment.paymentIntentId,
			billingCycle,
			// A paused renewal is on the books but settles nowhere — `settle-cycle` reads
			// `paid` only, and reinstatement re-keys it rather than re-recording it.
			status: paused ? "paused" : "paid",
			subtotal: subtotal.toFixed(2),
			discount: discount.toFixed(2),
			tax: tax.toFixed(2),
			total: total.toFixed(2),
			processingFee: (await processingFeeFor(invoice.id, payment)).toFixed(2),
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
	for (const line of await allInvoiceLines(invoice)) {
		const itemId = line.parent?.subscription_item_details?.subscription_item;
		// An unmapped line is credited to Anthers, which is `itemsFromSub`'s documented
		// fallback for an unstamped item and the migration path for an older subscription.
		const creatorId = itemId ? (creatorOfItem.get(itemId) ?? null) : null;
		// 🚨 **Net of its discounts.** A line's `amount` is what it came to BEFORE the day-exact
		// reduction was spent on it; what was actually charged for it is that less its
		// `discount_amounts`. Crediting `amount` alone pays a creator the reduction the supporter
		// was given back.
		const discounted = (line.discount_amounts ?? []).reduce((sum, d) => sum + (d.amount ?? 0), 0);
		const amount = dollars((line.amount ?? 0) - discounted);
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

/** How an invoice was paid, as the ids a fee lookup, a refund and a dispute each need. */
interface InvoicePaymentRef {
	paymentIntentId: string | null;
	chargeId: string | null;
}

/**
 * The payment that paid an invoice, asked of Stripe rather than read off the event.
 *
 * 🚨 **`invoice.payments` is not in a webhook's payload.** Stripe documents it as an *includable*
 * property, present only when a request asks for it, so an `invoice.paid` event arrives without it
 * and a fee read from it is zero on every real invoice while a hand-built test invoice carrying the
 * field passes. The invoice's payments are listed instead.
 */
async function paymentOf(invoiceId: string): Promise<InvoicePaymentRef> {
	const none = { paymentIntentId: null, chargeId: null };
	const stripe = getStripe();
	if (!stripe) return none;
	try {
		const list = await stripe.invoicePayments.list({
			invoice: invoiceId,
			status: "paid",
			limit: 1,
		});
		const payment = list.data[0]?.payment;
		if (!payment) return none;
		const idOf = (ref: string | { id: string } | undefined) =>
			ref == null ? null : typeof ref === "string" ? ref : ref.id;
		return { paymentIntentId: idOf(payment.payment_intent), chargeId: idOf(payment.charge) };
	} catch (error) {
		console.error(`invoice ${invoiceId}: could not read its payment:`, error);
		return none;
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
 * visibly missing in a reconciliation, where a plausible estimate is not. Settlement says so
 * out loud when it meets one.
 */
async function processingFeeFor(invoiceId: string, payment: InvoicePaymentRef): Promise<Decimal> {
	const stripe = getStripe();
	if (!stripe) return new Decimal(0);
	try {
		let bt: string | Stripe.BalanceTransaction | null | undefined;
		if (payment.paymentIntentId) {
			const intent = await stripe.paymentIntents.retrieve(payment.paymentIntentId, {
				expand: ["latest_charge.balance_transaction"],
			});
			const charge = intent.latest_charge;
			bt = charge && typeof charge !== "string" ? charge.balance_transaction : null;
		} else if (payment.chargeId) {
			const charge = await stripe.charges.retrieve(payment.chargeId, {
				expand: ["balance_transaction"],
			});
			bt = charge.balance_transaction;
		}
		if (bt && typeof bt !== "string") return dollars(bt.fee ?? 0);
	} catch (error) {
		console.error(`invoice ${invoiceId}: could not read the processing fee:`, error);
	}
	return new Decimal(0);
}

/**
 * Record that a paid invoice's money went back — a full refund or a dispute. Returns how many
 * invoices changed.
 *
 * 🚨 **Before settlement this is the whole of what a refund needs**, because settlement credits
 * only `paid` invoices and a month that has not settled simply never credits this one. After
 * settlement the credits already exist, and reversing or netting them is the netting build's to do;
 * the status is what it reads.
 *
 * ⚠️ **Keyed on the payment intent**, because neither a refunded charge nor a dispute names the
 * invoice it paid. A payment intent Anthers recorded no invoice for — a Work purchase — changes
 * nothing here.
 */
export async function markInvoiceMoneyReturned(
	paymentIntentId: string,
	status: "refunded" | "disputed",
): Promise<number> {
	const rows = await db
		.update(invoices)
		.set({ status, updatedAt: new Date() })
		.where(and(eq(invoices.stripePaymentIntentId, paymentIntentId), eq(invoices.status, "paid")))
		.returning({ id: invoices.id });
	return rows.length;
}

/**
 * Re-key a suspended account's paid renewals against the month reinstatement lands
 * in, so settlement credits them from the month that is settling rather than the
 * months the suspension ran over. Called from `unsuspendAccount`; returns how many
 * renewals were resumed.
 *
 * 🚨 **Re-keyed rather than re-recorded.** The renewal was paid on the card on file
 * and dropped by `recordPaidInvoice` while it was owed to nobody — its Stripe invoice
 * id and amount are the record, so re-deriving either from a lookup would be a second
 * truth beside the one Stripe holds. The rows here are ones the pause wrote as
 * `paused`: present in the subledger, credited nowhere, and findable by that status
 * alone rather than by any arithmetic on dates. A renewal resumed twice is a no-op
 * because reinstatement has already moved its status off `paused`.
 *
 * Only renewal invoices are ever candidates: a mid-month start was recorded through
 * the pause (see `recordPaidInvoice`) and already sits against the month it joined.
 */
export async function resumePausedRenewals(userId: number, at: Date): Promise<number> {
	const cycle = cycleKeyFor(at);
	const resumed = await db
		.update(invoices)
		.set({ billingCycle: cycle, status: "paid", updatedAt: new Date() })
		.where(and(eq(invoices.userId, userId), eq(invoices.status, "paused")))
		.returning({ id: invoices.id });
	return resumed.length;
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
