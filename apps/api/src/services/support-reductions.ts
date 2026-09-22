// SPDX-License-Identifier: Apache-2.0
/**
 * The day-exact reduction — recording what a mid-month start costs, and spending it.
 *
 * Anything started or raised mid-month is charged **in full** that day, because a prorated
 * sliver would let somebody clear a gate for a day's price at the end of a month, take what is
 * behind it and cancel. The days before it began come off the next charge on the 1st instead,
 * which is this module: `recordReductions` writes what is owed, and `applyReductionsToInvoice`
 * spends it against the renewal while Stripe is still holding that invoice as a draft.
 *
 * 🚨 **Per LINE, never one coupon on the invoice**, and that is load-bearing rather than
 * fussy. Each line is a different destination, and settlement credits each creator what the
 * supporter actually paid *them* — so a single invoice-level discount would make every
 * creator's credit depend on an arithmetic nobody can see from the invoice. The lines are how
 * the discount stays attributable.
 *
 * ⚠️ **Why Anthers records these at all**, rather than attaching a coupon to the subscription
 * when the raise happens: a coupon on the subscription is consumed by whichever invoice comes
 * next, and for a mid-month raise that is the immediate invoice — so it would discount the
 * very charge it exists to compensate for. The reduction has to wait somewhere Stripe cannot
 * spend it, which is `support_reductions`.
 */
