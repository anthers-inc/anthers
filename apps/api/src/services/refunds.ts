// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Refunds — the one place a purchase is reversed, whoever asked for it.
 *
 * A refund is what the never-contest posture actually *does*, so it has to work
 * before the storefront takes real money. Both the accounting rule (51.02
 * § Refunds) and the policy above it (51.06 § Refunds, decided 2026-08-09) are
 * settled; this module is where they meet.
 *
 * Three invariants, and each of them is a way to get money wrong:
 *
 *   • **The creator is reversed to exactly their earnings and never below zero.**
 *     `reverse_transfer` on a full refund claws back the whole transfer and no
 *     more, so a creator is never billed for someone else's refund — that would be
 *     a cut, just a negative one they cannot predict or price around, and it would
 *     contradict "Anthers takes no cut". Note the corollary for partial refunds:
 *     Stripe reverses the transfer *proportionally*, so a partial refund is not a
 *     safe way to make Anthers eat more of it. Full refunds only, for now.
 *
 *   • **Anthers absorbs the shortfall, and it is booked.** Stripe does not return
 *     its processing fee on a refund. That unrecoverable amount comes out of the
 *     remainder — the same shock absorber that funds free access — and it is written
 *     to the charitable ledger as a negative entry so the pool's balance tells the
 *     truth.
 *     A refund that moves money without a ledger row is the silent version of the
 *     gross-vs-net bug that cost ~$0.39 a Seed until 2026-08-08.
 *
 *   • **The cap counts refunds after DOWNLOAD, and only buyer-initiated ones.** A
 *     takedown or a defect refunds someone who may well have downloaded, and must
 *     not consume the allowance they'd want for a purchase that was genuinely
 *     their own choice. `refund_initiator` is what keeps those apart.
 *
 * Access revocation needs no code here: `resolveAccess` counts only `completed`
 * purchases, so flipping the status is what takes the unlock away.
 */

import { db } from "@anthers/db/client";
import { crfLedger, purchases } from "@anthers/db/schema";
import { REFUND_AUTO_CAP, REFUND_CAP_WINDOW_MONTHS } from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { getStripe } from "../lib/stripe.js";

type Purchase = typeof purchases.$inferSelect;

/** Who asked. Only `buyer` refunds count against the cap. */
export type RefundInitiator = "buyer" | "platform";

export type RefundFailure =
	| "not_configured" // Stripe isn't wired up
	| "not_refundable" // wrong status, or a kind of charge that isn't refunded
	| "review_required" // over the automatic cap — a human looks, nothing is refused
	| "stripe_error";

export type RefundResult =
	| { ok: true; purchase: Purchase; shortfall: Decimal; alreadyRefunded: boolean }
	| { ok: false; code: RefundFailure; message: string };

/** First day of the rolling cap window, counted back from now. */
function capWindowStart(now: Date): Date {
	const start = new Date(now);
	start.setMonth(start.getMonth() - REFUND_CAP_WINDOW_MONTHS);
	return start;
}

/**
 * How many automatic refunds this buyer has left.
 *
 * Counts only refunds that were **buyer-initiated** and **after download**, which
 * is exactly the population the Terms describe: "refunds after download are
 * automatic for your first three in any twelve months". A refund of something
 * never downloaded is uncapped, because the bytes the cap exists to bound were
 * never sent.
 */
export async function refundsAfterDownloadInWindow(
	buyerId: number,
	now: Date = new Date(),
): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`COUNT(*)::int` })
		.from(purchases)
		.where(
			and(
				eq(purchases.buyerId, buyerId),
				eq(purchases.status, "refunded"),
				eq(purchases.refundInitiator, "buyer"),
				isNotNull(purchases.downloadedAt),
				gte(purchases.refundedAt, capWindowStart(now)),
			),
		);
	return row?.n ?? 0;
}

/**
 * What Anthers cannot recover on this refund: Stripe's sunk processing fee, plus
 * the delivery it already paid for if the buyer actually took the bytes.
 *
 * ⚠️ **`delivery_fee` is "0.00" on every sale since 2026-08-12**, so on a current
 * purchase this is the processing fee alone. The term stays because it is read off
 * the ROW rather than recomputed, and **pre-2026-08-12 purchases carry a real one** —
 * recomputing from today's model would under-book every legacy refund by exactly the
 * delivery it actually paid for.
 *
 * Delivery is conditional on `downloaded_at` on purpose — the fee was collected to
 * cover a download, and if none happened the bytes were never sent, so booking it as
 * a loss would overstate what the remainder absorbed.
 */
export function refundShortfall(purchase: Purchase): Decimal {
	const processing = new Decimal(purchase.processingFee);
	const delivery = purchase.downloadedAt ? new Decimal(purchase.deliveryFee) : new Decimal(0);
	return processing.plus(delivery);
}

/**
 * Reverse a purchase: refund the buyer at Stripe, claw the creator's transfer
 * back, flip the row, and book the shortfall against the remainder.
 *
 * Idempotent in both directions. The row only moves `completed → refunded`, so a
 * redelivered webhook or a double-click is a no-op that reports
 * `alreadyRefunded`; and the Stripe call carries an idempotency key derived from
 * the purchase id, so a retry after a timeout cannot issue a second refund.
 */
