// SPDX-License-Identifier: Apache-2.0
/**
 * The purchase split — the one writer of `purchases.stripe_transfer_id`, and the half of
 * the multi-creator basket decision that moves money (Parker, 2026-10-15).
 *
 * 🚨 **Purchases are platform charges, not destination charges.** A destination charge
 * pinned the creator's transfer inside the charge (`transfer_data[amount]`), which names
 * exactly one connected account — the constraint that forced the one-creator basket. The
 * split decision removed the constraint rather than accepting it: the buyer is charged
 * once, to the platform, and each distinct creator's share moves out **at completion** as
 * one transfer funded by the charge (`source_transaction`), for the exact sum of that
 * creator's rows' recorded earnings. The amount never varies with the buyer's location
 * because the earnings were pinned at checkout; the tax stays on the platform side by
 * construction, exactly as it did under the destination-charge shape, because it never
 * entered a transfer and Anthers is the marketplace facilitator and the liability.
 *
 * The money's dwell on the platform balance is seconds rather than the ~six-week hold
 * monthly support already runs, and the merchant-of-record posture is the decided one —
 * the reasoning, the precedent and the accepted cost are the counsel brief's
 * "A basket spanning two creators" decision record (Internal Wiki doc 26), which is the
 * authority for this module existing in this shape.
 *
 * ⚠️ **A transfer that fails at completion is a debt, not a loss.** The rows stay
 * `stripe_transfer_id`-null, the failure is logged, and `retryFailedTransfers` re-attempts
 * it with the same idempotency key on a schedule — an untransferred share joins the escheat
 * flank support's accrued balances already carry rather than disappearing. What the retry
 * never does is pay a dead purchase: only `completed` rows transfer, so a purchase that
 * refunded or disputed in the window owes no transfer at all, and the creator's share of
 * a refund-before-transfer is recovered by not sending it.
 *
 * 🚨 **The idempotency key is derived from (PaymentIntent, creator) and never varies
 * between the completion attempt and every retry** — a crash between the Stripe call and
 * the row stamping cannot double-transfer, because the replay returns the same Transfer.
 * The support cycle's transfer job (`jobs/transfer-held-credits.ts`) carries the same
 * reasoning for its own keys.
 */
import { db } from "@anthers/db/client";
import {
	creatorCredits,
	creatorTransferCredits,
	purchases,
	stripeConnectAccounts,
} from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import Decimal from "decimal.js";
import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { createTransfer, paymentsConfigured } from "../lib/processor.js";

type Purchase = typeof purchases.$inferSelect;

/** The charge a completion event carries — all this module needs of a PaymentIntent. */
export interface ChargeRef {
	id: string;
	/** The charge the transfers draw from (`source_transaction`). */
	latestCharge: string | null;
}

/** The idempotency key for one creator's share of one charge — stable across retries. */
function transferKey(intentId: string, creatorId: number): string {
	return `purchase_transfer_${intentId}_${creatorId}`;
}

/**
 * Create (or idempotently re-create) one creator's transfer for a charge, and stamp the
 * rows it covers. Returns the Transfer id, or null with the reason logged — a null that
 * leaves the rows unstamped is the retry job's worklist, never a silent loss.
 */
