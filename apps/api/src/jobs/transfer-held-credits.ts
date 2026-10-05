// SPDX-License-Identifier: Apache-2.0
/**
 * The transfer step — a creator's settled money, moved into their connected account
 * fourteen days after it settled (Parker, 2026-09-14).
 *
 * Settlement (`settle-cycle.ts`) credits what a creator is owed into `creator_credits`,
 * and until this job nothing moved it. Each credit's row is stamped with its own
 * `settledAt` — the run that wrote it — and that is where its hold starts:
 *
 *   1. 🚨 **The hold is 14 days from each credit's own `settledAt`, never from a
 *      month-level date.** An invoice paid late in Stripe's retries settles in a later
 *      run, and its money must neither jump ahead of money credited earlier nor restart
 *      the clock on money already held. A credit is transfer-eligible exactly when its
 *      own `settledAt` is ≥14 days past.
 *   2. **Only to a creator who can be paid.** `payoutStanding().ready`
 *      (`services/payouts.ts`: `onboardingComplete && payoutsEnabled`) is the gate; a
 *      creator whose account is not ready accumulates — the credits stay in
 *      `creator_credits`, untransferred — and transfer later once ready. Money is never
 *      dropped, and a creator is never paid into an account Stripe will not send money
 *      to.
 *   3. **No threshold.** Whatever is settled and held transfers, per the decision: "A
 *      payout only has to be larger than its own fees" — that is the creator's
 *      manual-payout choice at Stripe, not ours. (The connected accounts use manual
 *      payouts, so the creator chooses when to go to their bank and bears those fees.)
 *
 * ⭐ **Idempotency across the crash window — one Stripe call per coverage set, and the
 * idempotency key is derived from it.** The failure that matters is: Stripe accepts the
 * transfer, and the process dies before the DB write lands. A naive retry would re-select
 * the same held credits (nothing marks them yet), call Stripe again, and move the money
 * twice. The mechanism, in order:
 *
 *   - **The idempotency key is the sorted coverage set**, `transfer_<creditId>…` joined
 *     by `_`, prefixed by the creator id. It is deterministic: the same uncovered credits
 *     re-selected on retry produce the same key, so Stripe replays the original transfer
 *     and returns it rather than creating a second. A *different* coverage set — new
 *     credits have since crossed their own hold, or others settled — is a different key
 *     and a genuinely different transfer, which is correct: it is different money.
 *   - **The transfer row is written AFTER the Stripe call, in one transaction with its
 *     coverage rows** — the two describe one decision, exactly like a settlement's credits
 *     and stamps. The window before that write is what the idempotency key closes.
 *   - **The `stripe_transfer_id` is unique.** Even a key collision that somehow produced a
 *     second Stripe call cannot write a second row for it.
 *   - **A credit is covered exactly when a coverage row names it** — `creator_transfers`
 *     and `creator_transfer_credits` are append-only (no status column, nothing is ever
 *     updated), so "held" is always re-derivable as "no coverage row names it", and a
 *     re-run after any crash finds the true remaining set by asking that question.
 *
 * ⚠️ **Negative sums skip, but a zero sum is still closed.** A credit can be negative (a
 * correction); the sum over the whole held set is what transfers, and it may never go
 * below zero — the platform does not transfer money *from* a creator. When the sum is
 * exactly zero the set is still settled-up, so it is closed as an append-only
 * transfer row with amount "0.00" and **no Stripe call** — a no-op transfer is a movement
 * of nothing, and the books should not record a movement that never happened. The row's
 * transfer id carries a `tr_local_zerosum_` prefix, so it can never collide with a real
 * Stripe id and a user (or a future reversal build) can tell them apart on sight.
 * Marking the set covered is what keeps the next run from re-reading it. A sum that is
 * negative is the monthly-support reversal half's input — a credit the reversal build
 * (`markInvoiceMoneyReturned` and the correction credits) has already written — and is
 * left uncovered with a log line, because that money is that build's to move, not this
 * job's to guess at.
 *
 * ⭐ **Netting runs here — this is the recovery moment (Parker, 2026-09-14, "Money That
 * Came Back").** Before a creator's held sum moves, the netting module first reduces it
 * by that creator's open netting — their share of returned money (a dispute or an
 * after-transfer refund), recorded in `creator_nettings` and applied through
 * `services/netting.ts`, the one writer of that ledger. The order is: negative pre-netting
 * sum skips untouched (reversal build's input), otherwise netting applies, and the
 * post-netting sum is what transfers — floored at zero, so netting that exceeds held
 * credits transfers nothing and the netting stays open. **The crash-window latch is
 * unchanged by netting**: the idempotency key names the sorted coverage SET, netting
 * changes the amount but never the set, so a retry replays the same key and Stripe
 * returns the original transfer — see `applyNettingsToHeldCredits` for the full
 * crash-window reasoning and the one residual edge it accepts.
 *
 * 🚨 **Not while suspended.** `payoutStanding().ready` does not know about suspensions;
 * a suspended creator's money is held behind a review
 * (`services/payouts.ts` — investigative, never punitive). This job deliberately checks
 * `users.suspendedAt` itself and leaves a suspended creator's credits to accumulate,
 * because transferring money the review may find tainted spends the answer before the
 * question is asked. On reinstatement (or the review's conclusion) the next run moves it.
 *
 * ⭐ **Idempotent by construction rather than by marker**, same as settlement: a re-run
 * re-derives what is held, finds credits already covered, and transfers only the rest.
 */
