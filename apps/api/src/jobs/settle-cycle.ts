// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cycle settlement job — the money that moves at month-end, per account:
 *
 * 1. **remainder inflow.** The **remainder** of what this account gives Anthers —
 *    what's left after its Time Pool (`TIME_POOL_RATE`, half) and its pro-rata share of
 *    the at-cost Payments line. Users who also direct support at creators leave more for
 *    the mission, because the fixed card fee is charged once on the whole batched
 *    monthly charge. Free accounts (giving $0) contribute nothing — their
 *    `FREE_TIME_POOL` is subsidized. The remainder is the shock absorber: Time Pool
 *    is a fixed share and never moves against it, so cost swings land here, never on
 *    creator pay.
 *
 *    ⚠️ **This read "each $3 after its Time Pool ($1.50)" and "their $0.05 Time Pool"
 *    until 2026-08-19.** The first describes the retired unit; the second was simply a
 *    **wrong number** — `FREE_TIME_POOL` is `0.25`, and has been since 2026-08-12. Both
 *    dials are named rather than quoted here so this cannot drift again.
 * 2. **Undistributed Time Pool → the remainder.** A viewer's pool is a fixed half of what
 *    they give Anthers, and since the Public Access fix it reaches only creators whose work
 *    they streamed ungated — so a viewer with no Public Access seconds funds a pool that
 *    reaches nobody. Until 2026-08-29 that money landed nowhere at all: the budget was
 *    recorded, the remainder was computed net of it, and no `pool_distributions` row was
 *    written, so the amount was booked to neither a creator nor the mission. Parker settled
 *    it on 2026-08-26 — **it falls to the remainder**, on the footing that unallocated
 *    Anthers money goes there anyway.
 *
 *    ⚠️ **Two situations produce it and the second is not rare.** One is a viewer who
 *    consumed no Public Access in the cycle. The other is a sharer who watched nothing
 *    themselves: `distribute-pool` treats the share-link slice as a ceiling rather than a
 *    reservation, so the rest of their pool stays undistributed by design. Neither requires
 *    the viewer to have logged zero attention — hours of purchased or Badge-cleared work draw
 *    nothing here — so do not size this from the older "truly zero attention time" framing.
 * 3. **Record** the cycle snapshot.
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
import {
	accountCycles,
	accounts,
	crfLedger,
	poolDistributions,
	seedAllocations,
} from "@anthers/db/schema";
import { supportAmount } from "@anthers/shared/constants";
import { anthersSupportBreakdown, paymentsSplit } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { billingCycleDate } from "./distribute-pool.js";

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

/**
 * Can `distribute-pool` still write to this cycle for this account?
 *
 * 🚨 **This is the whole safety of booking a shortfall, because the two jobs run on
 * different clocks.** `distribute-pool` runs daily and upserts rows keyed by the account's
 * own billing period; `settle-cycle` runs monthly and books the difference once. Take that
 * difference while the pool job can still pay some of it out and the same dollars land in the
 * remainder *and* in a creator's ledger — the one failure this change must not create.
 *
 * So the question is not whether the calendar month is over, it is **which cycle key the pool
 * job would write to for this account right now** — and the answer is a mirror of
 * `getBillingCycle`, fallback included: the account's period start, or the current calendar
 * month when it has none. The ordinary sequence is the pool job running through the month, the
 * period advancing, and settlement then finding the cycle closed; a period that has not
 * advanced keeps the cycle open long after the month has ended, which is exactly when a
 * shortfall would be wrong.
 *
 * ⭐ **An open cycle books nothing rather than deferring.** The marker makes settlement
 * once-per-cycle and `defaultCycle()` never looks back further than a month, so a deferred
 * account would simply never settle. Booking zero leaves the remainder exactly as it was
 * before any of this existed, which is the conservative direction: money stays unbooked rather
 * than being booked twice.
 */
function cycleStillOpen(acct: { currentPeriodStart: Date | null }, cycle: string): boolean {
	const now = new Date();
	const openCycle = acct.currentPeriodStart
		? billingCycleDate(acct.currentPeriodStart)
		: billingCycleDate(new Date(now.getFullYear(), now.getMonth(), 1));
	return openCycle === cycle;
}

const CENTS = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

