// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cycle settlement job — the money that moves at month-end, per account:
 *
 * 1. **Bandwidth.** Draw the cycle's stream consumption against the account's Seed
 *    allowance (15 GiB floor + 60 GiB per Anthers-Seed), at cost. Bandwidth is
 *    folded into the Anthers-Seeds — there is no wallet. The consumption figure is
 *    an illustrative stand-in derived from watch-time (× DELIVERY_GIB_PER_HOUR)
 *    until real CDN metering is wired.
 * 2. **remainder inflow.** The **remainder** of this account's Anthers-Seeds —
 *    what's left of each $3 after its Time Pool ($1.50), its at-cost bandwidth, and
 *    its pro-rata share of the at-cost Payments line. Lighter streamers leave more
 *    for the mission, and so do users who also give directed Seeds, because the
 *    fixed card fee is charged once on the whole batched monthly charge. Free
 *    accounts (0 Anthers-Seeds) contribute nothing — their floor and $0.05 Time
 *    Pool are subsidised. The remainder is the shock absorber: Time Pool is a fixed
 *    target and never moves, so cost swings land here, never on creator pay.
 * 3. **Reset** the running consumption counter and record the cycle snapshot.
 *
 * Idempotent per (user, cycle) via a marker row in the charitable ledger.
 */

import { db } from "@anthers/db";
import {
	accountCycles,
	accounts,
	attentionEvents,
	crfLedger,
	seedAllocations,
} from "@anthers/db/schema";
import {
	allowanceGiB,
	DELIVERY_GIB_PER_HOUR,
	SEED_PRICE,
	seedCost,
} from "@anthers/shared/constants";
import { anthersSeedBreakdown, drawBandwidth, paymentsSplit } from "@anthers/shared/fees";
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
	acct: { id: number; userId: number; anthersSeeds: number; creatorSeedTotal: string },
	cycle: string,
): Promise<boolean> {
	// Idempotency: a marker row in the charitable ledger per (user, cycle).
	const marker = `[settle u${acct.userId} ${cycle}]`;
	const [already] = await db
		.select({ id: crfLedger.id })
		.from(crfLedger)
		.where(sql`${crfLedger.description} LIKE ${`${marker}%`}`)
		.limit(1);
	if (already) return false;

	const n = Math.max(0, Number(acct.anthersSeeds ?? 0));
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

	// Bandwidth is folded into the Anthers-Seeds (no wallet): draw against the allowance.
	// `overageGiB` (streaming past the allowance) is a nudge to hold another Seed.
	const draw = drawBandwidth({ consumedGiB, allowanceGiB: allowanceGiB(n) });

	// Directed creator-Seeds this cycle. Needed BEFORE the remainder inflow, because
	// the at-cost card fee is charged on the whole batched monthly charge and split
	// pro-rata — so directed Seeds amortise the fixed $0.30 and leave a fatter
	// remainder. Anthers takes no cut of these; they are recorded, not an inflow.
	const [dir] = await db
		.select({ total: sql<string>`COALESCE(SUM(CAST(amount AS numeric)), 0)` })
		.from(seedAllocations)
		.where(and(eq(seedAllocations.userId, acct.userId), eq(seedAllocations.billingCycle, cycle)));
	const directedSeeds = new Decimal(dir?.total ?? 0);

	// 2. remainder inflow: the remainder of this account's Anthers-Seeds, after their
	//    Time Pool, their at-cost bandwidth, and their share of the at-cost Payments
	//    line (lighter streamers and bigger baskets both leave more). Passing
	//    `payments` here is load-bearing — omit it and the charitable ledger is over-credited
	//    by the card fee, which typechecks fine because the option is optional.
	const split = paymentsSplit(n, directedSeeds.div(SEED_PRICE).toNumber());
	const bd = anthersSeedBreakdown(n, { bandwidthGiB: consumedGiB, payments: split.anthers });
	const inflow = CENTS(Decimal.max(0, bd.foundation));

	await db.insert(crfLedger).values({
		amount: inflow.toFixed(2),
		description: inflow.gt(0)
			? `${marker} remainder $${inflow.toFixed(2)} from ${n} Anthers-Seed${
					n === 1 ? "" : "s"
				} (bandwidth $${bd.bandwidth.toFixed(2)}, Time Pool $${bd.timePool.toFixed(2)}, Payments $${bd.payments.toFixed(2)}${
					draw.overageGiB.gt(0) ? `, over allowance by ${draw.overageGiB.toFixed(1)} GiB` : ""
				})`
			: `${marker} no remainder inflow (free rank)`,
	});

	// 3. Reset the running consumption counter and record the cycle snapshot.
	await db
		.update(accounts)
		.set({ bandwidthUsedGiB: "0", updatedAt: new Date() })
		.where(eq(accounts.id, acct.id));

	const snapshot = {
		anthersSeeds: n,
		anthersSpend: new Decimal(seedCost(n)).toFixed(2),
		creatorSeedTotal: directedSeeds.toFixed(2),
		timePool: bd.timePool.toFixed(2),
		foundation: inflow.toFixed(2),
		bandwidthUsedGiB: consumedGiB.toFixed(4),
	};
	await db
		.insert(accountCycles)
		.values({ userId: acct.userId, billingCycle: cycle, ...snapshot })
		.onConflictDoUpdate({
			target: [accountCycles.userId, accountCycles.billingCycle],
			set: {
				bandwidthUsedGiB: snapshot.bandwidthUsedGiB,
				foundation: snapshot.foundation,
				timePool: snapshot.timePool,
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