async function transferCreatorShare(
	charge: ChargeRef,
	creatorId: number,
	rows: Purchase[],
): Promise<string | null> {
	const earnings = rows.reduce(
		(acc, r) => acc.plus(new Decimal(r.creatorEarnings)),
		new Decimal(0),
	);
	if (earnings.lte(0)) return null;

	const [account] = await db
		.select()
		.from(stripeConnectAccounts)
		.where(eq(stripeConnectAccounts.userId, creatorId))
		.limit(1);
	// The checkout's precondition verified this account minutes ago; a state change in
	// the window is exactly the kind of failure the retry job exists to outlast, so it is
	// logged and left rather than refused permanently.
	if (!account?.onboardingComplete || !account.payoutsEnabled) {
		console.error(
			`purchase split: creator ${creatorId} cannot take a transfer for charge ${charge.id} — the retry job owns it`,
		);
		return null;
	}

	// Funded by the charge and by nothing else — `source_transaction` is load-bearing, not
	// decoration: without it the transfer draws from the platform balance generally rather
	// than from this buyer's payment, which is exactly the conduit shape the decision
	// exists to avoid. A PaymentIntent whose charge cannot be named (the event shape
	// degraded, a retrieve that failed) is therefore NOT transferable yet: skip, log, and
	// the retry job resolves the charge live and pays the debt.
	if (!charge.latestCharge) {
		console.error(
			`purchase split: no charge to fund the transfer for ${charge.id}, creator ${creatorId} — the retry job owns it`,
		);
		return null;
	}

	try {
		const transfer = await createTransfer(
			{
				amount: Math.round(earnings.toNumber() * 100),
				currency: "usd",
				destination: account.stripeAccountId,
				source_transaction: charge.latestCharge,
				metadata: {
					kind: "purchase_split",
					paymentIntentId: charge.id,
					creatorId: String(creatorId),
				},
			},
			{ idempotencyKey: transferKey(charge.id, creatorId) },
		);
		if (!transfer?.id) throw new Error("Stripe returned no transfer");
		await db
			.update(purchases)
			.set({ stripeTransferId: transfer.id, updatedAt: new Date() })
			.where(
				inArray(
					purchases.id,
					rows.map((r) => r.id),
				),
			);
		return transfer.id;
	} catch (err) {
		console.error(
			`purchase split for charge ${charge.id}, creator ${creatorId} failed: ${err instanceof Error ? err.message : "unknown error"} — the retry job owns it`,
		);
		return null;
	}
}

/**
 * Settle a completed charge: group its rows by creator and move each creator's share out.
 *
 * Called from `completeSessionPurchases` with the rows the session just stamped — the
 * grouping skips rows with no creator (merch is Anthers' own goods and pays no transfer)
 * and leaves every failure to the retry path. Rows that share a creator share one
 * transfer; that is the point of the column being per-row.
 *
 * 🚨 **A physical good does not transfer here.** Its share is credited to
 * `creator_credits` instead, and moves when the parcel lands and the complaint window
 * closes — the support cycle's own mechanism with a different trigger
 * (`jobs/transfer-held-credits.ts`). A good that has not shipped must not have paid out,
 * and the transfer job already owns every property a hold needs: idempotency across a
 * crash, netting before the money leaves, payout standing, and a suspended creator's money
 * waiting. Building a second hold would mean a second set of those decisions to keep in
 * step with the first.
 */
export async function splitChargeToCreators(charge: ChargeRef, rows: Purchase[]): Promise<void> {
	if (!paymentsConfigured()) return;
	const byCreator = new Map<number, Purchase[]>();
	const goods: Purchase[] = [];
	for (const row of rows) {
		if (row.creatorId == null) continue;
		if (row.type === "physical") {
			goods.push(row);
			continue;
		}
		const group = byCreator.get(row.creatorId);
		if (group) group.push(row);
		else byCreator.set(row.creatorId, [row]);
	}
	for (const [creatorId, group] of byCreator) {
		await transferCreatorShare(charge, creatorId, group);
	}
	await creditGoodsSales(goods);
}

/**
 * Write the credit a physical sale is owed — the money, parked where the release clock can
 * find it.
 *
 * One credit per purchase rather than one per charge: the release question is asked per
 * order (did *this* parcel land, and is *this* buyer's complaint open), and a creator's two
 * mugs on one charge have two parcels and two windows.
 *
 * ⚠️ **Idempotent on the purchase**, because completion can be redelivered: a credit whose
 * `purchase_id` already exists is left alone, so a replay cannot double the money.
 */
async function creditGoodsSales(rows: Purchase[]): Promise<void> {
	for (const row of rows) {
		if (row.creatorId == null) continue;
		const amount = new Decimal(row.creatorEarnings);
		if (amount.lte(0)) continue;
		await db
			.insert(creatorCredits)
			.values({
				creatorId: row.creatorId,
				subscriberId: row.buyerId,
				billingCycle: currentCycleKey(),
				kind: "sale",
				fundedBy: "buyer",
				amount: amount.toFixed(2),
				settledAt: new Date(),
				purchaseId: row.id,
			})
			.onConflictDoNothing();
	}
}

