// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Foundation subsidy calculation job.
 *
 * Ported from _legacy/backend/payments/tasks.py calculate_crf_subsidies()
 *
 * Runs daily (idempotent per monthly billing cycle). Iterates creators,
 * estimates hosting costs, compares to earnings, and subsidizes the gap
 * for creators who earn less than their hosting costs.
 */

import { db } from "@anthers/db";
import {
	assets,
	crfLedger,
	crfSubsidies,
	poolDistributions,
	posts,
	purchases,
	users,
} from "@anthers/db/schema";
import { estimateHostingCost, MAX_MONTHLY_SUBSIDY } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, count, eq, inArray, sql, sum } from "drizzle-orm";

/** Returns the first day of the current month as YYYY-MM-DD for Drizzle date columns. */
function getCycleDate(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	return `${y}-${m}-01`;
}

async function getCreatorEarnings(creatorId: number, cycleDate: string): Promise<Decimal> {
	// Pool + boost distributions
	const [poolResult] = await db
		.select({
			poolTotal: sum(poolDistributions.poolAmount),
			boostTotal: sum(poolDistributions.boostAmount),
		})
		.from(poolDistributions)
		.where(
			and(
				eq(poolDistributions.creatorId, creatorId),
				eq(poolDistributions.billingCycle, cycleDate),
			),
		);

	const poolAmount = new Decimal(poolResult?.poolTotal ?? "0");
	const boostAmount = new Decimal(poolResult?.boostTotal ?? "0");

	// Marketplace earnings this month
	// cycleDate is "YYYY-MM-01"; derive month boundaries for timestamp comparison
	const [y, m] = cycleDate.split("-").map(Number);
	const monthStart = new Date(y, m - 1, 1);
	const monthEnd = new Date(y, m, 1);

	const [salesResult] = await db
		.select({
			total: sum(purchases.creatorEarnings),
		})
		.from(purchases)
		.innerJoin(posts, eq(purchases.postId, posts.id))
		.where(
			and(
				eq(posts.creatorId, creatorId),
				eq(purchases.status, "completed"),
				sql`${purchases.createdAt} >= ${monthStart}`,
				sql`${purchases.createdAt} < ${monthEnd}`,
			),
		);

	const salesEarnings = new Decimal(salesResult?.total ?? "0");

	return poolAmount.plus(boostAmount).plus(salesEarnings);
}

export async function calculateCrfSubsidies() {
	const cycleDate = getCycleDate();

	// Get Foundation balance
	const [balanceResult] = await db.select({ total: sum(crfLedger.amount) }).from(crfLedger);

	const crfBalance = new Decimal(balanceResult?.total ?? "0");
	if (crfBalance.lte(0)) {
		console.log("Foundation balance is zero or negative. Skipping subsidies.");
		return 0;
	}

	// Find all creators with published content
	const creators = await db
		.selectDistinct({ id: users.id, username: users.username })
		.from(users)
		.innerJoin(posts, eq(posts.creatorId, users.id))
		.where(and(eq(users.isCreator, true), eq(posts.isPublished, true)));

	let subsidized = 0;
	let totalSubsidy = new Decimal(0);

	for (const creator of creators) {
		// Skip if already subsidized this cycle
		const [existing] = await db
			.select({ id: crfSubsidies.id })
			.from(crfSubsidies)
			.where(and(eq(crfSubsidies.creatorId, creator.id), eq(crfSubsidies.billingCycle, cycleDate)))
			.limit(1);
		if (existing) continue;

		// Calculate hosting cost. Everything is a post now; the hosting model's
		// "projectCount" maps to the creator's published works (posts).
		const [publishedPostCount] = await db
			.select({ count: count() })
			.from(posts)
			.where(and(eq(posts.creatorId, creator.id), eq(posts.isPublished, true)));

		const [mediaPostCount] = await db
			.select({ count: count() })
			.from(posts)
			.where(
				and(
					eq(posts.creatorId, creator.id),
					eq(posts.isPublished, true),
					inArray(posts.contentType, ["video", "audio"]),
				),
			);

		const [storageResult] = await db
			.select({ total: sum(assets.fileSize) })
			.from(assets)
			.innerJoin(posts, eq(assets.postId, posts.id))
			.where(eq(posts.creatorId, creator.id));

		const storageBytes = Number(storageResult?.total ?? 0);

		const hostingCost = estimateHostingCost({
			storageBytes,
			projectCount: publishedPostCount?.count ?? 0,
			mediaPostCount: mediaPostCount?.count ?? 0,
		});

		const earnings = await getCreatorEarnings(creator.id, cycleDate);

		// Check eligibility: earnings < hosting cost
		if (earnings.gte(hostingCost)) {
			// Creator earns enough — record zero subsidy for audit trail
			await db.insert(crfSubsidies).values({
				creatorId: creator.id,
				billingCycle: cycleDate,
				estimatedHostingCost: hostingCost.toString(),
				creatorEarnings: earnings.toString(),
				subsidyAmount: "0.00",
				storageBytes,
				projectCount: publishedPostCount?.count ?? 0,
				postCount: publishedPostCount?.count ?? 0,
			});
			continue;
		}

		// Calculate subsidy: cover the gap, capped
		const gap = hostingCost.minus(earnings);
		const budgetRemaining = crfBalance.minus(totalSubsidy);
		let subsidy = Decimal.min(gap, MAX_MONTHLY_SUBSIDY, budgetRemaining);

		if (subsidy.lte(0)) {
			console.log(`Foundation budget exhausted after ${subsidized} subsidies.`);
			break;
		}

		subsidy = subsidy.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

		await db.insert(crfSubsidies).values({
			creatorId: creator.id,
			billingCycle: cycleDate,
			estimatedHostingCost: hostingCost.toString(),
			creatorEarnings: earnings.toString(),
			subsidyAmount: subsidy.toString(),
			storageBytes,
			projectCount: publishedPostCount?.count ?? 0,
			postCount: publishedPostCount?.count ?? 0,
		});

		// Record CRF outflow
		await db.insert(crfLedger).values({
			amount: subsidy.neg().toString(),
			description: `Foundation subsidy for ${creator.username} — hosting $${hostingCost}, earnings $${earnings}, subsidy $${subsidy}`,
		});

		totalSubsidy = totalSubsidy.plus(subsidy);
		subsidized++;
	}

	console.log(
		`Foundation subsidy calculation complete: ${subsidized} creators subsidized, $${totalSubsidy} total`,
	);
	return subsidized;
}
