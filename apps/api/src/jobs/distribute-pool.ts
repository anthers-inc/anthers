/**
 * Pool distribution job: distribute creator pool based on attention time.
 *
 * Ported from _legacy/backend/subscriptions/tasks.py distribute_pool()
 *
 * For each active paid subscriber:
 * 1. Sum attention seconds per creator during the billing cycle.
 * 2. Distribute the subscriber's creator_pool_amount proportionally.
 * 3. Apply any boost allocations.
 * 4. Create/update PoolDistribution ledger entries.
 */

import Decimal from "decimal.js";
import { eq, and, gte, lt, ne, sql, sum } from "drizzle-orm";
import { db } from "@anthers/db";
import {
	subscriptions,
	attentionEvents,
	boostAllocations,
	poolDistributions,
} from "@anthers/db/schema";

export interface DistributePoolData {
	/** If set, distribute for a single subscriber. Otherwise all active paid. */
	subscriptionId?: number;
}

function getBillingCycle(sub: {
	currentPeriodStart: Date | null;
	currentPeriodEnd: Date | null;
}) {
	if (sub.currentPeriodStart && sub.currentPeriodEnd) {
		return {
			start: sub.currentPeriodStart,
			end: sub.currentPeriodEnd,
		};
	}
	// Fallback to current calendar month
	const now = new Date();
	const start = new Date(now.getFullYear(), now.getMonth(), 1);
	const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
	return { start, end };
}

function billingCycleDate(cycleStart: Date): Date {
	return new Date(cycleStart.getFullYear(), cycleStart.getMonth(), 1);
}

async function distributeForSubscriber(sub: {
	id: number;
	userId: number;
	creatorPoolAmount: string;
	currentPeriodStart: Date | null;
	currentPeriodEnd: Date | null;
}) {
	const { start, end } = getBillingCycle(sub);
	const cycleDate = billingCycleDate(start);

	// 1. Aggregate attention time per creator
	const attentionRows = await db
		.select({
			creatorId: attentionEvents.creatorId,
			totalSeconds: sum(attentionEvents.durationSeconds).as(
				"total_seconds",
			),
		})
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, sub.userId),
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

	// 2. Calculate proportional pool distribution
	const poolAmount = new Decimal(sub.creatorPoolAmount || "0");
	const distributions = new Map<
		number,
		{
			poolAmount: Decimal;
			boostAmount: Decimal;
			attentionSeconds: number;
		}
	>();

	if (totalAttention > 0 && poolAmount.gt(0)) {
		for (const [creatorId, seconds] of attentionByCreator) {
			const proportion = new Decimal(seconds).div(totalAttention);
			const amount = poolAmount
				.mul(proportion)
				.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
			if (amount.gt(0)) {
				distributions.set(creatorId, {
					poolAmount: amount,
					boostAmount: new Decimal(0),
					attentionSeconds: seconds,
				});
			}
		}

		// Correct rounding drift
		let totalDistributed = new Decimal(0);
		for (const d of distributions.values()) {
			totalDistributed = totalDistributed.plus(d.poolAmount);
		}
		const drift = poolAmount.minus(totalDistributed);
		if (!drift.isZero() && distributions.size > 0) {
			// Adjust the largest allocation
			let largestId = 0;
			let largestAmount = new Decimal(0);
			for (const [id, d] of distributions) {
				if (d.poolAmount.gt(largestAmount)) {
					largestId = id;
					largestAmount = d.poolAmount;
				}
			}
			const entry = distributions.get(largestId)!;
			entry.poolAmount = entry.poolAmount.plus(drift);
		}
	}

	// 3. Apply boost allocations
	const boosts = await db
		.select()
		.from(boostAllocations)
		.where(
			and(
				eq(boostAllocations.userId, sub.userId),
				eq(boostAllocations.billingCycle, cycleDate),
			),
		);

	for (const boost of boosts) {
		const existing = distributions.get(boost.creatorId);
		if (existing) {
			existing.boostAmount = new Decimal(boost.amount);
		} else {
			distributions.set(boost.creatorId, {
				poolAmount: new Decimal(0),
				boostAmount: new Decimal(boost.amount),
				attentionSeconds: 0,
			});
		}
	}

	// 4. Write PoolDistribution ledger entries
	for (const [creatorId, data] of distributions) {
		await db
			.insert(poolDistributions)
			.values({
				subscriberId: sub.userId,
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

export async function distributePool(data: DistributePoolData) {
	const query = db
		.select()
		.from(subscriptions)
		.where(
			and(
				eq(subscriptions.isActive, true),
				ne(subscriptions.tier, "window"),
			),
		);

	const subs = data.subscriptionId
		? await db
				.select()
				.from(subscriptions)
				.where(
					and(
						eq(subscriptions.id, data.subscriptionId),
						eq(subscriptions.isActive, true),
						ne(subscriptions.tier, "window"),
					),
				)
		: await query;

	let processed = 0;
	for (const sub of subs) {
		try {
			await distributeForSubscriber(sub);
			processed++;
		} catch (error) {
			console.error(
				`Pool distribution failed for user ${sub.userId}:`,
				error,
			);
		}
	}

	console.log(`Pool distribution complete: ${processed} subscribers processed`);
	return processed;
}
