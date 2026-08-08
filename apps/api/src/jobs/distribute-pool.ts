// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pool distribution job: distribute the Time Pool and directed Seeds to creators.
 *
 * For each active account:
 * 1. Sum watch-time seconds per creator during the billing cycle.
 * 2. Time Pool = $1.50 per Anthers-Seed the viewer holds, distributed
 *    proportionally by watch-time. A higher rank = a bigger pool, so all of that
 *    viewer's watch-time pays creators more — no per-item multiplier.
 * 3. Seeds: directed Seeds are credited **NET** of the creator side's pro-rata share
 *    of the at-cost card fee (`paymentsSplit`), which is what `fees.ts` has always
 *    said a creator actually receives. There are no undirected creator-Seeds — a Seed
 *    is either directed to a creator or held as an Anthers-Seed (which funds the Time
 *    Pool + the remainder, settled in settle-cycle).
 * 4. Create/update PoolDistribution ledger entries.
 *
 * The Time Pool is NOT reduced by any of this. It is a fixed $1.50-per-Seed target
 * and the Anthers side's own remainder absorbs its share of the fee, so creator pay
 * from the Time Pool is exactly what the model promises.
 *
 * > Until 2026-08-08 this job credited the GROSS $3.00 while `fees.ts` and
 * > `economics.test.ts` both said $2.61 for an unbatched Seed, so the ledger and the
 * > model disagreed by the card fee. Nothing else deducted it, which meant Anthers
 * > silently absorbed ~$0.39 on every Seed from a pure-direct user — an account with
 * > no remainder for it to come out of. Parker's call: `fees.ts` is correct in full,
 * > processing comes out of the creator's side, and a single-Seed card transaction is
 * > the worst case. **`poolDistributions.seedAmount` is a payout figure, so it holds
 * > NET.** The gross a user chose to give is still on `seed_allocations.amount`,
 * > which is the record of the gift rather than of the payment, and is untouched.
 */

import { db } from "@anthers/db";
import { accounts, attentionEvents, poolDistributions, seedAllocations } from "@anthers/db/schema";
import { SEED_PRICE, timePoolFor } from "@anthers/shared/constants";
import { paymentsSplit } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, gte, lt, sum } from "drizzle-orm";

export interface DistributePoolData {
	/** If set, distribute for a single account. Otherwise all active accounts. */
	accountId?: number;
}

/** Round to cents the same way `fees.ts` does, so the two never disagree by a penny. */
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** The Time Pool a user funds this cycle = $1.50 per Anthers-Seed (subsidised at rank 0). */
function computeTimePoolAmount(anthersSeeds: number): Decimal {
	return new Decimal(timePoolFor(anthersSeeds));
}

function getBillingCycle(acct: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null }) {
	if (acct.currentPeriodStart && acct.currentPeriodEnd) {
		return { start: acct.currentPeriodStart, end: acct.currentPeriodEnd };
	}
	// Fallback to current calendar month
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	return { start, end };
}

/** Returns YYYY-MM-01 string for Drizzle date columns. */
function billingCycleDate(cycleStart: Date): string {
	const y = cycleStart.getFullYear();
	const m = String(cycleStart.getMonth() + 1).padStart(2, "0");
	return `${y}-${m}-01`;
}

interface Dist {
	poolAmount: Decimal;
	seedAmount: Decimal;
	attentionSeconds: number;
}

