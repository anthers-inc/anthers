// SPDX-License-Identifier: Apache-2.0
/**
 * Receipts — the one writer of `receipt_sends` rows, and the only caller of the
 * receipt senders in `services/email.ts`.
 *
 * Every transaction a person is on either side of earns an email: the buyer's receipt
 * for a purchase, a refund, or a paid monthly Badge, and the creator's copy of a sale
 * or a refund on their work (on by default, off by the preference on their Stripe
 * account row). Receipts are sent from the webhook that already knows the money moved,
 * not from the route that asked for it, so a dashboard refund and an app refund produce
 * the same buyer email through the same door.
 *
 * Two invariants, both one mechanism:
 *
 *   • **The insert precedes the send, and its conflict clause is the latch.** A
 *     `dedupeKey` built from the transaction's own Stripe identity is unique on
 *     `receipt_sends`; a redelivered webhook, a route call, and the Stripe event that
 *     route's own action provokes all build the same key, and only the first inserts.
 *     Sending first and recording after would re-mail on every redelivery — the exact
 *     failure `notify()`'s design note describes, which this module inherits rather
 *     than re-derives.
 *
 *   • **A failed send is recorded as failed, never swallowed or retried.** The row
 *     exists either way — the record that we told someone is the deliverable, the same
 *     reasoning `notifications.emailSentAt` carries — so the row's `sent` flag is the
 *     honest state. A receipt worth re-sending is worth a person looking at why it
 *     failed; nothing retries it behind their back.
 *
 * The figures a receipt shows come off the rows the completion webhook stamped, which
 * are the transaction as it happened: a receipt records the snapshot, never the
 * catalog's current state — `purchases`' own docblock carries the rule for the
 * work-title columns, and this module extends it to the money.
 */

import { db } from "@anthers/db/client";
import { invoiceLines, invoices, purchases, receiptSends, stripeAccounts, users } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import {
	type ReceiptLine,
	sendCreatorRefundReceiptEmail,
	sendCreatorSaleReceiptEmail,
	sendPurchaseReceiptEmail,
	sendRefundReceiptEmail,
	type SendResult,
	sendSupportReceiptEmail,
} from "./email.js";

/**
 * Whether this creator wants their copy of transaction emails. Null reads as on: the
 * default is on, and "never answered" is not a no — the same reading `userPreferences`
 * gives its nullable display preferences, whose reasoning the column's docblock carries.
 */
export async function creatorWantsReceiptEmails(creatorId: number): Promise<boolean> {
	const [acct] = await db
		.select({ wants: stripeAccounts.creatorReceiptEmails })
		.from(stripeAccounts)
		.where(eq(stripeAccounts.userId, creatorId))
		.limit(1);
	return acct?.wants !== false;
}

/**
 * Record one receipt and send it through the sender the caller hands in. Returns false
 * when the dedupe key already existed — nothing was sent — and true when this call was
 * the one that sent, or attempted to.
 *
 * The insert-then-send order is the module's load-bearing invariant; see the header.
 * The sender callback is exactly the named sender from `services/email.ts`, which owns
 * the copy, the subject, and the provider refusal rules; this module owns only whether
 * the send happens at all.
 */
async function sendOnce(
	args: {
		dedupeKey: string;
		kind: "purchase" | "refund" | "invoice";
		userId: number | null;
		role: "buyer" | "creator";
		email: string;
	},
	send: () => Promise<SendResult>,
): Promise<boolean> {
	const [row] = await db
		.insert(receiptSends)
		.values({
			dedupeKey: args.dedupeKey,
			kind: args.kind,
			userId: args.userId,
			role: args.role,
			email: args.email,
		})
		// Already sent. Not an error: the webhook is retried by design, and a route call
		// racing the Stripe event its own action provokes lands here rather than
		// double-mailing.
		.onConflictDoNothing({ target: receiptSends.dedupeKey })
		.returning({ id: receiptSends.id });
	if (!row) return false;

	const { sent, messageId } = await send();
	await db
		.update(receiptSends)
		.set(sent ? { sent: true, messageId } : { sent: false })
		.where(eq(receiptSends.id, row.id));
	if (!sent) {
		console.error(
			`[receipts] a ${args.kind} receipt for ${args.email} did not send — the receipt_sends row records it`,
		);
	}
	return true;
}

/** The account email for a user id, or null when the account is gone — a detached purchase has nobody to mail. */
async function emailOf(userId: number | null): Promise<string | null> {
	if (userId == null) return null;
	const [row] = await db
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	return row?.email ?? null;
}

