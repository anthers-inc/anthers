// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cycle settlement job — the money that moves at month-end, per account:
 *
 * 1. **remainder inflow.** The **remainder** of this account's Anthers-Seeds —
 *    what's left of each $3 after its Time Pool ($1.50) and its pro-rata share of
 *    the at-cost Payments line. Users who also give directed Seeds leave more for
 *    the mission, because the fixed card fee is charged once on the whole batched
 *    monthly charge. Free accounts (0 Anthers-Seeds) contribute nothing — their
 *    $0.05 Time Pool is subsidised. The remainder is the shock absorber: Time Pool
 *    is a fixed target and never moves, so cost swings land here, never on creator
 *    pay.
 * 2. **Record** the cycle snapshot.
 *
 * A first step used to sit above these: draw the cycle's stream consumption against
 * the account's allowance (15 GiB floor + 60 GiB per Anthers-Seed) and charge it at
 * $0.01/GiB. **Retired 2026-08-12** — R2 charges $0 egress at any volume, so it
 * metered a cost nobody pays, and the whole rate was a pass-through of the vendor
 * Anthers had just left. Nothing writes `bandwidth_used_gib` any more; the columns
 * remain because dropping them is a migration of its own.
 *
 * Idempotent per (user, cycle) via a marker row in the charitable ledger.
 */

import { db } from "@anthers/db";
import { accountCycles, accounts, crfLedger, seedAllocations } from "@anthers/db/schema";
import { SEED_PRICE, seedCost } from "@anthers/shared/constants";
import { anthersSeedBreakdown, paymentsSplit } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";

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

	// Directed creator-Seeds this cycle. Needed BEFORE the remainder inflow, because
	// the at-cost card fee is charged on the whole batched monthly charge and split
	// pro-rata — so directed Seeds amortise the fixed $0.30 and leave a fatter
	// remainder. Anthers takes no cut of these; they are recorded, not an inflow.
	const [dir] = await db
		.select({ total: sql<string>`COALESCE(SUM(CAST(amount AS numeric)), 0)` })
		.from(seedAllocations)
		.where(and(eq(seedAllocations.userId, acct.userId), eq(seedAllocations.billingCycle, cycle)));
	const directedSeeds = new Decimal(dir?.total ?? 0);

	// 1. remainder inflow: the remainder of this account's Anthers-Seeds, after their
	//    Time Pool and their share of the at-cost Payments line (a bigger basket
	//    leaves more, because the fixed $0.30 is per charge). Passing `payments` here
	//    is load-bearing — omit it and the charitable ledger is over-credited by the
	//    card fee, which typechecks fine because the option is optional.
	const split = paymentsSplit(n, directedSeeds.div(SEED_PRICE).toNumber());
	const bd = anthersSeedBreakdown(n, { payments: split.anthers });
	const inflow = CENTS(Decimal.max(0, bd.foundation));

	await db.insert(crfLedger).values({
		amount: inflow.toFixed(2),
		description: inflow.gt(0)
			? `${marker} remainder $${inflow.toFixed(2)} from ${n} Anthers-Seed${
					n === 1 ? "" : "s"
				} (Time Pool $${bd.timePool.toFixed(2)}, Payments $${bd.payments.toFixed(2)})`
			: `${marker} no remainder inflow (free rank)`,
	});

	// 2. Record the cycle snapshot.
	const snapshot = {
		anthersSeeds: n,
		anthersSpend: new Decimal(seedCost(n)).toFixed(2),
		creatorSeedTotal: directedSeeds.toFixed(2),
		timePool: bd.timePool.toFixed(2),
		foundation: inflow.toFixed(2),
	};
	await db
		.insert(accountCycles)
		.values({ userId: acct.userId, billingCycle: cycle, ...snapshot })
		.onConflictDoUpdate({
			target: [accountCycles.userId, accountCycles.billingCycle],
			set: {
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