import { db } from "@anthers/db/client";
import { accounts, supportReductions, users } from "@anthers/db/schema";
import { cycleKeyFor, nextCycleKey, reductionFor } from "@anthers/shared/billing-cycle";
import { STRIPE_MIN_CHARGE } from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { and, asc, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";
import { itemsFromSub } from "./billing.js";
import { allInvoiceLines, cycleInvoicePaysFor } from "./stripe-invoice.js";

/** Money in the shape the columns hold it. */
const money = (d: Decimal.Value) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * The destination label a reduction is keyed by — the same vocabulary as a subscription
 * item's `metadata.destination`, because the two are compared directly.
 */
function destinationLabel(creatorId: number | null): string {
	return creatorId === null ? "anthers" : String(creatorId);
}

/** One line's worth of what somebody just started paying for. */
export interface StartedLine {
	/** `null` for the Anthers line, a creator's user id otherwise. */
	creatorId: number | null;
	/** The monthly amount in dollars this line will renew at. */
	amount: number;
}

/**
 * Record what a mid-month start or raise owes back, against next month's invoice.
 *
 * Called with the lines that **began or grew** today — never with a line that was already
 * being paid for at the same amount, which is owed nothing, and never with a line that went
 * down, which takes effect on the 1st and so was never charged for days it did not run.
 *
 * A start on the 1st owes nothing and writes nothing, which is the common case once the
 * renewal rule has been in force for a month.
 */
export async function recordReductions(
	userId: number,
	startedOn: Date,
	lines: StartedLine[],
): Promise<void> {
	const cycle = nextCycleKey(cycleKeyFor(startedOn));
	const rows = lines
		.map((line) => ({
			userId,
			billingCycle: cycle,
			destination: destinationLabel(line.creatorId),
			amount: reductionFor(line.amount, startedOn),
		}))
		// A zero reduction is not a row. Writing one would make "owed nothing" and "owed
		// something that happened to round to nothing" the same record, and the apply pass
		// below would then have to know the difference.
		.filter((row) => row.amount.greaterThan(0))
		.map((row) => ({ ...row, amount: row.amount.toFixed(2) }));

	if (rows.length === 0) return;
	await db.insert(supportReductions).values(rows);
}

/** An unapplied reduction, as the apply pass reads it. */
interface Owed {
	id: number;
	destination: string;
	amount: Decimal;
}

/**
 * Spend everything this account has owed against a draft renewal invoice.
 *
 * Returns the number of lines discounted, so a caller can log something true. Silent and
 * harmless when there is nothing owed, which is the overwhelming majority of invoices.
 */
export async function applyReductionsToInvoice(invoice: Stripe.Invoice): Promise<number> {
	const stripe = getStripe();
	if (!stripe) return 0;

	// Only a draft can still be changed, and only a renewal has lines a reduction belongs
	// against. The invoice for a mid-month raise is deliberately excluded: it is the charge
	// the reduction exists to compensate for, and discounting it here would be paying the
	// money back before it was taken.
	if (invoice.status !== "draft" || invoice.billing_reason !== "subscription_cycle") return 0;
	if (!invoice.id) return 0;

	const subscriptionId = subscriptionOf(invoice);
	if (!subscriptionId) return 0;

	const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
	if (!customerId) return 0;

	const [acct] = await db
		.select({ userId: accounts.userId })
		.from(accounts)
		.where(eq(accounts.stripeCustomerId, customerId))
		.limit(1);
	if (!acct) return 0;

	/**
	 * A suspended supporter's renewal credits nobody — `recordPaidInvoice` drops it on
	 * the way in — so a reduction spent on one is a coupon minted against a charge that
	 * exists only to be discarded. Settle the rows as applied and name them against the
	 * invoice they reached; the money they recorded was owed against days the account was
	 * NOT suspended, which is preserved in `recordReductions`'s rows rather than spent
	 * here.
	 */
	const [holder] = await db
		.select({ suspendedAt: users.suspendedAt })
		.from(users)
		.where(eq(users.id, acct.userId))
		.limit(1);
	if (holder?.suspendedAt != null) {
		const now = new Date();
		const cycle = cycleInvoicePaysFor(invoice);
		await db
			.update(supportReductions)
			.set({ appliedAt: now, appliedInvoiceId: invoice.id, updatedAt: now })
			.where(
				and(
					eq(supportReductions.userId, acct.userId),
					eq(supportReductions.billingCycle, cycle),
					isNull(supportReductions.appliedAt),
				),
			);
		return 0;
	}

	// The cycle this invoice PAYS FOR, read from its lines rather than from today's date or from
	// `invoice.period_start` — see `cycleInvoicePaysFor` for why the invoice-level field names
	// the month before.
	const cycle = cycleInvoicePaysFor(invoice);

	const owed = await db
		.select()
		.from(supportReductions)
		.where(
			and(
				eq(supportReductions.userId, acct.userId),
				eq(supportReductions.billingCycle, cycle),
				isNull(supportReductions.appliedAt),
			),
		)
		.orderBy(asc(supportReductions.id));
	if (owed.length === 0) return 0;

	const sub = await stripe.subscriptions.retrieve(subscriptionId);
	const destinationOfItem = new Map(
		itemsFromSub(sub).map((i) => [i.itemId, destinationLabel(i.creatorId)]),
	);

	const lines = spendableLines(await allInvoiceLines(invoice), destinationOfItem);
	if (lines.length === 0) return 0;

	const plan = allocate(
		owed.map((row) => ({
			id: row.id,
			destination: row.destination,
			amount: new Decimal(row.amount),
		})),
		lines,
	);

	// ── Spend it ─────────────────────────────────────────────────────────────
	const updates: { id: string; discounts: [{ coupon: string }] }[] = [];
	for (const [lineId, dollars] of plan.perLine) {
		if (dollars.lessThanOrEqualTo(0)) continue;
		const coupon = await stripe.coupons.create({
			amount_off: dollars.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
			currency: "usd",
			duration: "once",
			// One redemption, because a coupon loose in the account is a discount anybody's
			// next invoice can pick up. It is created for this line and dies with it.
			max_redemptions: 1,
			name: `Days before you started, ${cycle.slice(0, 7)}`,
			metadata: { anthers: "support_reduction", userId: String(acct.userId), cycle },
		});
		updates.push({ id: lineId, discounts: [{ coupon: coupon.id }] });
	}

	if (updates.length > 0) {
		await stripe.invoices.updateLines(invoice.id, { lines: updates });
	}

	// ── Book what was spent, and carry what was not ──────────────────────────
	const now = new Date();
	for (const row of owed) {
		const spent = plan.spentByRow.get(row.id) ?? new Decimal(0);
		// 🚨 The row is settled whether it was spent in full, in part, or not at all, and
		// whatever went unspent becomes a NEW row against the following cycle. Editing
		// `amount` down instead would leave no record that this month's invoice could not
		// absorb it, which is the only thing that explains the carry to somebody reading the
		// two rows later.
		//
		// ⭐ **This is also what makes a redelivered `invoice.created` a no-op.** Stripe
		// retries, and settling every row here means the second delivery finds nothing owed
		// against this cycle — the carry rows it created are keyed to the next one. Without
		// it a retry would mint a second coupon and discount the invoice twice.
		await db
			.update(supportReductions)
			.set({ appliedAt: now, appliedInvoiceId: invoice.id, updatedAt: now })
			.where(eq(supportReductions.id, row.id));

		const unspent = new Decimal(row.amount).minus(spent);
		if (unspent.greaterThan(0)) {
			await db.insert(supportReductions).values({
				userId: acct.userId,
				billingCycle: nextCycleKey(cycle),
				destination: row.destination,
				amount: unspent.toFixed(2),
				carriedFromId: row.id,
			});
		}
	}

	return updates.length;
}

/** A line a discount can actually be attached to, with what it can absorb. */
interface SpendableLine {
	id: string;
	destination: string;
	/** Dollars on the line, which is the most a discount against it may be. */
	amount: Decimal;
}

/**
 * The lines worth discounting, in the order they should be spent against.
 *
 * ⚠️ **A proration line is skipped**, both because Stripe refuses a discount on one and
 * because a proration on a renewal invoice is a mid-month change being trued up — a charge
 * the reduction has nothing to say about.
 */
function spendableLines(
	invoiceLines: Stripe.InvoiceLineItem[],
	destinationOfItem: Map<string, string>,
): SpendableLine[] {
	const lines: SpendableLine[] = [];
	for (const line of invoiceLines) {
		const details = line.parent?.subscription_item_details;
		if (!details || details.proration) continue;
		const destination = destinationOfItem.get(details.subscription_item);
		if (!destination) continue;
		const amount = new Decimal(line.amount).dividedBy(100);
		if (amount.lessThanOrEqualTo(0)) continue;
		lines.push({ id: line.id, destination, amount });
	}
	return lines;
}

/**
 * Decide what comes off each line.
 *
 * Two passes, and the second is the one that matters. **First**, every reduction goes against
 * its own destination's line, which is the attributable case and nearly always the whole of
 * it. **Then** anything left over is spread across whatever headroom remains on the other
 * lines — because a supporter who stopped supporting Alice is still owed the money Anthers
 * took for days Alice had not started, and a reduction keyed to a line that no longer exists
 * would otherwise be owed forever.
 *
 * 🚨 **The whole invoice stays at or above `STRIPE_MIN_CHARGE`.** A start late in the
 * month can owe back nearly the whole of the next charge, and an invoice discounted to nothing
 * is one a processor will not take. What cannot be spent is carried, never dropped.
 */
function allocate(
	owed: Owed[],
	lines: SpendableLine[],
): { perLine: Map<string, Decimal>; spentByRow: Map<number, Decimal> } {
	const subtotal = lines.reduce((sum, l) => sum.plus(l.amount), new Decimal(0));
	let budget = Decimal.max(0, subtotal.minus(STRIPE_MIN_CHARGE));

	const perLine = new Map<string, Decimal>();
	const spentByRow = new Map<number, Decimal>();
	const headroom = new Map(lines.map((l) => [l.id, l.amount]));

	const spend = (line: SpendableLine, row: Owed, remaining: Decimal): Decimal => {
		const take = Decimal.min(remaining, budget, headroom.get(line.id) ?? new Decimal(0));
		if (take.lessThanOrEqualTo(0)) return remaining;
		perLine.set(line.id, (perLine.get(line.id) ?? new Decimal(0)).plus(take));
		spentByRow.set(row.id, (spentByRow.get(row.id) ?? new Decimal(0)).plus(take));
		headroom.set(line.id, (headroom.get(line.id) as Decimal).minus(take));
		budget = budget.minus(take);
		return remaining.minus(take);
	};

	// Pass one — against the line the reduction was earned on.
	const leftover = new Map<number, Decimal>();
	for (const row of owed) {
		let remaining = money(row.amount);
		for (const line of lines.filter((l) => l.destination === row.destination)) {
			remaining = spend(line, row, remaining);
		}
		if (remaining.greaterThan(0)) leftover.set(row.id, remaining);
	}

	// Pass two — against whatever headroom is left anywhere, oldest reduction first.
	for (const row of owed) {
		let remaining = leftover.get(row.id);
		if (!remaining || remaining.lessThanOrEqualTo(0)) continue;
		for (const line of lines) {
			remaining = spend(line, row, remaining);
			if (remaining.lessThanOrEqualTo(0)) break;
		}
	}

	return { perLine, spentByRow };
}

/**
 * The subscription an invoice belongs to.
 *
 * ⚠️ **Read from `parent`, not from a top-level `subscription` field.** That field moved into
 * `parent.subscription_details` in the 2025-03 API version, and a hand-built fixture that
 * still sets the old one is the kind of thing that passes a test and returns null in
 * production. Both are read here so a replayed older event is not silently ignored.
 */
function subscriptionOf(invoice: Stripe.Invoice): string | null {
	const fromParent = invoice.parent?.subscription_details?.subscription;
	if (fromParent) return typeof fromParent === "string" ? fromParent : fromParent.id;
	const legacy = (invoice as unknown as { subscription?: string | { id: string } }).subscription;
	if (legacy) return typeof legacy === "string" ? legacy : legacy.id;
	return null;
}
