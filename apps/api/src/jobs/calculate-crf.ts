/**
 * Foundation subsidy calculation job.
 *
 * Ported from _legacy/backend/payments/tasks.py calculate_crf_subsidies()
 *
 * Runs daily (idempotent per monthly billing cycle). Iterates creators,
 * estimates hosting costs, compares to earnings, and subsidizes the gap
 * for creators who earn less than their hosting costs.
 */

import Decimal from "decimal.js";
import { eq, and, sum, sql, count, inArray } from "drizzle-orm";
import { db } from "@anthers/db";
import {
	users,
	projects,
	posts,
	assets,
	purchases,
	poolDistributions,
	crfLedger,
	crfSubsidies,
} from "@anthers/db/schema";
import { estimateHostingCost, MAX_MONTHLY_SUBSIDY } from "@anthers/shared/fees";

function getCycleDate(): Date {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

async function getCreatorEarnings(
	creatorId: number,
	cycleDate: Date,
): Promise<Decimal> {
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
	const monthStart = cycleDate;
	const monthEnd = new Date(
		cycleDate.getFullYear(),
		cycleDate.getMonth() + 1,
		1,
	);

	const [salesResult] = await db
		.select({
			total: sum(purchases.creatorEarnings),
		})
		.from(purchases)
		.where(
			and(
				eq(purchases.creatorId, creatorId),
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
	const [balanceResult] = await db
		.select({ total: sum(crfLedger.amount) })
		.from(crfLedger);

	const crfBalance = new Decimal(balanceResult?.total ?? "0");
	if (crfBalance.lte(0)) {
		console.log("Foundation balance is zero or negative. Skipping subsidies.");
		return 0;
	}

	// Find all creators with published content
	const creators = await db
		.selectDistinct({ id: users.id, username: users.username })
		.from(users)
		.innerJoin(projects, eq(projects.creatorId, users.id))
		.where(
			and(eq(users.isCreator, true), eq(projects.isPublished, true)),
		);

	let subsidized = 0;
	let totalSubsidy = new Decimal(0);

	for (const creator of creators) {
		// Skip if already subsidized this cycle
		const [existing] = await db
			.select({ id: crfSubsidies.id })
			.from(crfSubsidies)
			.where(
				and(
					eq(crfSubsidies.creatorId, creator.id),
					eq(crfSubsidies.billingCycle, cycleDate),
				),
			)
			.limit(1);
		if (existing) continue;

		// Calculate hosting cost
		const [projectCount] = await db
			.select({ count: count() })
			.from(projects)
			.where(
				and(
					eq(projects.creatorId, creator.id),
					eq(projects.isPublished, true),
				),
			);

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
			.innerJoin(projects, eq(assets.projectId, projects.id))
			.where(eq(projects.creatorId, creator.id));

		const storageBytes = Number(storageResult?.total ?? 0);

		const hostingCost = estimateHostingCost({
			storageBytes,
			projectCount: projectCount?.count ?? 0,
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
				projectCount: projectCount?.count ?? 0,
				postCount:
					(mediaPostCount?.count ?? 0) +
					((
						await db
							.select({ count: count() })
							.from(posts)
							.where(
								and(
									eq(posts.creatorId, creator.id),
									eq(posts.isPublished, true),
								),
							)
					)[0]?.count ?? 0),
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
			projectCount: projectCount?.count ?? 0,
			postCount: mediaPostCount?.count ?? 0,
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
