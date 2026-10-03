// SPDX-License-Identifier: Apache-2.0
/**
 * Netting — the one writer of the netting ledger, and the recovery of a creator's share
 * of returned money from their later earnings (Parker, 2026-09-14, the collect-and-pay-out
 * decision's "Money That Comes Back").
 *
 * The decision's timing cases, and where each lives:
 *
 *   • **Before settlement** — a refunded or charged-back support invoice is never credited;
 *     settlement credits `paid` invoices only, so nothing to undo.
 *   • **After settlement and before the transfer** — the credits exist and are still held;
 *     the monthly-support half is `markInvoiceMoneyReturned`'s existing job plus the
 *     transfer job's negative-sum handling. Nothing here touches that path.
 *   • **After the transfer** — the creator's share already reached them. This module's
 *     whole subject: write a `creator_nettings` row, recover it from future earnings at
 *     the transfer step, reverse it when a contested dispute is won.
 *
 * A purchase is a destination charge, so its creator's share is "after the transfer" by
 * construction — the share moved at the moment the charge cleared, pinned by
 * `transfer_data[amount]`. Anthers' clawback attempt on a purchase refund is
 * `refunds.ts`'s `reverse_transfer`, which works only while the money still sits in the
 * connected account's balance. The seam between "works" and "cannot work" is whether the
 * creator has already paid the money out of Stripe, and Anthers cannot observe that —
 * but Stripe's refund object can, and does: a refund's `source_transfer_reversal` is the
 * transfer reversal the refund created, and it is **present exactly when the reversal
 * happened**. So the honest rule this module implements:
 *
 *   • our own `refundPurchase` asks for `reverse_transfer` and reads the reversal off the
 *     refund it made — the share came back at Stripe, and **no netting row is written**.
 *     That is the decision's "before the creator has paid out" case, already handled.
 *   • a refund whose transfer reversal is absent — the connected balance could not fund
 *     it (a paid-out creator) or the refund was issued without one (a dashboard refund
 *     with the box unchecked) — **writes a netting row** for the row's earnings. What
 *     Anthers could not recover at Stripe it recovers from future earnings instead.
 *   • a dispute on a purchase **always writes a netting row**: a chargeback debits the
 *     platform balance and reverses nothing on the transfer (Stripe's own expert answer
 *     is that a chargeback does not auto-reverse the transfer), so the creator's share is
 *     unrecovered the moment the dispute lands. If the dispute is later contested and
 *     won, the money comes back and `reverseNettingForWonDispute` reverses the row.
 *
 * 🚨 **Netting never sends a creator a bill** — the decision's own words. Recovery comes
 * only from `creator_credits` the transfer step has not yet moved; if the open netting
 * exceeds what is held, nothing transfers and the netting stays open. There is no
 * account debit, no negative transfer, no below-zero. Anthers absorbs its own share and
 * anything it cannot recover; the absorbed remainder sits as an open row, because
 * "the creator will never earn again" is not a fact this system can know. Recording that
 * absorption on the books is the Books milestone's to build; these rows are what it reads.
 *
 * ⭐ **One writer, the same rule `refunds.ts` and `disputes.ts` follow.** This module owns
 * every write to `creator_nettings` and `creator_netting_applications`; the transfer job
 * is the one *applier* (it owns the moment recovery happens) and calls in through
 * `applyNettingsToHeldCredits` below. A new module rather than an extension of `refunds.ts`
 * because its subject is not refunds: a dispute nets, a won dispute un-nets, and the
 * application half lives in the transfer job's transaction — none of which is a refund's
 * concern, and `refunds.ts`'s invariants are load-bearing enough without a second subject
 * inside them.
 *
 * ⚠️ **The Stripe test-mode question this task asked, answered from the documented
 * behavior** (the sandbox could not be run from this build; the sources are Stripe's own
 * docs): *what does `reverse_transfer` do to a purchase refund once the creator has
 * already paid the money out?*
 *
 *   • A destination charge's refund with `reverse_transfer: true` reverses the transfer
 *     **proportionally** ([Refunds API](https://docs.stripe.com/api/refunds/create) —
 *     "The transfer will be reversed proportionally to the amount being refunded").
 *   • A transfer reversal **can only reverse up to the unreversed amount remaining of the
 *     transfer**, and Stripe's docs state the reversal is created from the *connected
 *     account's balance*. Stripe does carry negative connected-account balances in general
 *     ([Connect account balances](https://docs.stripe.com/connect/account-balances) —
 *     refunds and chargebacks can make one negative, and Stripe then offsets it against
 *     future payments or debits the external account) — but the Tax and Compliance Plan
 *     records the finding that **Stripe does not carry creators' negative balances on
 *     destination charges**, and on a paid-out connected account there is no balance to
 *     reverse from. The expected and recorded answer, in this codebase's own terms: **no
 *     reversal happens that returns the money** — the reversal is absent or unfunded, the
 *     platform's own balance funds the refund, and the creator keeps money for a sale that
 *     no longer exists. That is the hole netting fills.
 *   • A dispute never touches the transfer at all: Stripe debits the chargeback from the
 *     platform balance (indirect charges — [Connect charges](https://docs.stripe.com/connect/charges)
 *     — negative transactions for indirect charges affect the platform's balance), and
 *     Stripe's own expert answer is that the transfer is **not** auto-reversed on a
 *     chargeback.
 *
 * Money math is in `decimal.js` throughout, and every amount in the tables is a string.
 */