/**
 * The retry half — the worklist of transfers the completion path could not make, and the
 * escheat flank's front line. Returns how many groups were attempted.
 *
 * Scans `completed` rows with a live creator and no transfer id, groups them by
 * (PaymentIntent, creator) — the same grouping `splitChargeToCreators` made — and
 * re-attempts each through the same idempotency key, so a crash between Stripe's call and
 * the row stamping replays the original transfer rather than a second one.
 *
 * 🚨 Only `completed` rows match, which is the whole safety property: a purchase that
 * refunded or disputed in the window never transfers, because the buyer's money for that
 * item is already gone from the charge the transfer draws from. There is no lookback
 * bound on age — an old untransferred share is owed exactly as much as a fresh one, and
 * "the creator will never earn again" is not a fact this system can know.
 */
export async function retryFailedTransfers(): Promise<number> {
	if (!paymentsConfigured()) return 0;
	const rows = await db
		.select()
		.from(purchases)
		.where(
			and(
				eq(purchases.status, "completed"),
				isNotNull(purchases.creatorId),
				isNull(purchases.stripeTransferId),
				// 🚨 A physical good's share is never this job's to send: it is held in
				// `creator_credits` until the parcel lands, and the credit is what the transfer
				// job moves. Without this exclusion the retry path would pay the creator at once
				// — the exact defect the hold exists to prevent — and then the credit would pay
				// them again after delivery.
				ne(purchases.type, "physical"),
			),
		);
	if (rows.length === 0) return 0;

	// One group per (intent, creator) — the transfer identity the key already names. The
	// intent id is the row's charge key wherever the row has settled; a row still keyed by
	// its session id (a completion that never landed) is not transferable at all and is
	// skipped by the `cs_` prefix check below, because no charge exists to draw from.
	const groups = new Map<string, Purchase[]>();
	for (const row of rows) {
		if (row.stripePaymentIntentId.startsWith("cs_")) continue;
		const key = `${row.stripePaymentIntentId}:${row.creatorId}`;
		const group = groups.get(key);
		if (group) group.push(row);
		else groups.set(key, [row]);
	}

	// The charge id each group's transfer draws from. The rows carry the PaymentIntent;
	// the charge is resolved live, because the purchase rows never held it — one read per
	// distinct intent, shared by every creator's share of that intent.
	const { retrievePaymentIntent } = await import("../lib/processor.js");
	const chargeByIntent = new Map<string, string | null>();
	let attempted = 0;
	for (const [key, group] of groups) {
		const [intentId, creatorIdRaw] = key.split(":");
		const creatorId = Number(creatorIdRaw);
		let latestCharge = chargeByIntent.get(intentId);
		if (latestCharge === undefined) {
			const pi = await retrievePaymentIntent(intentId, {});
			latestCharge =
				typeof pi?.latest_charge === "string" ? pi.latest_charge : (pi?.latest_charge?.id ?? null);
			chargeByIntent.set(intentId, latestCharge);
		}
		attempted += 1;
		await transferCreatorShare({ id: intentId, latestCharge }, creatorId, group);
	}
	return attempted;
}

/** What happened to a physical sale's credit when its purchase was refunded. */
export type SaleCreditRefundState = "none" | "held" | "released";

/**
 * Settle a sale's hold at the moment its purchase is refunded.
 *
 * 🚨 **Two different facts, and the refund path needs both.** A sale credit that has not
 * been covered by a transfer is money the creator never received: the refund takes the
 * credit away, and nothing else has to happen. A credit that HAS been transferred is money
 * that already reached them, so the refund has to recover it like any other paid-out share —
 * the netting ledger's job, exactly as it is for a support credit.
 *
 * Returns which of the three cases applied so the caller can pass `creatorWasPaid` honestly.
 * A purchase with no credit at all (`none`) is a row from before the hold existed, and the
 * caller's own transfer-id check still governs it.
 */
export async function settleSaleCreditOnRefund(purchaseId: number): Promise<SaleCreditRefundState> {
	const [credit] = await db
		.select({ id: creatorCredits.id })
		.from(creatorCredits)
		.where(eq(creatorCredits.purchaseId, purchaseId))
		.limit(1);
	if (!credit) return "none";

	const [coverage] = await db
		.select({ transferId: creatorTransferCredits.transferId })
		.from(creatorTransferCredits)
		.where(eq(creatorTransferCredits.creditId, credit.id))
		.limit(1);
	if (coverage) return "released";

	// Never transferred: the credit goes, and the money that would have moved never does.
	await db.delete(creatorCredits).where(eq(creatorCredits.id, credit.id));
	return "held";
}
