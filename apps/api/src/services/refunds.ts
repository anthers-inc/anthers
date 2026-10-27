// SPDX-License-Identifier: Apache-2.0
/**
 * Refunds — the one place a purchase is reversed, whoever asked for it.
 *
 * A refund is what the never-contest posture actually *does*, so it has to work
 * before the storefront takes real money. Both the accounting rule and the policy above it
 * (Terms of Service § Refunds, decided 2026-08-09) are settled; this module is where they
 * meet. The vault document that used to state the accounting was retired on 2026-09-02 as a
 * duplicate of this docblock, so **the three invariants below are now its only statement.**
 *
 * Three invariants, and each of them is a way to get money wrong:
 *
 *   • **The creator is reversed to exactly their earnings and never below zero.**
 *     The transfer reversal claws back the row's recorded share and no more, so a
 *     creator is never billed for someone else's refund — that would be a cut, just a
 *     negative one they cannot predict or price around, and it would contradict
 *     "Anthers takes no cut".
 *
 *     🚨 **"Full refunds only" means full refunds of an ITEM, not of a charge**
 *     (clarified 2026-08-13, Parker; this used to read "full refunds only, for
 *     now" and was applied to the charge). A basket puts several independent
 *     purchases on one PaymentIntent, and refunding one of five must not return
 *     the other four — the buyer chose each of them and keeps what they keep.
 *     What remains prohibited is refunding *part of one item*, which is what the
 *     old warning was really about: there, a proportional reversal genuinely is
 *     not a safe way to make Anthers absorb more.
 *
 *     Per-item refunds are safe because the proportion resolves exactly. Both the
 *     card fee and the tax are apportioned pro-rata by item value, so reversing
 *     exactly `aᵢ(S − p)/S` of the transfer lands on that row's recorded earnings
 *     — which is the amount this module reverses, by name, off the row.
 *
 *     ⚠️ **The reversal is an explicit call, not a refund side effect** (the
 *     2026-10-15 split): purchases are platform charges whose per-creator transfer
 *     was made at completion (`services/purchase-split.ts`), so the refund of the
 *     charge reverses nothing on its own. The clawback is `createTransferReversal`
 *     on the row's transfer, for the row's earnings — the same amount, the same
 *     invariant, one more API call.
 *
 *   • **Anthers absorbs the shortfall, and it is booked.** Stripe does not return
 *     its processing fee on a refund. That unrecoverable amount comes out of the
 *     remainder — the same shock absorber that funds the charitable programs — and
 *     it is written to the charitable ledger as a negative entry so the pool's
 *     balance tells the truth.
 *     A refund that moves money without a ledger row is the silent version of the
 *     gross-vs-net bug that cost ~$0.39 on every lone directed charge.
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
import { createTransferReversal, issueRefund, paymentsConfigured } from "../lib/processor.js";
import { oweAccessReceipt } from "./access-receipts.js";
import { recordNettingForRefund } from "./netting.js";
import { settleSaleCreditOnRefund } from "./purchase-split.js";

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
 * What Anthers cannot recover on this refund: Stripe's sunk processing fee.
 *
 * ⚠️ **The delivery-fee term is gone, and the reason is the column.** `purchases.
 * delivery_fee` was always "0.00" on every sale since the R2 move (2026-08-12), and the
 * accounts-split pass dropped the column outright — pre-launch there are no historical
 * rows carrying a real one, so the "read it off the row" reasoning had nothing left to
 * read. The refund cap reasoning still turns on **whether the bytes went out**
 * (`downloaded_at`), which is the distinction that was ever load-bearing; only the
 * arithmetic that priced the delivery is.
 */
export function refundShortfall(purchase: Purchase): Decimal {
	return new Decimal(purchase.processingFee);
}

/**
 * Attempt the clawback of one purchase's creator share: reverse the row's recorded
 * earnings off the transfer that carried them. The one reversal mechanism, shared by
 * `refundPurchase` and the webhook's dashboard-refund branch, because the two doors must
 * leave the money in the same state — the single-writer rule the basket storage follows,
 * pointed at Stripe instead of a table.
 *
 * Returns whether the share came back. `reversed: false` on a row WITH a transfer is the
 * paid-out creator (the connected balance cannot fund the reversal) and hands recovery to
 * the netting ledger; on a row with NO transfer the share never left, and the caller skips
 * netting for the same reason. The idempotency key is the purchase id, so a webhook
 * redelivery of a refund our own route already clawed back cannot reverse a second cent.
 */