import { db } from "@anthers/db";
import {
	creatorCredits,
	creatorTransferCredits,
	creatorTransfers,
	stripeAccounts,
	users,
} from "@anthers/db/schema";
import Decimal from "decimal.js";
import { and, eq, lt, notInArray } from "drizzle-orm";
import { createTransfer, paymentsConfigured } from "../lib/processor.js";
import { applyNettingPlan, nettingPlanFor } from "../services/netting.js";
import { payoutStanding } from "../services/payouts.js";

export interface TransferHeldCreditsData {
	/**
	 * The moment the run counts holds from. Defaults to now; a test passes one so the
	 * 14-day line is a date rather than a wait. A job payload arrives as JSON, so a
	 * string is accepted.
	 */
	now?: Date | string;
	/**
	 * Transfer one creator only — an operator re-running an account whose transfer failed,
	 * and a test that must not touch whatever else the database holds. A scoped run
	 * behaves identically to a full one for that creator.
	 */
	creatorId?: number;
}

/** The hold, in days, counted from each credit's own `settledAt`. */
export const HOLD_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Whether a Stripe `transfer_group`-style local id is one of ours, never Stripe's. */
export const ZERO_SUM_TRANSFER_PREFIX = "tr_local_zerosum_";

/**
 * Transfer every creator's settled, held, eligible credits. Returns how many creators
 * had money moved (a zero-sum close counts — money questions were asked and answered).
 *
 * Quiet on a run with nothing to do, for the same reason the other sweeps are quiet: a
 * daily "0 creators" line makes the worker log unreadable, and a run that moved money
 * always logs.
 */
export async function transferHeldCredits(
	input: TransferHeldCreditsData | null = {},
): Promise<{ creators: number }> {
	// A scheduled job arrives with no data at all.
	const data = input ?? {};
	const now = data.now ? new Date(data.now) : new Date();
	const cutoff = new Date(now.getTime() - HOLD_DAYS * DAY_MS);

	// Every credit that is old enough and not yet covered by any transfer.
	const covered = db
		.selectDistinct({ creditId: creatorTransferCredits.creditId })
		.from(creatorTransferCredits);
	const held = await db
		.select({
			id: creatorCredits.id,
			creatorId: creatorCredits.creatorId,
			amount: creatorCredits.amount,
		})
		.from(creatorCredits)
		.where(
			and(
				lt(creatorCredits.settledAt, cutoff),
				data.creatorId == null ? undefined : eq(creatorCredits.creatorId, data.creatorId),
				notInArray(creatorCredits.id, covered),
			),
		)
		.orderBy(creatorCredits.id);

	// Group by creator, preserving each credit's own id — the coverage set is the
	// idempotency key, so the order the ids appear in is normalized (sorted) when the
	// key is built, not here.
	const byCreator = new Map<number, { id: number; amount: string }[]>();
	for (const row of held) {
		if (row.creatorId == null) continue; // a detached credit has nobody to transfer to
		const list = byCreator.get(row.creatorId) ?? [];
		list.push({ id: row.id, amount: row.amount });
		byCreator.set(row.creatorId, list);
	}

	let creators = 0;
	for (const [creatorId, credits] of byCreator) {
		try {
			if (await transferOneCreator(creatorId, credits, now)) creators++;
		} catch (error) {
			// One creator failing must not stop the others, and must not be silent.
			console.error(`transfer: creator ${creatorId} failed:`, error);
		}
	}

	if (creators > 0) console.log(`transfer: moved held credits for ${creators} creator(s)`);
	return { creators };
}

/**
 * The deterministic idempotency key for one coverage set: the creator and the sorted
 * credit ids. The same uncovered credits produce the same key on retry; a different
 * coverage set is different money and gets a different key.
 */
function idempotencyKeyFor(creatorId: number, creditIds: number[]): string {
	return `transfer_u${creatorId}_${[...creditIds].sort((a, b) => a - b).join("_")}`;
}

/**
 * Transfer one creator's held set. Returns whether anything moved (or closed).
 *
 * 🚨 **The three checks a set must pass, in the order they fail in:** paid-out-able,
 * not suspended, and the sum is not negative. A failure of the first two leaves the
 * credits to accumulate — this is the "never drop the money" invariant — and a
 * negative sum is a data defect worth screaming about rather than transferring.
 */
