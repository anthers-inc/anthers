// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cycle settlement job — the money that moves at month-end, per account:
 *
 * 1. **Bandwidth wallet.** Draw the cycle's stream consumption against the badge's
 *    free monthly allowance first, then the prepaid wallet (at cost). Debit the
 *    wallet, and auto top-up if enabled and the balance is low / short. The
 *    consumption figure is an illustrative stand-in derived from watch-time
 *    (× DELIVERY_GIB_PER_HOUR) until real CDN metering is wired.
 * 2. **Foundation inflows.** The user's Community Share (from the badge price), the
 *    at-cost value of the unused free allowance, and any **unspent (undirected)
 *    Seeds** all flow into the Foundation / subsidy pool. (Included Seeds must be
 *    directed by the user — undirected ones are not paid to creators; they settle
 *    to the pool here.)
 * 3. **Reset** the running consumption counter and record the cycle snapshot.
 *
 * Idempotent per (user, cycle) via a marker row in the Foundation ledger.
 */

import { db } from "@anthers/db";
import {
	accountCycles,
	accounts,
	attentionEvents,
	crfLedger,
	seedAllocations,
	walletLedger,
} from "@anthers/db/schema";
import { BADGE_PLANS, type Badge, DELIVERY_GIB_PER_HOUR } from "@anthers/shared/constants";
import { badgePriceBreakdown, drawBandwidth, unusedAllowanceValue } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, gte, lt, sql } from "drizzle-orm";

export interface SettleCycleData {
	/** If set, settle a single account. Otherwise all active accounts. */
	accountId?: number;
	/** Cycle to settle (YYYY-MM-01). Defaults to the current calendar month. */
	cycle?: string;
}

/** The cycle a scheduled run settles by default: the just-ended (previous) month. */
function defaultCycle(): string {
	const now = new Date();
	const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function cycleWindow(cycle: string): { start: Date; end: Date } {
	const start = new Date(`${cycle}T00:00:00`);
	const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
	return { start, end };
}

const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

async function settleAccount(
	acct: {
		id: number;
		userId: number;
		badge: string;
		walletBalance: string;
		seedTotal: string;
		autoTopupEnabled: boolean | null;
		autoTopupAmount: string;
		autoTopupThreshold: string;
	},
	cycle: string,
): Promise<boolean> {
	// Idempotency: a marker row in the Foundation ledger per (user, cycle).
	const marker = `[settle u${acct.userId} ${cycle}]`;
	const [already] = await db
		.select({ id: crfLedger.id })
		.from(crfLedger)
		.where(sql`${crfLedger.description} LIKE ${`${marker}%`}`)
		.limit(1);
	if (already) return false;

	const badge = (acct.badge as Badge) ?? "free";
	const plan = BADGE_PLANS[badge] ?? BADGE_PLANS.free;
	const bd = badgePriceBreakdown(badge);
	const { start, end } = cycleWindow(cycle);

	// 1. Stream consumption this cycle — illustrative: watch-time × delivery rate.
	const [att] = await db
		.select({ secs: sql<number>`COALESCE(SUM(duration_seconds), 0)::float` })
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.userId, acct.userId),
				gte(attentionEvents.createdAt, start),
				lt(attentionEvents.createdAt, end),
			),
		);
	const consumedGiB = new Decimal(Number(att?.secs ?? 0)).div(3600).mul(DELIVERY_GIB_PER_HOUR);

	const draw = drawBandwidth({
		consumedGiB,
		freeAllowanceGiB: plan.freeBwGiB,
		walletBalance: Number(acct.walletBalance),
	});

	// Auto top-up: cover any shortfall and refill toward the target if low.
	let walletBalance = draw.remainingWallet;
	if (
		acct.autoTopupEnabled &&
		(draw.shortfall.gt(0) || walletBalance.lt(acct.autoTopupThreshold))
	) {
		const topup = CENTS(new Decimal(acct.autoTopupAmount).plus(draw.shortfall));
		// TODO: charge the auto top-up via Stripe before crediting.
		walletBalance = walletBalance.plus(topup);
		await db
			.insert(walletLedger)
			.values({ userId: acct.userId, delta: topup.toFixed(2), reason: "auto_topup" });
	}

	// Record the stream debit against the wallet.
	if (draw.walletDebit.gt(0)) {
		await db
			.insert(walletLedger)
			.values({ userId: acct.userId, delta: draw.walletDebit.neg().toFixed(2), reason: "stream" });
	}

	// 2. Foundation inflows: Community Share + unused allowance + unspent Seeds.
	const [dir] = await db
		.select({ total: sql<string>`COALESCE(SUM(CAST(amount AS numeric)), 0)` })
		.from(seedAllocations)
		.where(and(eq(seedAllocations.userId, acct.userId), eq(seedAllocations.billingCycle, cycle)));
	const directedSeeds = new Decimal(dir?.total ?? 0);
	const unspentSeeds = Decimal.max(0, new Decimal(acct.seedTotal).minus(directedSeeds));
	const unusedAllowance = unusedAllowanceValue(draw.remainingAllowanceGiB);
	const inflow = CENTS(bd.communityShare.plus(unusedAllowance).plus(unspentSeeds));

	await db.insert(crfLedger).values({
		amount: inflow.toFixed(2),
		description:
			`${marker} Community Share $${bd.communityShare.toFixed(2)} + unused allowance ` +
			`$${unusedAllowance.toFixed(2)} + unspent Seeds $${unspentSeeds.toFixed(2)}`,
	});

	// 3. Apply the wallet balance, reset consumption, and record the cycle snapshot.
	await db
		.update(accounts)
		.set({ walletBalance: walletBalance.toFixed(2), bandwidthUsedGiB: "0", updatedAt: new Date() })
		.where(eq(accounts.id, acct.id));

	const snapshot = {
		badge,
		planPrice: bd.price.toFixed(2),
		timePool: bd.timePool.toFixed(2),
		seedTotal: new Decimal(acct.seedTotal).toFixed(2),
		communityShare: bd.communityShare.toFixed(2),
		bandwidthUsedGiB: consumedGiB.toFixed(4),
		walletSpend: draw.walletDebit.toFixed(2),
	};
	await db
		.insert(accountCycles)
		.values({ userId: acct.userId, billingCycle: cycle, ...snapshot })
		.onConflictDoUpdate({
			target: [accountCycles.userId, accountCycles.billingCycle],
			set: {
				bandwidthUsedGiB: snapshot.bandwidthUsedGiB,
				walletSpend: snapshot.walletSpend,
				communityShare: snapshot.communityShare,
				updatedAt: new Date(),
			},
		});

	return true;
}

export async function settleCycle(data: SettleCycleData) {
	const cycle = data.cycle ?? defaultCycle();
	const accts = data.accountId
		? await db
				.select()
				.from(accounts)
				.where(and(eq(accounts.id, data.accountId), eq(accounts.isActive, true)))
		: await db.select().from(accounts).where(eq(accounts.isActive, true));

	let settled = 0;
	for (const acct of accts) {
		try {
			if (await settleAccount(acct, cycle)) settled++;
		} catch (error) {
			console.error(`Cycle settlement failed for user ${acct.userId}:`, error);
		}
	}

	console.log(`Cycle settlement complete for ${cycle}: ${settled} accounts settled`);
	return settled;
}