/** A receipt line from a purchase row, using the snapshot columns — never the live catalog. */
function lineOf(row: typeof purchases.$inferSelect): ReceiptLine {
	return { description: row.workTitle ?? `Work #${row.workId ?? "unknown"}`, amount: row.amount };
}

/** The sums a purchase or refund receipt's closing rows show, off the rows themselves. */
function sumsOf(rows: (typeof purchases.$inferSelect)[]) {
	const tax = rows.reduce((acc, r) => acc.plus(new Decimal(r.salesTax)), new Decimal(0));
	const total = rows.reduce(
		(acc, r) => acc.plus(new Decimal(r.amount).plus(new Decimal(r.salesTax))),
		new Decimal(0),
	);
	return { tax: tax.toFixed(2), total: total.toFixed(2) };
}

type PurchaseRows = (typeof purchases.$inferSelect)[];

/**
 * Receipts for a completed purchase: the buyer's itemized receipt, and — when the buyer
 * is not the creator — the creator's sale receipt.
 *
 * Called from the `payment_intent.succeeded` webhook after the completion loop, with
 * every row the webhook just completed. A basket arrives as several rows sharing one
 * PaymentIntent id, which is one receipt with one line per Work, not one email per
 * Work: the charge was one charge, and the receipt records what it bought.
 *
 * The dedupe key names the recipient, so the buyer's receipt and the creator's are two
 * rows and two emails, and a redelivered event is neither.
 */
export async function sendPurchaseReceipts(rows: PurchaseRows): Promise<void> {
	if (rows.length === 0) return;
	const intentId = rows[0].stripePaymentIntentId;
	const date = rows[0].updatedAt;
	const { tax, total } = sumsOf(rows);
	const [buyerId, creatorId] = [rows[0].buyerId, rows[0].creatorId];

	const buyerEmail = await emailOf(buyerId);
	if (buyerEmail) {
		await sendOnce(
			{
				dedupeKey: `purchase:${intentId}:buyer:${buyerId ?? "detached"}`,
				kind: "purchase",
				userId: buyerId,
				role: "buyer",
				email: buyerEmail,
			},
			() =>
				sendPurchaseReceiptEmail({
					to: buyerEmail,
					reference: intentId,
					date,
					lines: rows.map(lineOf),
					tax,
					total,
				}),
		);
	}

	// The creator's copy: one receipt for the whole charge, the earnings figure being
	// the sum the rows recorded — a basket's pro-rata fee split leaves them summing to
	// the transfer pinned at session creation, which is the number Stripe moved.
	if (creatorId != null && creatorId !== buyerId) {
		const [creator] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, creatorId))
			.limit(1);
		if (!creator) return;
		if (!(await creatorWantsReceiptEmails(creatorId))) return;
		const earnings = rows
			.reduce((acc, r) => acc.plus(new Decimal(r.creatorEarnings)), new Decimal(0))
			.toFixed(2);
		await sendOnce(
			{
				dedupeKey: `purchase:${intentId}:creator:${creatorId}`,
				kind: "purchase",
				userId: creatorId,
				role: "creator",
				email: creator.email,
			},
			() =>
				sendCreatorSaleReceiptEmail({
					to: creator.email,
					reference: intentId,
					date,
					lines: rows.map(lineOf),
					earnings,
				}),
		);
	}
}

/**
 * Receipts for a refund of purchases, buyer and creator. The amounts shown are the
 * rows' recorded figures signed negative: the money going back is exactly what the row
 * said went out, item by item, which is the full-item guarantee `services/refunds.ts`
 * issues for every refund it settles.
 *
 * Two doors reach this. The refund routes call it after `settleRefundedPurchase`
 * settles (per-item refunds arrive at Stripe as partial charge refunds, which the
 * webhook's `charge.refunded` guard deliberately passes over); the webhook calls it on
 * a `charge.refunded` that is wholly refunded, which is the dashboard path nobody in
 * the routes ever sees. A route refund and the Stripe event that action provokes build
 * the same key from the same refund id, so the mail goes once.
 */