async function transferOneCreator(
	creatorId: number,
	credits: { id: number; amount: string }[],
	now: Date,
): Promise<boolean> {
	// Not-ready creators accumulate. The standing is read fresh each run, so an account
	// that finishes onboarding tonight transfers tomorrow.
	const standing = await payoutStanding(creatorId);
	if (!standing.ready) return false;

	// A suspended creator's money is behind a review; this job leaves it entirely alone.
	const [row] = await db
		.select({ suspendedAt: users.suspendedAt })
		.from(users)
		.where(eq(users.id, creatorId))
		.limit(1);
	if (row?.suspendedAt != null) return false;

	// The sum, in Decimal — money is never floated. This is the PRE-NETTING sum: the credits
	// as settlement credited them, before any returned money is recovered from them.
	const rawSum = CENTS(credits.reduce((total, c) => total.plus(c.amount), new Decimal(0)));
	const ids = credits.map((c) => c.id);
	const key = idempotencyKeyFor(creatorId, ids);

	// A negative sum must never transfer (the platform does not pull money from a
	// creator's connected account here); it is left uncovered and screamed about, because
	// money that came back is the monthly-support reversal half's to move, and a
	// correction that outweighs its set is a defect a human should hear about. Netting is
	// deliberately NOT applied to a negative set: these credits are the reversal build's
	// subject, and consuming them here would spend its input.
	if (rawSum.isNegative()) {
		console.error(
			`transfer: creator ${creatorId}'s held set sums to ${rawSum.toFixed(2)} — a correction outweighs the credits it was summed with. Leaving it uncovered for the reversal build.`,
		);
		return false;
	}

	// ⭐ The netting step (Parker, 2026-09-14, "Money That Came Back"): before this
	// creator's held sum moves, open netting — their share of returned money — is recovered
	// from it first. The plan is computed read-only here, and its application rows land in
	// the SAME transaction as the transfer row below (or the zero-sum close), because the
	// recovery and the movement are one decision — see `nettingPlanFor` for the full
	// crash-window reasoning and why the idempotency key (the coverage SET, which netting
	// never changes) is untouched by this.
	const plan = await nettingPlanFor(creatorId, credits);
	const sum = plan.sum;

	// The netting consumed everything: nothing moves, and the set still closes as a
	// zero-sum set — the "netting exceeds held" case. The netting's own remainder stays
	// open for the next run; a creator is never sent a bill for it.
	if (sum.isZero()) {
		await db.transaction(async (tx) => {
			await applyNettingPlan(tx, plan.applications);
			const [transfer] = await tx
				.insert(creatorTransfers)
				.values({
					creatorId,
					stripeTransferId: `${ZERO_SUM_TRANSFER_PREFIX}${key}`,
					amount: "0.00",
					transferredAt: now,
				})
				.onConflictDoNothing({ target: creatorTransfers.stripeTransferId })
				.returning({ id: creatorTransfers.id });
			if (transfer) {
				await tx
					.insert(creatorTransferCredits)
					.values(ids.map((creditId) => ({ transferId: transfer.id, creditId })))
					.onConflictDoNothing();
			}
		});
		return true;
	}

	// Payments unconfigured is a 503-shaped refusal everywhere else; here it is a
	// non-fatal skip — the credits accumulate and the next run moves them. The netting
	// plan is not applied: nothing moved, so nothing was recovered.
	if (!paymentsConfigured()) return false;

	// The connected account the money goes to. `payoutStanding().ready` says Stripe will
	// send money for this account, so the row exists; reading it here keeps the standing
	// check the single gate rather than adding a second, subtly-different one.
	const [account] = await db
		.select({ stripeAccountId: stripeAccounts.stripeAccountId })
		.from(stripeAccounts)
		.where(eq(stripeAccounts.userId, creatorId))
		.limit(1);
	if (!account) return false;

	const transfer = await createTransfer(
		{
			amount: sum.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
			currency: "usd",
			destination: account.stripeAccountId,
			metadata: { creatorId: String(creatorId), creditIds: ids.join(",") },
		},
		// The crash-window latch: a retry after Stripe-success/DB-failure replays this
		// exact key and Stripe returns the original transfer instead of a second one.
		{ idempotencyKey: key },
	);
	if (!transfer) return false;

	// The Stripe id, the coverage rows, and the netting recovery land in one transaction,
	// because they describe one decision — see the module docblock.
	await db.transaction(async (tx) => {
		const [written] = await tx
			.insert(creatorTransfers)
			.values({
				creatorId,
				stripeTransferId: transfer.id,
				amount: sum.toFixed(2),
				transferredAt: new Date(transfer.created * 1000),
			})
			.onConflictDoNothing({ target: creatorTransfers.stripeTransferId })
			.returning({ id: creatorTransfers.id });
		// A conflict means a retry already wrote this transfer's row; the coverage rows
		// are the same decision, and `onConflictDoNothing` below keeps them idempotent too.
		if (!written) return;
		await tx
			.insert(creatorTransferCredits)
			.values(ids.map((creditId) => ({ transferId: written.id, creditId })))
			.onConflictDoNothing();
		await applyNettingPlan(tx, plan.applications);
	});

	return true;
}
