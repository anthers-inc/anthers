// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * hosting subsidy calculation job (V3: discretionary — not an automatic
 * net-never-negative guarantee).
 *
 * Runs daily (idempotent per monthly billing cycle). Iterates creators,
 * estimates their storage cost + the half again on top, compares to earnings, and — at
 * Anthers' discretion, within its budget — may subsidize the gap for creators who earn
 * less than that cost. Storage is the creator's own opt-in cost (50 GiB free).
 *
 * ⚠️ **Two clauses here described mechanisms that are gone, until 2026-08-19.** It said a
 * self-hosting creator "pays a flat fee instead" — `SELF_HOST_FEE` has been **`0`** since
 * 2026-08-12, so there is no fee to pay instead of anything. And it said "delivery is
 * viewer-funded", which stopped being true when Cloudflare R2 made delivery **free at any
 * volume**: nobody funds it, because it costs nothing. Neither left a wrong figure behind
 * — a retired mechanism leaves prose with nothing underneath, which is exactly what the
 * figures guard cannot see.
 */

import { db } from "@anthers/db";
import {
	accounts,
	assets,
	crfLedger,
	crfSubsidies,
	poolDistributions,
	posts,
	purchases,
	users,
	works,
} from "@anthers/db/schema";
import { estimateStorageCost, MAX_MONTHLY_SUBSIDY } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, count, eq, sql, sum } from "drizzle-orm";

/** Returns the first day of the current month as YYYY-MM-DD for Drizzle date columns. */
function getCycleDate(): string {
	const now = new Date();
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	return `${y}-${m}-01`;
}

async function getCreatorEarnings(creatorId: number, cycleDate: string): Promise<Decimal> {
	// Pool + Seed distributions
	const [poolResult] = await db
		.select({
			poolTotal: sum(poolDistributions.poolAmount),
			seedTotal: sum(poolDistributions.seedAmount),
		})
		.from(poolDistributions)
		.where(
			and(
				eq(poolDistributions.creatorId, creatorId),
				eq(poolDistributions.billingCycle, cycleDate),
			),
		);

	const poolAmount = new Decimal(poolResult?.poolTotal ?? "0");
	const seedAmount = new Decimal(poolResult?.seedTotal ?? "0");

	// Marketplace earnings this month
	// cycleDate is "YYYY-MM-01"; derive month boundaries for timestamp comparison
	const [y, m] = cycleDate.split("-").map(Number);
	const monthStart = new Date(y, m - 1, 1);
	const monthEnd = new Date(y, m, 1);

	// Sums on `purchases.creator_id` rather than joining through `works` (`0016`). The
	// join was silently lossy: it dropped any sale whose Work had since been deleted, so
	// a creator's own earnings figure depended on their catalogue still existing.
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

	return poolAmount.plus(seedAmount).plus(salesEarnings);
}

export async function calculateCrfSubsidies() {
	const cycleDate = getCycleDate();

	// Get charitable balance
	const [balanceResult] = await db.select({ total: sum(crfLedger.amount) }).from(crfLedger);

	const crfBalance = new Decimal(balanceResult?.total ?? "0");
	if (crfBalance.lte(0)) {
		console.log("charitable balance is zero or negative. Skipping subsidies.");
		return 0;
	}

	// Find all creators with published content (with their self-hosting flag)
	const creators = await db
		.selectDistinct({
			id: users.id,
			username: users.username,
			isSelfHosting: accounts.isSelfHosting,
		})
		.from(users)
		.innerJoin(posts, eq(posts.creatorId, users.id))
		.leftJoin(accounts, eq(accounts.userId, users.id))
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

		// Published-post count, kept for the subsidy audit record.
		const [publishedPostCount] = await db
			.select({ count: count() })
			.from(posts)
			.where(and(eq(posts.creatorId, creator.id), eq(posts.isPublished, true)));

		// Storage is a library concern now: sum the file sizes of the assets on the
		// creator's content items (which own their downloadable variants directly).
		const [storageResult] = await db
			.select({ total: sum(assets.fileSize) })
			.from(assets)
			.innerJoin(works, eq(assets.workId, works.id))
			.where(eq(works.creatorId, creator.id));

		const storageBytes = Number(storageResult?.total ?? 0);

		// Creator cost = storage beyond the free 50 GiB + half again on top (or a flat
		// self-host fee). Delivery is viewer-funded, so it is not part of this cost.
		const hostingCost = estimateStorageCost({
			storageBytes,
			isSelfHosting: creator.isSelfHosting ?? false,
		}).total;

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
			console.log(`charitable budget exhausted after ${subsidized} subsidies.`);
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

		// Record the subsidy outflow against the charitable ledger
		await db.insert(crfLedger).values({
			amount: subsidy.neg().toString(),
			description: `hosting subsidy for ${creator.username} — hosting $${hostingCost}, earnings $${earnings}, subsidy $${subsidy}`,
		});

		totalSubsidy = totalSubsidy.plus(subsidy);
		subsidized++;
	}

	console.log(
		`hosting subsidy calculation complete: ${subsidized} creators subsidized, $${totalSubsidy} total`,
	);
	return subsidized;
}