export async function refundPurchase(
	purchase: Purchase,
	opts: { initiator: RefundInitiator; reason?: string; now?: Date },
): Promise<RefundResult> {
	const now = opts.now ?? new Date();

	if (purchase.status === "refunded")
		return { ok: true, purchase, shortfall: new Decimal(0), alreadyRefunded: true };

	if (purchase.status !== "completed")
		return { ok: false, code: "not_refundable", message: "This purchase can't be refunded." };

	// Seeds are a monthly commitment, not a purchase: the Terms say you keep the
	// cycle you have paid for and we do not pro-rate one in progress. Refunding a
	// Seed buy here would also silently unwind an account credit that
	// `applyCreditForPurchase` has already spent into gates and Badges.
	if (purchase.type === "seeds")
		return {
			ok: false,
			code: "not_refundable",
			message: "Seeds are a monthly commitment rather than a purchase, so they aren't refunded.",
		};

	// The cap bites only on a buyer's own request for something they downloaded.
	// Over it, a human looks — this is not a refusal, and the copy must not read
	// like one (51.06: "if you do and it is genuine, we will still sort it out").
	// `buyerId` is null once the buyer deleted their account, and a detached purchase
	// has nobody left to be asking — the cap counts a *person's* refunds, so there is
	// no window to look at. Guarded rather than defaulted: passing a null through to a
	// count would silently make the cap unenforceable for everyone.
	if (opts.initiator === "buyer" && purchase.downloadedAt && purchase.buyerId != null) {
		const used = await refundsAfterDownloadInWindow(purchase.buyerId, now);
		if (used >= REFUND_AUTO_CAP)
			return {
				ok: false,
				code: "review_required",
				message:
					"We'll need to look at this one with you before refunding it. Get in touch and we'll sort it out.",
			};
	}

	const stripe = getStripe();
	if (!stripe)
		return { ok: false, code: "not_configured", message: "Payments are not configured." };

	let refundId: string;
	try {
		const refund = await stripe.refunds.create(
			{
				payment_intent: purchase.stripePaymentIntentId,
				// Claw the creator's transfer back. Without this the refund comes
				// entirely out of the platform balance and the creator keeps money for a
				// sale that no longer exists.
				reverse_transfer: true,
				// `refund_application_fee` is deliberately NOT set. On a destination
				// charge the application fee never left the platform — it was subtracted
				// from the transfer — so refunding it would push the retained sales tax
				// and delivery *to the creator* on a sale that was just undone. What the
				// platform is left holding after a full refund plus a full transfer
				// reversal is exactly Stripe's sunk processing fee, which is the
				// documented outcome (51.02).
				reason: opts.initiator === "buyer" ? "requested_by_customer" : undefined,
				metadata: {
					purchaseId: String(purchase.id),
					initiator: opts.initiator,
					...(opts.reason ? { reason: opts.reason } : {}),
				},
			},
			// A retry after a network timeout must not issue a second refund, and the
			// purchase id is the stable name for "this reversal".
			{ idempotencyKey: `refund_purchase_${purchase.id}` },
		);
		refundId = refund.id;
	} catch (err) {
		return {
			ok: false,
			code: "stripe_error",
			message: err instanceof Error ? err.message : "The refund could not be processed.",
		};
	}

	return await settleRefundedPurchase(purchase, {
		initiator: opts.initiator,
		reason: opts.reason,
		stripeRefundId: refundId,
		now,
	});
}

/**
 * Record a refund that has already happened at Stripe: flip the row and book the
 * shortfall. Split out from `refundPurchase` because the webhook needs exactly
 * this half — a refund issued from the Stripe dashboard reaches us as a
 * `charge.refunded` event with no route call behind it, and the books have to
 * close the same way whichever door the refund came through.
 */
export async function settleRefundedPurchase(
	purchase: Purchase,
	opts: {
		initiator: RefundInitiator;
		reason?: string;
		stripeRefundId?: string | null;
		now?: Date;
	},
): Promise<RefundResult> {
	const now = opts.now ?? new Date();

	// Conditional on `completed`, so this is the idempotency latch: our own route
	// and the webhook Stripe fires for the refund it just made both run it, and
	// only the first one writes.
	const [updated] = await db
		.update(purchases)
		.set({
			status: "refunded",
			refundedAt: now,
			refundInitiator: opts.initiator,
			refundReason: opts.reason ?? null,
			stripeRefundId: opts.stripeRefundId ?? null,
			updatedAt: now,
		})
		.where(and(eq(purchases.id, purchase.id), eq(purchases.status, "completed")))
		.returning();

	if (!updated) return { ok: true, purchase, shortfall: new Decimal(0), alreadyRefunded: true };

	// The remainder absorbs what could not be recovered. Negative, because this is
	// money leaving the pool that funds free access — the honest reason the Terms
	// give for the cap, and it can only stay honest if the ledger records it.
	const shortfall = refundShortfall(updated);
	if (shortfall.greaterThan(0)) {
		await db.insert(crfLedger).values({
			amount: shortfall.negated().toFixed(2),
			purchaseId: updated.id,
			description:
				`Refund shortfall (${opts.initiator}-initiated) — sunk card processing` +
				`${updated.downloadedAt ? " and delivered bytes" : ""} on purchase #${updated.id}`,
		});
	}

	return { ok: true, purchase: updated, shortfall, alreadyRefunded: false };
}

/**
 * Stamp the first time this buyer pulled the payload down, if they reached it
 * through a purchase of their own.
 *
 * Best-effort and deliberately not awaited by the download route: a failure here
 * must never cost someone the file they paid for. The consequence of losing a
 * stamp is that a refund is treated as pre-download — generous to the buyer,
 * which is the right way for this to fail.
 *
 * Only the first download is recorded (`downloaded_at IS NULL` in the predicate);
 * the column answers "has this been delivered at all", not "how often".
 */
export async function markPurchaseDownloaded(
	buyerId: number,
	workId: number,
	now: Date = new Date(),
): Promise<void> {
	await db
		.update(purchases)
		.set({ downloadedAt: now })
		.where(
			and(
				eq(purchases.buyerId, buyerId),
				eq(purchases.workId, workId),
				eq(purchases.status, "completed"),
				sql`${purchases.downloadedAt} IS NULL`,
			),
		);
}