export async function reverseCreatorShare(
	purchase: Purchase,
	opts: { saleCreditReleased?: boolean } = {},
): Promise<{
	/** Whether the reversal recovered the share at Stripe. */
	reversed: boolean;
	/** Whether the creator's share ever reached them — false on a never-transferred row. */
	creatorWasPaid: boolean;
}> {
	// A physical sale's share never rides `purchases.stripe_transfer_id`: it is held in
	// `creator_credits` and moved by the transfer job, whose coverage tables record it. A
	// released credit therefore counts as paid — there is no transfer on this row to reverse,
	// so recovery is the netting ledger's, exactly as for a support credit. A credit still
	// held was removed by `settleSaleCreditOnRefund` before this ran, and owes nothing.
	if (opts.saleCreditReleased) return { reversed: false, creatorWasPaid: true };
	if (purchase.stripeTransferId == null) return { reversed: false, creatorWasPaid: false };
	try {
		const reversal = await createTransferReversal(
			purchase.stripeTransferId,
			{ amount: Math.round(new Decimal(purchase.creatorEarnings).toNumber() * 100) },
			{ idempotencyKey: `refund_reversal_${purchase.id}` },
		);
		if (reversal == null) throw new Error("The transfer reversal could not be processed.");
		return { reversed: true, creatorWasPaid: true };
	} catch {
		// The connected account's balance could not fund the reversal — the paid-out
		// creator — so recovery moves to the netting ledger (`services/netting.ts`).
		return { reversed: false, creatorWasPaid: true };
	}
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

	// Monthly support is a commitment, not a purchase: the Terms say you keep the
	// cycle you have paid for and we do not pro-rate one in progress. Refunding a
	// support top-up here would also silently unwind an account credit that
	// `applyCreditForPurchase` has already spent into gates and Badges.
	if (purchase.type === "seeds")
		return {
			ok: false,
			code: "not_refundable",
			message: "Monthly support is a commitment rather than a purchase, so it isn't refunded.",
		};

	// The cap bites only on a buyer's own request for something they downloaded.
	// Over it, a human looks — this is not a refusal, and the copy must not read
	// like one (Terms of Service: "if you do and it is genuine, we will still sort it out").
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

	if (!paymentsConfigured())
		return { ok: false, code: "not_configured", message: "Payments are not configured." };

	/**
	 * How much of the charge this purchase is.
	 *
	 * 🚨 **"Full refunds only" means full refunds of an ITEM, not of a charge** (settled
	 * 2026-08-13, Parker). A basket puts several independent purchases on one
	 * PaymentIntent, and refunding one of five must not return the other four — they are
	 * separate things the buyer chose to keep. So where the charge carries siblings, the
	 * refund names an explicit `amount`: this row's price plus its apportioned share of
	 * the sales tax, which is exactly what the buyer paid for it — the tax share read off
	 * the row, where completion stamped what Stripe Tax actually collected.
	 *
	 * **A lone purchase still sends no `amount` at all.** Its share *is* the whole charge,
	 * so the two are equivalent — and the whole charge's refund returns the whole tax
	 * with it, on Stripe's side, automatically: the tax was part of what the buyer paid,
	 * so refunding it in full hands every cent back. The no-amount call is the
	 * long-tested path for the overwhelmingly common case, and there is no reason to
	 * move it onto a new one for symmetry's sake.
	 */
	const siblingCount = (
		await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, purchase.stripePaymentIntentId))
	).length;
	const itemCents =
		siblingCount > 1
			? Math.round(new Decimal(purchase.amount).plus(purchase.salesTax).toNumber() * 100)
			: undefined;

	let refundId: string;
	let transferReversed = false;
	/** Whether the creator's share ever reached them — a row with no transfer was never paid. */
	let creatorWasPaid = true;
	try {
		const refund = await issueRefund(
			{
				payment_intent: purchase.stripePaymentIntentId,
				...(itemCents !== undefined ? { amount: itemCents } : {}),
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
		refundId = refund?.id ?? "";
		if (!refundId) throw new Error("The refund could not be processed.");

		// ── The creator's share: the explicit clawback, after the buyer's money moved ──
		// Purchases are platform charges (2026-10-15), so the refund above reversed
		// nothing on its own — the creator's share moved out at completion as a transfer
		// (`services/purchase-split.ts`), and `reverseCreatorShare` reverses exactly the
		// row's recorded earnings off it. Never more, so a creator is never billed for
		// someone else's refund; and a row that was never transferred owes no clawback
		// and no netting, because that share never left. A reversal that cannot be
		// funded (the paid-out creator) is the netting ledger's case, not an error
		// here — the refund itself succeeded.
		// The sale's hold is settled before the clawback: a held credit is taken away (the
		// creator never received it), and a released one tells the reversal that the money
		// has left and recovery is netting's. See `settleSaleCreditOnRefund`.
		const saleCredit = await settleSaleCreditOnRefund(purchase.id);
		const clawback = await reverseCreatorShare(purchase, {
			saleCreditReleased: saleCredit === "released",
		});
		transferReversed = clawback.reversed;
		creatorWasPaid = clawback.creatorWasPaid;
	} catch (err) {
		return {
			ok: false,
			code: "stripe_error",
			message: err instanceof Error ? err.message : "The refund could not be processed.",
		};
	}

	/**
	 * 🚨 Settle **every** purchase on this charge, not just the one asked for.
	 *
	 * `refunds.create` above passes no `amount`, so it refunds the whole PaymentIntent.
	 * That was the same thing as "this purchase" until baskets existed. On a basket it is
	 * not: refunding one of five items returns all five items' money and reverses the
	 * whole transfer, so settling one row would leave the buyer holding permanent access
	 * to four Works nobody was paid for. `resolveAccess` reads completed purchases, so an
	 * unsettled sibling is a live entitlement, not a stale record.
	 *
	 * A basket therefore refunds **as a basket** — which is also why the buyer-facing copy
	 * has to say so before they click. Refunding a single item would mean a *partial*
	 * refund, and the standing rule is full refunds only for now; it is genuinely available
	 * later (a same-creator basket reverses the transfer proportionally, which is exactly
	 * that item's earnings) but it is a decision, not a detail.
	 */
	return await settleRefundedPurchase(purchase, {
		initiator: opts.initiator,
		reason: opts.reason,
		stripeRefundId: refundId,
		transferReversed,
		creatorWasPaid,
		now,
	});
}

/**
 * Record a refund that has already happened at Stripe: flip the row and book the
 * shortfall. Split out from `refundPurchase` because the webhook needs exactly
 * this half — a refund issued from the Stripe dashboard reaches us as a
 * `charge.refunded` event with no route call behind it, and the books have to
 * close the same way whichever door the refund came through.
 *
 * ⭐ **The netting write lives here, on the after-transfer case only** (Parker,
 * 2026-09-14, "Money That Came Back"). A purchase's creator's share reached them as the
 * completion-path transfer (`services/purchase-split.ts`), so whether Anthers clawed it
 * back is exactly one observable fact — did the refund's explicit transfer reversal
 * happen? `refundPurchase` makes the call and passes the outcome; the webhook makes the
 * same call per refunded row and passes the same outcome. **Reversed: no netting row** —
 * the share came back at Stripe, the before-transfer mechanism did its job. **Not
 * reversed: a netting row** (`recordNettingForRefund`) — the creator had already paid the
 * money out, nothing came back, and recovery moves to the creator's later earnings
 * instead. **Never paid — no transfer id on the row: nothing** — the share never left,
 * so there is nothing to recover and a netting row would bill the creator for money they
 * never received. `refunds.ts`'s module invariant holds in every case: the creator is
 * reversed to exactly their earnings and never below zero, because the netting amount is
 * the row's own earnings and the netting ledger itself never bills.
 *
 * The netting is written only when the flip succeeds (not on `alreadyRefunded`), so the
 * row's own status predicate is the netting's latch against a double webhook delivery —
 * the same reason the shortfall books inside the same conditional.
 */
export async function settleRefundedPurchase(
	purchase: Purchase,
	opts: {
		initiator: RefundInitiator;
		reason?: string;
		stripeRefundId?: string | null;
		/** Whether the refund's transfer reversal actually recovered the creator's share at Stripe. */
		transferReversed?: boolean;
		/**
		 * Whether the creator's share ever reached them at all. False on a row whose
		 * transfer was never made (a completion-path failure the retry job owns) — the
		 * share cannot be recovered because it never left, so it must not NET either:
		 * the netting ledger recovers money the creator received, and this share never
		 * was. Defaults true — the historical rows' transfers all happened, at the
		 * moment of their charges, under the destination-charge shape this column never
		 * knew about.
		 */
		creatorWasPaid?: boolean;
		now?: Date;
	},
): Promise<RefundResult> {
	const now = opts.now ?? new Date();

	// Conditional on `completed`, so this is the idempotency latch: our own route
	// and the webhook Stripe fires for the refund that route just made both run it, and
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

	// The refund event is owed by the reader's space whether this call settled the row or a
	// previous one did: a redelivery is the repair path for an insert that failed after the
	// money moved. `oweAccessReceipt` is idempotent on (purchase, kind).
	if (!updated) {
		await oweAccessReceipt(purchase.id, "refund");
		return { ok: true, purchase, shortfall: new Decimal(0), alreadyRefunded: true };
	}
	await oweAccessReceipt(updated.id, "refund");

	// The creator's share did not come back at Stripe — recover it from later earnings
	// instead. The refund id is the netting row's own identity, so a replayed or
	// redelivered anything finds the row and changes nothing. Skipped when the share
	// never reached the creator at all (`creatorWasPaid` false): recovering money
	// somebody never received is the one netting write that would bill the creator
	// for a sale that paid them nothing.
	if (!opts.transferReversed && (opts.creatorWasPaid ?? true)) {
		await recordNettingForRefund(updated, opts.stripeRefundId ?? updated.stripeRefundId, now);
	}

	// The remainder absorbs what could not be recovered. Negative, because this is
	// money leaving the charitable pool — the honest reason the Terms give for the
	// cap, and it can only stay honest if the ledger records it. The
	// shortfall is the sunk processing fee alone since the delivery column died —
	// see `refundShortfall` — so the "and delivered bytes" clause has nothing to
	// name any more.
	const shortfall = refundShortfall(updated);
	if (shortfall.greaterThan(0)) {
		await db.insert(crfLedger).values({
			amount: shortfall.negated().toFixed(2),
			purchaseId: updated.id,
			description: `Refund shortfall (${opts.initiator}-initiated) — sunk card processing on purchase #${updated.id}`,
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