import { db } from "@anthers/db/client";
import {
	creatorCredits,
	creatorNettingApplications,
	creatorNettings,
	type disputes,
	type purchases,
} from "@anthers/db/schema";
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { and, eq, isNull, sql } from "drizzle-orm";

const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

type Purchase = typeof purchases.$inferSelect;
type Dispute = typeof disputes.$inferSelect;

/** The kind of a compensating credit row — `creator_credits.kind`'s netting-reversal value. */
export const NETTING_REVERSAL_KIND = "netting_reversal";

/**
 * Open netting for one creator: the rows whose applications have not consumed them and
 * whose dispute (if any) was not won. Ordered oldest-first, because recovery runs in the
 * order the money left — the same reasoning as every other money sweep here.
 */
export async function openNettingFor(creatorId: number) {
	const rows = await db
		.select({
			id: creatorNettings.id,
			amount: creatorNettings.amount,
			applied: sql<string>`COALESCE(SUM(${creatorNettingApplications.amount}) FILTER (
				WHERE ${creatorNettingApplications.reversedAt} IS NULL
			), 0)`,
		})
		.from(creatorNettings)
		.leftJoin(
			creatorNettingApplications,
			eq(creatorNettingApplications.nettingId, creatorNettings.id),
		)
		.where(and(eq(creatorNettings.creatorId, creatorId), isNull(creatorNettings.reversedAt)))
		.groupBy(creatorNettings.id);
	return rows
		.map((r) => ({
			id: r.id,
			/** How much of this netting is still to recover — floored at zero and dies there. */
			remaining: CENTS(Decimal.max(0, new Decimal(r.amount).minus(new Decimal(r.applied)))),
		}))
		.filter((r) => r.remaining.greaterThan(0));
}

/**
 * Write a netting row for a purchase dispute — the chargeback path.
 *
 * Called by the webhook's `charge.dispute.created` branch after `recordDisputeCreated`,
 * with the dispute row and the purchase row it landed on. The netting amount is the
 * purchase row's own `creatorEarnings`: the earnings the creator received for a sale that
 * has now been undone — never the buyer's full charge, never the tax, never the
 * platform's share.
 *
 * Idempotent on the dispute: the `uq_creator_nettings_dispute` unique is the mechanism, so
 * a redelivered event finds the row and changes nothing — the same shape as the dispute
 * insert itself. A dispute with no purchase behind it has no share to net, and a purchase
 * with no creator has nobody to recover from: both no-op, because a netting row with no
 * creator would be a receivable nobody can ever read.
 */
export async function recordNettingForDispute(
	dispute: Dispute,
	purchase: Purchase | null,
	now: Date,
): Promise<void> {
	if (!purchase || purchase.creatorId == null) return;
	const amount = new Decimal(purchase.creatorEarnings);
	if (!amount.greaterThan(0)) return;

	await db
		.insert(creatorNettings)
		.values({
			creatorId: purchase.creatorId,
			disputeId: dispute.id,
			amount: amount.toFixed(2),
			openedAt: now,
		})
		.onConflictDoNothing({ target: creatorNettings.disputeId });
}