export async function sendRefundReceipts(rows: PurchaseRows): Promise<void> {
	if (rows.length === 0) return;
	const row = rows[0];
	const date = row.refundedAt ?? row.updatedAt;
	const { tax, total } = sumsOf(rows);
	const negated = (s: string) => (new Decimal(s).isZero() ? s : new Decimal(s).negated().toFixed(2));
	const negTax = negated(tax);
	const negTotal = negated(total);

	// The refund's own identity is the latch, not the payment's: a charge could in
	// principle see more than one refund over its life, and each one earns its own
	// receipt. The id survives the whole trip — the routes read it off the Refund
	// object they made, the webhook off the event's first refund object — so both
	// doors latch on the same key for the same refund. When neither door can name it
	// (an event shape that carries no refund objects), the key falls back to the
	// PaymentIntent, which still latches correctly for a charge whose refunds are the
	// single full refund this model only ever issues.
	const refundRef = row.stripeRefundId ?? row.stripePaymentIntentId;

	const buyerEmail = await emailOf(row.buyerId);
	if (buyerEmail) {
		await sendOnce(
			{
				dedupeKey: `refund:${refundRef}:buyer:${row.buyerId ?? "detached"}`,
				kind: "refund",
				userId: row.buyerId,
				role: "buyer",
				email: buyerEmail,
			},
			() =>
				sendRefundReceiptEmail({
					to: buyerEmail,
					reference: refundRef,
					date,
					lines: rows.map(lineOf),
					tax: negTax,
					total: negTotal,
				}),
		);
	}

	if (row.creatorId != null && row.creatorId !== row.buyerId) {
		const [creator] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, row.creatorId))
			.limit(1);
		if (!creator) return;
		if (!(await creatorWantsReceiptEmails(row.creatorId))) return;
		const earnings = negated(
			rows.reduce((acc, r) => acc.plus(new Decimal(r.creatorEarnings)), new Decimal(0)).toFixed(2),
		);
		await sendOnce(
			{
				dedupeKey: `refund:${refundRef}:creator:${row.creatorId}`,
				kind: "refund",
				userId: row.creatorId,
				role: "creator",
				email: creator.email,
			},
			() =>
				sendCreatorRefundReceiptEmail({
					to: creator.email,
					reference: refundRef,
					date,
					lines: rows.map(lineOf),
					earnings,
				}),
		);
	}
}

/**
 * A supporter's receipt for a paid monthly Badge invoice, called from the webhook after
 * `recordPaidInvoice` has recorded it (the row's presence is the idempotency the
 * receipt rides: a redelivered `invoice.paid` no-ops there, so this is reached once).
 *
 * The lines name each creator the payment reached, net of their discounts, with
 * Anthers' own line excluded — the receipt is about what the supporter gave creators,
 * and when nothing was directed the itemization says that in words rather than showing
 * an empty table.
 */
export async function sendSupportReceipt(
	invoiceRow: typeof invoices.$inferSelect,
): Promise<void> {
	const buyerEmail = await emailOf(invoiceRow.userId);
	if (!buyerEmail) return;

	const lines = await db
		.select({ creatorId: invoiceLines.creatorId, amount: invoiceLines.amount })
		.from(invoiceLines)
		.where(eq(invoiceLines.invoiceId, invoiceRow.id));

	// A line is named for the creator it reached. A deleted account's line — the FK is
	// set null and the money row stays — is still shown, described by what it was
	// rather than by nobody.
	const creatorIds = lines.filter((l) => l.creatorId != null).map((l) => l.creatorId as number);
	const names = creatorIds.length
		? new Map(
				(await db
					.select({ id: users.id, name: users.displayName, handle: users.atprotoHandle })
					.from(users)
					.where(inArray(users.id, creatorIds))).map((u) => [u.id, u.name ?? u.handle ?? "a creator"]),
			)
		: new Map<number, string>();
	const receiptLines: ReceiptLine[] = lines
		.filter((l) => l.creatorId != null)
		.map((l) => ({
			description: `Support for ${names.get(l.creatorId as number) ?? "a creator"}`,
			amount: l.amount,
		}));

	await sendOnce(
		{
			dedupeKey: `invoice:${invoiceRow.stripeInvoiceId}:buyer:${invoiceRow.userId}`,
			kind: "invoice",
			userId: invoiceRow.userId,
			role: "buyer",
			email: buyerEmail,
		},
		() =>
			sendSupportReceiptEmail({
				to: buyerEmail,
				reference: invoiceRow.stripeInvoiceId,
				date: invoiceRow.paidAt ?? invoiceRow.createdAt,
				billingCycle: invoiceRow.billingCycle,
				lines: receiptLines,
				tax: invoiceRow.tax,
				total: invoiceRow.total,
			}),
	);
}