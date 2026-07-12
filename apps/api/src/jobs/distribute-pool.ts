// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Pool distribution job: distribute the Time Pool and Boost to creators.
 *
 * For each active account:
 * 1. Sum watch-time seconds per creator during the billing cycle.
 * 2. Time Pool = usageGiB × $0.015 (funded per-GiB), distributed proportionally by time.
 * 3. Boost = 100% to creators: directed boosts go to the named creators; the
 *    undirected remainder (boostTotal − Σ directed) is distributed by time.
 * 4. Create/update PoolDistribution ledger entries.
 */

import { db } from "@anthers/db";
import { accounts, attentionEvents, boostAllocations, poolDistributions } from "@anthers/db/schema";
import { TIME_POOL_PER_GIB } from "@anthers/shared/constants";
import Decimal from "decimal.js";
import { and, eq, gte, lt, sum } from "drizzle-orm";

export interface DistributePoolData {
	/** If set, distribute for a single account. Otherwise all active accounts. */
	accountId?: number;
}

/** V3: the Time Pool a user funds this cycle = usageGiB × $0.015. */
function computeTimePoolAmount(usageGiB: number): Decimal {
	if (usageGiB <= 0) return new Decimal(0);
	return new Decimal(usageGiB).mul(TIME_POOL_PER_GIB);
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
	boostAmount: Decimal;
	attentionSeconds: number;
}

async function distributeForAccount(acct: {
	id: number;
	userId: number;
	usageGiB: number;
	boostTotal: string;
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
			d = { poolAmount: new Decimal(0), boostAmount: new Decimal(0), attentionSeconds: 0 };
			distributions.set(creatorId, d);
		}
		return d;
	};

	// 2. Directed boosts (100% to the named creator) + compute the undirected remainder.
	const directed = await db
		.select()
		.from(boostAllocations)
		.where(
			and(eq(boostAllocations.userId, acct.userId), eq(boostAllocations.billingCycle, cycleDate)),
		);

	let directedTotal = new Decimal(0);
	for (const boost of directed) {
		const amt = new Decimal(boost.amount);
		directedTotal = directedTotal.plus(amt);
		ensure(boost.creatorId).boostAmount = amt;
	}
	const undirectedBoost = Decimal.max(0, new Decimal(acct.boostTotal).minus(directedTotal));

	// 3. Distribute the Time Pool and undirected Boost proportionally by watch-time.
	const timePool = computeTimePoolAmount(acct.usageGiB);
	if (totalAttention > 0 && (timePool.gt(0) || undirectedBoost.gt(0))) {
		for (const [creatorId, seconds] of attentionByCreator) {
			const proportion = new Decimal(seconds).div(totalAttention);
			const d = ensure(creatorId);
			d.attentionSeconds = seconds;
			if (timePool.gt(0)) {
				d.poolAmount = d.poolAmount.plus(
					timePool.mul(proportion).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
				);
			}
			if (undirectedBoost.gt(0)) {
				d.boostAmount = d.boostAmount.plus(
					undirectedBoost.mul(proportion).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
				);
			}
		}

		// Correct rounding drift against the largest allocation so each pot is conserved.
		correctDrift(
			distributions,
			timePool,
			(d) => d.poolAmount,
			(d, v) => {
				d.poolAmount = v;
			},
		);
		if (undirectedBoost.gt(0)) {
			correctDrift(
				distributions,
				directedTotal.plus(undirectedBoost),
				(d) => d.boostAmount,
				(d, v) => {
					d.boostAmount = v;
				},
			);
		}
	}

	// Record watch-time even for creators that only received a directed boost.
	for (const [creatorId, seconds] of attentionByCreator) {
		ensure(creatorId).attentionSeconds = seconds;
	}

	// 4. Write PoolDistribution ledger entries
	for (const [creatorId, data] of distributions) {
		if (data.poolAmount.lte(0) && data.boostAmount.lte(0)) continue;
		await db
			.insert(poolDistributions)
			.values({
				subscriberId: acct.userId,
				creatorId,
				billingCycle: cycleDate,
				poolAmount: data.poolAmount.toString(),
				boostAmount: data.boostAmount.toString(),
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
					boostAmount: data.boostAmount.toString(),
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