/**
 * Write a netting row for a purchase refund whose transfer reversal did not recover the
 * creator's share — the paid-out case.
 *
 * Called from `settleRefundedPurchase` with the refund's `source_transfer_reversal` (absent
 * on the route's own refund, which asked for `reverse_transfer` and reads it off the Refund
 * object before ever getting here): a refund that comes back with no transfer reversal is
 * money Anthers could not claw back at Stripe, so it becomes a netting row instead. The
 * amount is the row's `creatorEarnings` — the same share `reverse_transfer` would have
 * clawed back, by `refunds.ts`'s settled arithmetic.
 *
 * Idempotent on the refund's Stripe id: a redelivered `charge.refunded` finds the row and
 * changes nothing. A refund with no Stripe id (a legacy row) has no identity to be
 * idempotent on and is skipped rather than guessed at — writing an unidentifiable netting
 * row is worse than missing one, because the row's recovery has no bound.
 */
export async function recordNettingForRefund(
	purchase: Purchase,
	stripeRefundId: string | null | undefined,
	now: Date,
): Promise<void> {
	if (!stripeRefundId || purchase.creatorId == null) return;
	const amount = new Decimal(purchase.creatorEarnings);
	if (!amount.greaterThan(0)) return;

	await db
		.insert(creatorNettings)
		.values({
			creatorId: purchase.creatorId,
			purchaseId: purchase.id,
			stripeRefundId,
			amount: amount.toFixed(2),
			openedAt: now,
		})
		// The (refund, purchase) pair — a basket refunds as a basket, so one refund
		// settles several siblings and each sibling's netting is its own row under it.
		.onConflictDoNothing({ target: [creatorNettings.stripeRefundId, creatorNettings.purchaseId] });
}

/**
 * Reverse a netting row when its dispute was contested and won — the money came back to
 * Anthers, so whatever of it was recovered goes back to the creator.
 *
 * The honest mechanics, per the task's own framing:
 *
 *   • **Nothing was applied** — the row is dead: `reversedAt` is stamped (the
 *     `reversedAt IS NULL` predicate is its own latch, so a redelivered close event is a
 *     no-op), it derives as closed, and no application row will ever name it.
 *   • **Some was applied** — the applications happened and stay on the record, stamped
 *     `reversedAt` so they no longer count as recovery, and a **compensating credit** is
 *     written: a positive `creator_credits` row of kind `netting_reversal`, which the
 *     transfer step moves like any other credit. The creator is paid back exactly what
 *     was netted — the task's own words — and never a cent more, because the compensating
 *     amount is the sum of the reversed applications, not the netting's original amount.
 *
 * One transaction, because the reversal's halves describe one decision — the same shape
 * as the transfer job's transfer-and-coverage write. The compensating credit carries
 * `settledAt: now`, so its own 14-day hold runs from the reversal — the money is not
 * "held" before it exists.
 */
export async function reverseNettingForWonDispute(disputeId: number, now: Date): Promise<void> {
	await db.transaction(async (tx) => {
		// The latch is the update's own predicate: a second call (a redelivered close) finds
		// `reversedAt` set and stops before writing any compensation.
		const [row] = await tx
			.update(creatorNettings)
			.set({ reversedAt: now })
			.where(and(eq(creatorNettings.disputeId, disputeId), isNull(creatorNettings.reversedAt)))
			.returning();
		if (!row) return;

		// Reverse the applications and measure what was actually recovered, so the
		// compensation is exactly what the creator lost — no application rows means the
		// none-applied case, and no compensation is owed.
		const reversed = await tx
			.update(creatorNettingApplications)
			.set({ reversedAt: now })
			.where(
				and(
					eq(creatorNettingApplications.nettingId, row.id),
					isNull(creatorNettingApplications.reversedAt),
				),
			)
			.returning({ amount: creatorNettingApplications.amount });

		const compensated = CENTS(reversed.reduce((total, r) => total.plus(r.amount), new Decimal(0)));
		if (compensated.lessThanOrEqualTo(0) || row.creatorId == null) return;

		await tx.insert(creatorCredits).values({
			creatorId: row.creatorId,
			subscriberId: null,
			// The cycle the reversal lands in, because the column is NOT NULL and the
			// credit is nobody's month — it is a compensation for a sale, credited the
			// moment the bank ruled. The cycle key is what every reader groups by, so an
			// honest "not from any month" is impossible to store; the month it lands in is
			// the least-dishonest answer, and the `kind` is what tells a reader what it is.
			billingCycle: cycleKeyFor(now),
			kind: NETTING_REVERSAL_KIND,
			fundedBy: "anthers",
			amount: compensated.toFixed(2),
			settledAt: now,
		});
	});
}