async function distributeForAccount(acct: {
	id: number;
	userId: number;
	anthersSeeds: number;
	currentPeriodStart: Date | null;
	currentPeriodEnd: Date | null;
}) {
	const { start, end } = getBillingCycle(acct);
	const cycleDate = billingCycleDate(start);

	// 1. Aggregate watch-time per creator
	const attentionRows = await db
		.select({
			creatorId: attentionEvents.creatorId,
			totalSeconds: sum(attentionEvents.durationSeconds).as("total_seconds"),
		})
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, acct.userId),
				gte(attentionEvents.createdAt, start),
				lt(attentionEvents.createdAt, end),
			),
		)
		.groupBy(attentionEvents.creatorId);

	const attentionByCreator = new Map<number, number>();
	let totalAttention = 0;
	for (const row of attentionRows) {
		const seconds = Number(row.totalSeconds);
		if (seconds > 0) {
			attentionByCreator.set(row.creatorId, seconds);
			totalAttention += seconds;
		}
	}

	const distributions = new Map<number, Dist>();
	const ensure = (creatorId: number): Dist => {
		let d = distributions.get(creatorId);
		if (!d) {
			d = { poolAmount: new Decimal(0), seedAmount: new Decimal(0), attentionSeconds: 0 };
			distributions.set(creatorId, d);
		}
		return d;
	};

	// 2. Directed Seeds → credited NET of the creator side's share of the at-cost card
	//    fee. (Undirected Seeds are NOT distributed here — the user must direct them;
	//    the remainder is settled to the subsidy pool in settle-cycle.ts.)
	const directed = await db
		.select()
		.from(seedAllocations)
		.where(
			and(eq(seedAllocations.userId, acct.userId), eq(seedAllocations.billingCycle, cycleDate)),
		);

	let grossDirected = new Decimal(0);
	for (const seed of directed) {
		const gross = new Decimal(seed.amount);
		ensure(seed.creatorId).seedAmount = gross;
		grossDirected = grossDirected.plus(gross);
	}

	// The card fee is charged once on the WHOLE batched monthly charge and split
	// pro-rata, so a user who also gives Seeds to Anthers amortises the fixed $0.30
	// and every creator on that charge is paid more. Worst case is a single directed
	// Seed alone: $3.00 gross → $2.61 net.
	if (grossDirected.gt(0)) {
		const creatorFee = paymentsSplit(
			acct.anthersSeeds,
			grossDirected.div(SEED_PRICE).toNumber(),
		).creator;
		if (creatorFee.gt(0)) {
			for (const d of distributions.values()) {
				if (d.seedAmount.lte(0)) continue;
				// Each creator bears the fee in proportion to what was directed at them.
				const share = CENTS(creatorFee.mul(d.seedAmount).div(grossDirected));
				d.seedAmount = Decimal.max(0, d.seedAmount.minus(share));
			}
			// Conserve exactly: rounding must not leave Anthers over- or under-paying.
			correctDrift(
				distributions,
				grossDirected.minus(creatorFee),
				(d) => d.seedAmount,
				(d, v) => {
					d.seedAmount = v;
				},
			);
		}
	}

	// 3. Distribute the Time Pool proportionally by watch-time.
	const timePool = computeTimePoolAmount(acct.anthersSeeds);
	if (totalAttention > 0 && timePool.gt(0)) {
		for (const [creatorId, seconds] of attentionByCreator) {
			const proportion = new Decimal(seconds).div(totalAttention);
			const d = ensure(creatorId);
			d.attentionSeconds = seconds;
			d.poolAmount = d.poolAmount.plus(
				timePool.mul(proportion).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
			);
		}

		// Correct rounding drift against the largest allocation so the pot is conserved.
		correctDrift(
			distributions,
			timePool,
			(d) => d.poolAmount,
			(d, v) => {
				d.poolAmount = v;
			},
		);
	}

	// Record watch-time even for creators that only received a directed Seed.
	for (const [creatorId, seconds] of attentionByCreator) {
		ensure(creatorId).attentionSeconds = seconds;
	}

	// 4. Write PoolDistribution ledger entries
	for (const [creatorId, data] of distributions) {
		if (data.poolAmount.lte(0) && data.seedAmount.lte(0)) continue;
		await db
			.insert(poolDistributions)
			.values({
				subscriberId: acct.userId,
				creatorId,
				billingCycle: cycleDate,
				poolAmount: data.poolAmount.toString(),
				seedAmount: data.seedAmount.toString(),
				attentionSeconds: data.attentionSeconds,
			})
			.onConflictDoUpdate({
				target: [
					poolDistributions.subscriberId,
					poolDistributions.creatorId,
					poolDistributions.billingCycle,
				],
				set: {
					poolAmount: data.poolAmount.toString(),
					seedAmount: data.seedAmount.toString(),
					attentionSeconds: data.attentionSeconds,
				},
			});
	}
}

/** Push any rounding drift between the target and the summed allocations onto the largest one. */
function correctDrift(
	distributions: Map<number, Dist>,
	target: Decimal,
	get: (d: Dist) => Decimal,
	set: (d: Dist, v: Decimal) => void,
) {
	if (distributions.size === 0) return;
	let total = new Decimal(0);
	for (const d of distributions.values()) total = total.plus(get(d));
	const drift = target.minus(total);
	if (drift.isZero()) return;
	let largest: Dist | null = null;
	for (const d of distributions.values()) {
		if (!largest || get(d).gt(get(largest))) largest = d;
	}
	if (largest) set(largest, get(largest).plus(drift));
}

export async function distributePool(data: DistributePoolData) {
	const accts = data.accountId
		? await db
				.select()
				.from(accounts)
				.where(and(eq(accounts.id, data.accountId), eq(accounts.isActive, true)))
		: await db.select().from(accounts).where(eq(accounts.isActive, true));

	let processed = 0;
	for (const acct of accts) {
		try {
			await distributeForAccount(acct);
			processed++;
		} catch (error) {
			console.error(`Pool distribution failed for user ${acct.userId}:`, error);
		}
	}

	console.log(`Pool distribution complete: ${processed} accounts processed`);
	return processed;
}
