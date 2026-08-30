// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pool distribution job: distribute the Time Pool and directed support to creators.
 *
 * For each active account:
 * 1. Sum **Public Access** time-spent seconds per creator during the billing cycle.
 * 2. Time Pool = `TIME_POOL_RATE` (half) of what the viewer gives Anthers, distributed
 *    proportionally by time. A higher Badge = a bigger pool, so all of that viewer's
 *    time pays creators more — no per-item multiplier.
 * 3. Directed support is credited **NET** of the creator side's pro-rata share
 *    of the at-cost card fee (`paymentsSplit`), which is what `fees.ts` has always
 *    said a creator actually receives. There is no undirected creator money — every
 *    dollar is either directed at a creator or given to Anthers (funding the Time
 *    Pool + the remainder, settled in settle-cycle).
 * 4. Create/update PoolDistribution ledger entries.
 *
 * The Time Pool is NOT reduced by any of this. It is a fixed share of what the user
 * gives Anthers (`TIME_POOL_RATE`) and the Anthers side's own remainder absorbs its
 * share of the fee, so creator pay from the Time Pool is exactly what the model
 * promises.
 *
 * > Until 2026-08-26 step 1 summed EVERY attention row, with no `public_access`
 * > predicate, which contradicted distributor-pays in the direction that costs the
 * > creators the pool exists for: a creator the viewer had already paid in full — by
 * > clearing a Badge gate or by buying the Work — was paid a second time out of the
 * > pool, and every Public Access creator on the same cycle was diluted by exactly
 * > that much. The money always summed correctly, which is why nothing caught it;
 * > only its destination was wrong.
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
import { supportAmount, timePoolFor } from "@anthers/shared/constants";
import { paymentsSplit } from "@anthers/shared/fees";
import { SHARE_LINK_POOL_FRACTION } from "@anthers/shared/public-access";
import Decimal from "decimal.js";
import { and, eq, gte, lt, sum } from "drizzle-orm";

export interface DistributePoolData {
	/** If set, distribute for a single account. Otherwise all active accounts. */
	accountId?: number;
}