async function settleAccount(
	acct: {
		id: number;
		userId: number;
		anthersSupport: string;
		creatorSupportTotal: string;
		currentPeriodStart: Date | null;
	},
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

	const n = supportAmount(acct.anthersSupport);

	// Directed creator support this cycle. Needed BEFORE the remainder inflow, because
	// the at-cost card fee is charged on the whole batched monthly charge and split
	// pro-rata — so directed support amortizes the fixed $0.30 and leaves a fatter
	// remainder. Anthers takes no cut of these; they are recorded, not an inflow.
	const [dir] = await db
		.select({ total: sql<string>`COALESCE(SUM(CAST(amount AS numeric)), 0)` })
		.from(seedAllocations)
		.where(and(eq(seedAllocations.userId, acct.userId), eq(seedAllocations.billingCycle, cycle)));
	const directedSeeds = new Decimal(dir?.total ?? 0);

	// 1. remainder inflow: the remainder of what this account gives Anthers, after their
	//    Time Pool and their share of the at-cost Payments line (a bigger basket
	//    leaves more, because the fixed $0.30 is per charge). Passing `payments` here
	//    is load-bearing — omit it and the charitable ledger is over-credited by the
	//    card fee, which typechecks fine because the option is optional.
	const split = paymentsSplit(n, directedSeeds.toNumber());
	const bd = anthersSupportBreakdown(n, { payments: split.anthers });

	// 2. Whatever this account's Time Pool did NOT reach a creator with.
	//
	// Measured against what `distribute-pool` actually wrote rather than against what it was
	// budgeted, because the budget is the promise and the rows are the payment. A viewer with
	// no Public Access seconds has no rows at all and the whole pool is the shortfall; a
	// sharer who watched nothing themselves has rows for the share-link slice only, and the
	// rest of their pool is the shortfall.
	//
	// ⚠️ **Clamped at zero rather than trusted to be non-negative.** `pool_amount` is corrected
	// for rounding drift against the distributed pots, so a cent of drift the other way is
	// possible in principle — and a negative shortfall would quietly take money *out* of the
	// remainder, which is a worse error than the one this fixes.
	const [distributedRow] = cycleStillOpen(acct, cycle)
		? [undefined]
		: await db
				// 🚨 **Stickers count as distributed, and leaving them out would book money a
				// user aimed at a creator to Anthers' own remainder instead.** A Sticker is an
				// override of the Time Pool: `distribute-pool` distributes by time only what was
				// not directed, so the directed part is missing from `pool_amount` by design and
				// would read as a shortfall. That is the failure this file exists to prevent,
				// pointed the wrong way — silently cutting creator earnings while every total
				// still adds up.
				.select({
					total: sql<string>`COALESCE(SUM(${poolDistributions.poolAmount} + ${poolDistributions.stickerAmount}), 0)`,
				})
				.from(poolDistributions)
				.where(
					and(
						eq(poolDistributions.subscriberId, acct.userId),
						eq(poolDistributions.billingCycle, cycle),
					),
				);
	const undistributed = distributedRow
		? CENTS(Decimal.max(0, bd.timePool.minus(new Decimal(distributedRow.total ?? 0))))
		: new Decimal(0);

	// 3. remainder inflow: the account's own remainder, plus any pool that reached nobody.
	const remainder = CENTS(Decimal.max(0, bd.foundation));
	const inflow = CENTS(remainder.plus(undistributed));

	const poolNote = undistributed.gt(0)
		? `, undistributed Time Pool $${undistributed.toFixed(2)}`
		: "";
	await db.insert(crfLedger).values({
		amount: inflow.toFixed(2),
		description: inflow.gt(0)
			? `${marker} remainder $${remainder.toFixed(2)}${poolNote} from $${n.toFixed(2)} to Anthers (Time Pool $${bd.timePool.toFixed(2)}, Payments $${bd.payments.toFixed(2)})`
			: `${marker} no remainder inflow (free rank)`,
	});

	// 4. Record the cycle snapshot.
	const snapshot = {
		anthersSupport: new Decimal(n).toFixed(2),
		creatorSupportTotal: directedSeeds.toFixed(2),
		timePool: bd.timePool.toFixed(2),
		timePoolUndistributed: undistributed.toFixed(2),
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
				timePoolUndistributed: snapshot.timePoolUndistributed,
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