/**
 * The recovery plan for one creator's held set: which open netting would consume how much
 * of which credit, and what the post-netting sum is. **Read-only** — the transfer job
 * computes the plan before its Stripe call and writes the application rows inside its own
 * transaction, so the plan and the write can never disagree across a crash.
 *
 * ⭐ **That split is the whole crash-window answer, and the brief's question — "does the
 * key change?" — turns on it.** The job's idempotency key names the sorted **coverage
 * set** (the credit ids), and netting changes the amount, never the set, so a retry
 * replays the same key. But netting must never commit anywhere the transfer row does not:
 * a netting application that landed while its transfer row did not would make the retry
 * re-derive a *larger* post-netting sum (the netting is already applied, so nothing is
 * left to subtract) while Stripe replays the original, smaller transfer — the record
 * would then say more money moved than Stripe moved, silently, which is the exact class of
 * defect the crash-window mechanism exists to prevent. Computing read-only and writing in
 * the job's own transaction makes the application rows and the transfer row one decision:
 * both land or neither does, the retry re-derives the same plan from the same state, and
 * **neither moves nor nets twice.** (The alternative the brief named — netting as its own
 * step keyed on the netting row — is strictly worse here: netting's idempotency is already
 * by construction (the (netting, credit) pair and the re-derived remainder), and a
 * separate keyed step would add a second crash window rather than close the first.)
 *
 * `sum` is floored at zero and dies there: netting that exceeds the held credits consumes
 * all of it, transfers nothing, and its own remainder stays open for the next run — never
 * an account debit, never a bill.
 */
export interface NettingPlan {
	/** The application rows to write, one per (netting, credit) the plan consumes. */
	applications: { nettingId: number; creditId: number; amount: string }[];
	/** The held sum after netting — what the job transfers. */
	sum: Decimal;
}

export async function nettingPlanFor(
	creatorId: number,
	credits: { id: number; amount: string }[],
): Promise<NettingPlan> {
	const open = await openNettingFor(creatorId);
	const rawSum = credits.reduce((total, c) => total.plus(c.amount), new Decimal(0));
	if (open.length === 0 || !rawSum.greaterThan(0)) return { applications: [], sum: CENTS(rawSum) };

	// Recovery runs in the order the money left: oldest netting first, oldest credit
	// first, the same rule every money sweep here follows.
	open.sort((a, b) => a.id - b.id);

	let sum = rawSum;
	const applications: NettingPlan["applications"] = [];

	for (const netting of open) {
		let remaining = netting.remaining;
		for (const credit of credits) {
			if (remaining.lessThanOrEqualTo(0)) break;
			const available = new Decimal(credit.amount).minus(
				// What earlier nettings already consumed from this credit — an application
				// row per (netting, credit), so one credit can be consumed piecemeal across
				// nettings and the pair's uniqueness holds.
				applications
					.filter((a) => a.creditId === credit.id)
					.reduce((t, a) => t.plus(a.amount), new Decimal(0)),
			);
			if (available.lessThanOrEqualTo(0)) continue;
			const consumed = CENTS(Decimal.min(available, remaining));
			applications.push({
				nettingId: netting.id,
				creditId: credit.id,
				amount: consumed.toFixed(2),
			});
			remaining = CENTS(remaining.minus(consumed));
			sum = sum.minus(consumed);
		}
		// Whatever this netting could not consume stays open — no application row is
		// written for the remainder, so the next run derives it as open again.
	}

	return { applications, sum: CENTS(Decimal.max(0, sum)) };
}

/**
 * Write a recovery plan's application rows, inside the caller's transaction — the one
 * the transfer job's transfer row and coverage rows land in, so the recovery and the
 * movement are a single decision (see `nettingPlanFor` for the crash-window reasoning).
 */
export async function applyNettingPlan(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	applications: NettingPlan["applications"],
): Promise<void> {
	if (applications.length === 0) return;
	await tx.insert(creatorNettingApplications).values(applications).onConflictDoNothing();
}