/** Round to cents the same way `fees.ts` does, so the two never disagree by a penny. */
const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** The Time Pool a user funds this cycle = `TIME_POOL_RATE` of what they give Anthers (subsidized at $0). */
function computeTimePoolAmount(anthersSupport: number): Decimal {
	return new Decimal(timePoolFor(anthersSupport));
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

/**
 * Returns YYYY-MM-01 string for Drizzle date columns.
 *
 * Exported for `settle-cycle.ts`, which has to ask the same question this job answers —
 * which cycle key an account's period writes to — before it can decide whether that cycle
 * is closed enough to book an undistributed pool against.
 */
export function billingCycleDate(cycleStart: Date): string {
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
	anthersSupport: string;
	currentPeriodStart: Date | null;
	currentPeriodEnd: Date | null;
}) {
	const { start, end } = getBillingCycle(acct);
	const cycleDate = billingCycleDate(start);

	// 1. Aggregate **Public Access** attention seconds per creator.
	//
	// The pool pays for the commons and only for the commons. Gated work the viewer
	// cleared, work they bought, and their own catalog were all paid for by whoever
	// cleared the gate or made the purchase — distributor-pays refuses to pay twice, so
	// those seconds draw nothing here.
	//
	// 🚨 This reads the flag `attention_events.public_access` STORED when the seconds
	// were watched; it never re-resolves access against `works`. A creator can gate
	// something they had left open, or open something they had gated, and re-deriving
	// today's answer would pay out against a state that did not hold at the time. See
	// the column's own note — the point-in-time stamp is the whole reason it exists.
	//
	// 🚨 **Split by `via_share_link`, because a viewer's own choices and what strangers
	// watched through their link are two different claims on the same pool.** Share-link time
	// is attributed to the sharer — that is what makes it attributable at all — so without a
	// boundary a link that went viral would dilute what the sharer's *own* watching pays the
	// creators they deliberately chose. See `SHARE_LINK_POOL_FRACTION`.
	const attentionRows = await db
		.select({
			creatorId: attentionEvents.creatorId,
			viaShareLink: attentionEvents.viaShareLink,
			totalSeconds: sum(attentionEvents.durationSeconds).as("total_seconds"),
		})
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, acct.userId),
				eq(attentionEvents.publicAccess, true),
				gte(attentionEvents.createdAt, start),
				lt(attentionEvents.createdAt, end),
			),
		)
		.groupBy(attentionEvents.creatorId, attentionEvents.viaShareLink);

	/** The viewer's own watching, and what their links funded — each split within itself. */
	const own = new Map<number, number>();
	const shared = new Map<number, number>();
	let totalOwn = 0;
	let totalShared = 0;
	for (const row of attentionRows) {
		const seconds = Number(row.totalSeconds);
		if (seconds <= 0) continue;
		const bucket = row.viaShareLink ? shared : own;
		bucket.set(row.creatorId, (bucket.get(row.creatorId) ?? 0) + seconds);
		if (row.viaShareLink) totalShared += seconds;
		else totalOwn += seconds;
	}

	/** Everything this viewer's month credited, for the ledger's own `attentionSeconds`. */
	const attentionByCreator = new Map<number, number>();
	for (const [creatorId, seconds] of own) {
		attentionByCreator.set(creatorId, seconds);
	}
	for (const [creatorId, seconds] of shared) {
		attentionByCreator.set(creatorId, (attentionByCreator.get(creatorId) ?? 0) + seconds);
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

	// 2. Directed support → credited NET of the creator side's share of the at-cost card
	//    fee. (Undirected support is NOT distributed here — the user must direct it;
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
	// pro-rata, so a user who also gives to Anthers amortizes the fixed $0.30
	// and every creator on that charge is paid more. Worst case is a lone directed
	// $3 on its own charge: $3.00 gross → $2.61 net.
	if (grossDirected.gt(0)) {
		const creatorFee = paymentsSplit(
			supportAmount(acct.anthersSupport),
			grossDirected.toNumber(),
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

	// 3. Distribute the Time Pool proportionally by attention, in two slices.
	//
	// 🚨 **The shared slice is a CEILING, never a reservation, and the difference is the whole
	// design.** A viewer who shared nothing distributes 100% of their pool to the creators
	// they watched, exactly as before — the slice only comes into being when somebody actually
	// watched through one of their links. Reserving it unconditionally would quietly cut every
	// non-sharer's creators by a tenth to fund a feature they never used.
	//
	// ⚠️ **The converse is deliberately NOT symmetric.** A sharer who watched nothing
	// themselves distributes the shared slice and leaves the rest undistributed, rather than
	// letting strangers command their whole pool — the bound is the point of having one.
	//
	// ⭐ **What happens to that leftover is settled: it falls to the remainder**, along with
	// the whole pool of a viewer who streamed no Public Access at all (Parker, 2026-08-26;
	// built 2026-08-29). `settle-cycle.ts` books it, by measuring what this job actually wrote
	// against the budget — so leaving money undistributed here is a decision about *creators*
	// and never a decision to lose it.
	const timePool = computeTimePoolAmount(supportAmount(acct.anthersSupport));
	const sharedPool =
		totalShared > 0 ? CENTS(timePool.mul(SHARE_LINK_POOL_FRACTION)) : new Decimal(0);
	const ownPool = totalOwn > 0 ? timePool.minus(sharedPool) : new Decimal(0);

	if (timePool.gt(0)) {
		for (const [pot, byCreator, total] of [
			[ownPool, own, totalOwn],
			[sharedPool, shared, totalShared],
		] as const) {
			if (!(pot.gt(0) && total > 0)) continue;
			for (const [creatorId, seconds] of byCreator) {
				const proportion = new Decimal(seconds).div(total);
				ensure(creatorId).poolAmount = ensure(creatorId).poolAmount.plus(
					pot.mul(proportion).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
				);
			}
		}

		// Correct rounding drift against the largest allocation so the pot is conserved.
		// Against the sum of the two slices, not the whole pool: when only one of them was
		// distributed the other is genuinely undistributed, and correcting to `timePool`
		// would silently pay it out anyway — which is exactly the ceiling being lost.
		const distributed = ownPool.plus(sharedPool);
		if (distributed.gt(0)) {
			correctDrift(
				distributions,
				distributed,
				(d) => d.poolAmount,
				(d, v) => {
					d.poolAmount = v;
				},
			);
		}
	}

	// Record attention even for creators that only received directed support.
	//
	// `poolDistributions.attentionSeconds` is therefore Public Access seconds, not all
	// time spent with that creator, and it has to be: it is the denominator the
	// subscriber's Time Pool pie draws its percentages from, so seconds that earned no
	// pool dollars would render a slice with no money beside it. Total time with a
	// creator is a different question, answered by `GET /attention/summary`.
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
