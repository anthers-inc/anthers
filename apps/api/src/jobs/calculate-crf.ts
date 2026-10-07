// SPDX-License-Identifier: Apache-2.0
/**
 * hosting subsidy calculation job (V3: discretionary — not an automatic
 * net-never-negative guarantee).
 *
 * Runs daily (idempotent per monthly billing cycle). Iterates creators,
 * estimates their storage cost (bytes past their Badge's allowance, at cost — no
 * mark-up), compares to earnings, and — at Anthers' discretion, within its budget —
 * may subsidize the gap for creators who earn less than that cost. The allowance
 * itself (the combined free floor and each rung's bundled storage) is Anthers'
 * obligation, not this job's cost basis.
 *
 * ⚠️ **Two clauses here described mechanisms that are gone, until 2026-08-19.** It said a
 * self-hosting creator "pays a flat fee instead" — `SELF_HOST_FEE` has been **`0`** since
 * 2026-08-12, so there is no fee to pay instead of anything. And it said "delivery is
 * user-funded", which stopped being true when Cloudflare R2 made delivery **free at any
 * volume**: nobody funds it, because it costs nothing. Neither left a wrong figure behind
 * — a retired mechanism leaves prose with nothing underneath, which is exactly what the
 * figures guard cannot see.
 */

import { db } from "@anthers/db";
import {
	assets,
	badges,
	billingAccounts,
	crfLedger,
	crfSubsidies,
	poolDistributions,
	posts,
	projects,
	purchases,
	userBadges,
	users,
	works,
} from "@anthers/db/schema";
import { currentCycleKey } from "@anthers/shared/billing-cycle";
import { estimateStorageCost, MAX_MONTHLY_SUBSIDY } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, count, eq, inArray, sql, sum } from "drizzle-orm";

/**
 * The current cycle key, for Drizzle date columns.
 *
 * A fifth hand-rolled copy of this lived here, named differently enough to survive the
 * 2026-09-15 sweep that unified the other four. It read local time like all of them.
 */
const getCycleDate = currentCycleKey;

async function getCreatorEarnings(creatorId: number, cycleDate: string): Promise<Decimal> {
	// Pool + Badge distributions
	const [poolResult] = await db
		.select({
			poolTotal: sum(poolDistributions.poolAmount),
			badgeTotal: sum(poolDistributions.badgeAmount),
		})
		.from(poolDistributions)
		.where(
			and(
				eq(poolDistributions.creatorId, creatorId),
				eq(poolDistributions.billingCycle, cycleDate),
			),
		);

	const poolAmount = new Decimal(poolResult?.poolTotal ?? "0");
	const badgeAmount = new Decimal(poolResult?.badgeTotal ?? "0");

	// Marketplace earnings this month
	// cycleDate is "YYYY-MM-01"; derive month boundaries for timestamp comparison
	const [y, m] = cycleDate.split("-").map(Number);
	const monthStart = new Date(y, m - 1, 1);
	const monthEnd = new Date(y, m, 1);

	// Sums on `purchases.creator_id` rather than joining through `works` (`0016`). The
	// join was silently lossy: it dropped any sale whose Work had since been deleted, so
	// a creator's own earnings figure depended on their catalog still existing.
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

	return poolAmount.plus(badgeAmount).plus(salesEarnings);
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
			handle: users.atprotoHandle,
			isSelfHosting: billingAccounts.isSelfHosting,
		})
		.from(users)
		.innerJoin(posts, eq(posts.creatorId, users.id))
		.leftJoin(billingAccounts, eq(billingAccounts.userId, users.id))
		.where(and(eq(users.isCreator, true), eq(posts.isPublished, true)));

	// What each creator gives Anthers this cycle — their held Anthers Badge's threshold,
	// which IS the amount (`user_badges`' docblock). Same read shape as the access
	// resolver: one holding per issuer per cycle, MAX belt-and-braces. This resolves the
	// storage allowance the costing below uses — a free creator is never billed, their
	// floor is the subsidy this job exists to keep affordable.
	const heldAnthersSupport = new Map<number, number>();
	if (creators.length > 0) {
		const heldRows = await db
			.select({
				userId: userBadges.userId,
				given: sql<string>`MAX(${badges.threshold})`,
			})
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.where(inArray(userBadges.userId, creators.map((c) => c.id)))
			.groupBy(userBadges.userId);
		for (const row of heldRows) heldAnthersSupport.set(row.userId, Number(row.given ?? 0));
	}

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

		// Published post and project counts, kept for the subsidy audit record. They are two
		// queries on purpose: `project_count` was written from the post count, so every snapshot
		// reported a creator's devlogs as their projects.
		const [publishedPostCount] = await db
			.select({ count: count() })
			.from(posts)
			.where(and(eq(posts.creatorId, creator.id), eq(posts.isPublished, true)));
		const [publishedProjectCount] = await db
			.select({ count: count() })
			.from(projects)
			.where(and(eq(projects.creatorId, creator.id), eq(projects.isPublished, true)));

		// Storage is a library concern now: sum the file sizes of the assets on the
		// creator's content items (which own their downloadable variants directly).
		const [storageResult] = await db
			.select({ total: sum(assets.fileSize) })
			.from(assets)
			.innerJoin(works, eq(assets.workId, works.id))
			.where(eq(works.creatorId, creator.id));

		const storageBytes = Number(storageResult?.total ?? 0);

		// Creator cost = storage past their Badge's allowance, at cost (or a flat
		// self-host fee). Delivery is user-funded, so it is not part of this cost. The
		// allowance resolves from the account's actual support to Anthers
		// (`anthersSupport` this cycle), so a free creator is never billed — their
		// combined 25 GiB is the subsidy this job exists to keep affordable, not a
		// charge. There is no mark-up on any storage (the half-again retired
		// 2026-10-07).
		const hostingCost = estimateStorageCost({
			storageBytes,
			anthersDollars: heldAnthersSupport.get(creator.id) ?? 0,
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
				projectCount: publishedProjectCount?.count ?? 0,
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
			projectCount: publishedProjectCount?.count ?? 0,
			postCount: publishedPostCount?.count ?? 0,
		});

		// Record the subsidy outflow against the charitable ledger
		await db.insert(crfLedger).values({
			amount: subsidy.neg().toString(),
			description: `hosting subsidy for ${creator.handle} — hosting $${hostingCost}, earnings $${earnings}, subsidy $${subsidy}`,
		});

		totalSubsidy = totalSubsidy.plus(subsidy);
		subsidized++;
	}

	console.log(
		`hosting subsidy calculation complete: ${subsidized} creators subsidized, $${totalSubsidy} total`,
	);
	return subsidized;
}
