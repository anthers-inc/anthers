// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund — the ledger's one writer, and the slice's one reader.
 *
 * Free accounts' Time Pools are funded by the Fund, not by a constant: the organization
 * chooses a **service level** each cycle — dollars per eligible free account — and the
 * pool is that rate times the eligible accounts, capped at the smallest paid Time Pool.
 * The Fund is a budget line spent from undirected revenue (support remainders,
 * contributions, anything not already committed to a specific user), not a percentage of
 * revenue (Parker, 2026-11-07). `packages/shared/src/time-pool-fund.ts` carries both the
 * actual arithmetic and the plan's projection; `financial_plan_settings` carries the
 * plan's shares, which describe the modeled path rather than this cycle's decision.
 *
 * One row per cycle in `pool_fund_ledger` is the published record:
 *
 * - **Actual** — the cycle ended or is in flight, computed from its own booked revenue
 *   and the service level in force. An ended cycle's holdings may still grow through
 *   Stripe's payment retries, so its revenue restates upward; **the active count and the
 *   rate never do.** The count is taken from raw `attention_events` and frozen at the
 *   row's first post-cycle actualization, because the daily rollup is identity-free and
 *   the raw rows prune after `ATTENTION_RAW_RETENTION_DAYS` — the row is the only durable
 *   record of a past cycle's count.
 * - **Committed** — the next month, published in advance from the same rate and the
 *   newest known active count, and frozen once written.
 * - **Estimate** — one cycle past the commitment, from the same rate and count.
 *
 * ⚠️ **Eligibility is not "every free account".** A Fund-funded Time Pool goes to
 * accounts that watched Public Access work in the cycle, hold no Anthers Badge, and are
 * not the platform's own account. @anthers.org holds no Anthers Badge, so without that
 * last exclusion the platform would count itself as a beneficiary, dilute every real
 * free account's slice, and pay creators with money the organization already owns.
 *
 * Nothing here re-derives another module's arithmetic: revenue is read from the holdings
 * through `anthersSupportBreakdown` at the model's fee split (the same decomposition
 * `growth.ts`'s ledger and settlement's books compose from), and the cap comes from the
 * seeded ladder's bottom rung. The rate is the one input this module owns, and it is a
 * budget decision rather than a formula.
 */
import { db } from "@anthers/db/client";
import {
	attentionEvents,
	badges,
	poolFundLedger,
	userBadges,
	userCycles,
} from "@anthers/db/schema";
import type { CycleKey } from "@anthers/shared/billing-cycle";
import { currentCycleKey, cycleEnd, cycleStart, nextCycleKey } from "@anthers/shared/billing-cycle";
import { PUBLIC_ACCESS_PRICE, supportAmount, timePoolByTimeFor } from "@anthers/shared/constants";
import { anthersSupportBreakdown, paymentsSplit } from "@anthers/shared/fees";
import { type FundStatus, timePoolFundActual } from "@anthers/shared/time-pool-fund";
import Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { anthersUserId, loadAnthersLadder } from "./anthers-badges.js";
import { loadPlanSettings } from "./financial-plan.js";

/** A cycle has ended: its last second is behind `now`. */
function cycleEnded(cycle: string, now: Date): boolean {
	return cycleEnd(cycle as CycleKey).getTime() < now.getTime();
}

/**
 * The Fund's per-account ceiling: the smallest paid Time Pool — a Root supporter's, from
 * the seeded ladder's bottom rung. $1.00 at the seeded ladder.
 *
 * 🚨 **The Time Pool line, not the Badge's whole creator half.** A Root supporter's
 * creator half is $1.50, but $0.50 of that is their Sticker budget — a channel a free
 * account does not have. Parity is with the named Time Pool figure ($1.00), so the
 * subsidized slice never becomes a better deal than the cheapest Badge (Parker's
 * correction, 2026-11-07).
 *
 * The rows are the source of truth — the same read the ladder route serves the browser —
 * and the fallback is the shared constant, which is what a fallback exists for (see the
 * web side's ladder store note on the 503/unseeded case).
 */
async function smallestPaidPool(): Promise<number> {
	const { publicAccessPrice } = await loadAnthersLadder();
	const price = publicAccessPrice ?? PUBLIC_ACCESS_PRICE;
	return timePoolByTimeFor(price);
}

/** The cycle's settings, loaded once per call site rather than per row. */
type FundSettings = { adminBudgetShare: number; freeAccessShare: number };

/**
 * The cycle's booked charitable revenue, on the basis the books record.
 *
 * - **A cycle the settlement books (`user_cycles` rows exist)** — the settled
 *   basis: the sum of each supporter's remainder, which the row carries as
 *   `foundation` less `time_pool_undistributed` (the dust a pool returns is the
 *   pool's money, not revenue). A late-paying invoice restates this upward, and the
 *   re-settlement against the restated slice is how the difference converges.
 * - **No books yet (the cycle in flight)** — the holdings basis: the sum over
 *   Anthers-ladder holdings for the cycle of the breakdown's remainder at the model's
 *   fee split. A holding exists only after its subscription was **active** (the
 *   webhook rule), so this is paid revenue, not intent; it is also the recurring base a
 *   commitment or estimate projects from, because a holding renews.
 *
 * The two describe one cycle and converge to the settled basis; a free account holds no
 * Anthers rung and contributes nothing, which is what charitable revenue is.
 *
 * ⚠️ **This is context for the published ledger, not the Fund's basis.** The Fund is a
 * budget line spent from all undirected revenue, contributions included; it does not
 * rise and fall with this figure (Parker, 2026-11-07). The financial plan keeps a
 * share-based projection so it can ask whether user revenue alone would carry the chosen
 * service level.
 */
export async function charitableRevenueForCycle(cycle: CycleKey): Promise<Decimal> {
	const settled = await db
		.select({
			total: sql<string>`COALESCE(SUM(${userCycles.foundation} - ${userCycles.timePoolUndistributed}), 0)`,
		})
		.from(userCycles)
		.where(eq(userCycles.billingCycle, cycle));
	const booked = new Decimal(settled[0]?.total ?? "0.00");
	if (settled.length > 0 && booked.greaterThan(0))
		return booked.toDecimalPlaces(2, Decimal.ROUND_DOWN);

	const anthersId = await anthersUserId();
	const rows = await db
		.select({ threshold: badges.threshold })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(and(eq(userBadges.billingCycle, cycle), sql`${badges.creatorId} = ${anthersId}`));
	let total = new Decimal(0);
	for (const row of rows) {
		const threshold = supportAmount(row.threshold);
		const bd = anthersSupportBreakdown(threshold, {
			payments: paymentsSplit(threshold, 0).anthers,
		});
		total = total.plus(bd.foundation);
	}
	return total.toDecimalPlaces(2, Decimal.ROUND_DOWN);
}

/**
 * The cycle's eligible free accounts — with at least one credited Public Access second
 * in the cycle, no Anthers holding for it, and not the platform's own account.
 *
 * 🚨 **The distributor and the denominator must read the same population.** A free
 * account that has never bought anything holds no `stripe_customers` row, so a
 * distribution that iterates customers alone would divide the pot by accounts it never
 * pays. This function is the one definition; the count and the distributor both call it.
 *
 * ⚠️ **Raw rows are the signal, and they are a superset of what the range split
 * credits** (the split can only shrink a total; it never creates seconds). A user the
 * raw rows see active but whose split credits under a second is a rounding-edge case in
 * a policy count — worth an honest note here, not a second full-table
 * `splitOverlappingRanges` pass per night. The raw rows prune at
 * `ATTENTION_RAW_RETENTION_DAYS`, so this query answers only inside the retention
 * window — which is exactly why a past cycle's count is frozen into its ledger row on
 * first actualization rather than recomputed forever.
 */
export async function activeFreeAccountIdsForCycle(cycle: CycleKey): Promise<number[]> {
	const anthersId = await anthersUserId();
	// The window is the billing-cycle helpers' arithmetic, never local month math —
	// the one calendar this codebase admits.
	const startIso = cycleStart(cycle).toISOString();
	const endIso = cycleEnd(cycle).toISOString();
	const rows = await db
		.selectDistinct({ userId: attentionEvents.userId })
		.from(attentionEvents)
		.where(
			and(
				eq(attentionEvents.publicAccess, true),
				// Zero-duration visit pings are analytics, not time.
				sql`${attentionEvents.durationSeconds} > 0`,
				// The cycle's window, on the real ranges — the same reading
				// `services/attention-ranges.ts` credits by (overlap, not containment).
				sql`COALESCE(${attentionEvents.startedAt}, ${attentionEvents.createdAt} - make_interval(secs => COALESCE(${attentionEvents.durationSeconds}, 0))) < ${endIso}::timestamptz`,
				sql`COALESCE(${attentionEvents.endedAt}, ${attentionEvents.createdAt}) > ${startIso}::timestamptz`,
				// 🚨 **The platform is not a beneficiary of its own Fund.** @anthers.org
				// holds no Anthers Badge, so without this it counts as a free account and
				// dilutes every real one.
				sql`${attentionEvents.userId} <> ${anthersId}`,
				// Free means no Anthers holding this cycle — the same predicate
				// `distributePool` reads when it decides whose pool is subsidized.
				sql`NOT EXISTS (SELECT 1 FROM ${userBadges} ub JOIN ${badges} b ON b.id = ub.badge_id
					WHERE ub.user_id = ${attentionEvents.userId} AND ub.billing_cycle = ${cycle}
					AND b.creator_id = ${anthersId})`,
			),
		);
	return rows.map((row) => row.userId);
}

/** The count, from the one population definition above. */
export async function activeFreeAccountsForCycle(cycle: CycleKey): Promise<number> {
	return (await activeFreeAccountIdsForCycle(cycle)).length;
}

/**
 * Compute one cycle's actual figures from the live data: revenue from the holdings, the
 * count from attention unless the row has frozen one, the rate in force, and the slice.
 * Shared by the nightly read and the monthly publish; the only writer of rows.
 */
async function actualizeCycle(cycle: CycleKey, now: Date) {
	const settings = await loadPlanSettings();
	const cap = await smallestPaidPool();
	const revenue = await charitableRevenueForCycle(cycle);
	const ended = cycleEnded(cycle, now);

	const [existing] = await db
		.select()
		.from(poolFundLedger)
		.where(eq(poolFundLedger.billingCycle, cycle))
		.limit(1);

	// The frozen rule: a count and the rate it was funded at are taken once, after the
	// cycle ended, and never recomputed (the raw rows it came from prune away; the row is
	// where they survive). The rate is frozen too, so a later budget decision cannot
	// restate what a past cycle paid.
	let active: number;
	let rate: Decimal;
	let frozenCap: Decimal;
	let actualizedAt: Date | null;
	if (existing?.actualizedAt != null) {
		active = existing.activeFreeAccounts;
		rate = new Decimal(existing.ratePerAccount);
		frozenCap = new Decimal(existing.capPerAccount);
		actualizedAt = existing.actualizedAt;
	} else {
		active = await activeFreeAccountsForCycle(cycle);
		// The chosen service level: as much as the discretionary budget allows, never
		// above the cap. The settings row carries the standing choice; a thinner month
		// lowers it there. The cap is read from the ladder, so a re-priced Root rung
		// lowers the ceiling without a code change.
		rate = new Decimal(Math.min(settings.timePoolRatePerUser, cap));
		frozenCap = new Decimal(cap);
		actualizedAt = ended ? now : null;
	}

	const fund = timePoolFundActual({
		ratePerAccount: rate,
		activeFreeAccounts: active,
		capPerAccount: frozenCap,
	});

	const values = {
		status: "actual" as FundStatus,
		charitableRevenue: revenue.toFixed(2),
		adminBudgetShare: settings.adminBudgetShare,
		freeAccessShare: settings.freeAccessShare,
		ratePerAccount: fund.rate.toFixed(2),
		capPerAccount: frozenCap.toFixed(2),
		poolAmount: fund.pool.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
		activeFreeAccounts: active,
		slicePerAccount: fund.slice.toFixed(2),
		actualizedAt,
		updatedAt: now,
	};

	if (existing) {
		await db.update(poolFundLedger).set(values).where(eq(poolFundLedger.billingCycle, cycle));
	} else {
		await db.insert(poolFundLedger).values({ billingCycle: cycle, ...values });
	}
	return { ...fund, activeFreeAccounts: active };
}

/**
 * The per-account slice the Fund funds for `cycle` — what `computeMonth`'s free
 * branch reads, through `distribute-pool` and `settle-cycle`. Ensures the row on
 * first need, so a cycle that starts before its publish run still answers: the
 * renewals charge on the 1st and this read restates the row behind them the same
 * night, which is what "the current month (actual)" means.
 */
export async function freeSliceForCycle(
	cycle: CycleKey,
	/** The moment the read counts as. Defaults to now; a job passes its own so a future-dated test cycle freezes correctly. */
	now: Date = new Date(),
): Promise<{ slice: number; pool: number; activeFreeAccounts: number }> {
	const fund = await actualizeCycle(cycle, now);
	return {
		slice: fund.slice.toNumber(),
		pool: fund.pool.toNumber(),
		activeFreeAccounts: fund.activeFreeAccounts,
	};
}

/**
 * Publication: actualize every cycle the settled books name (including one whose
 * revenue was $0 — the doctrine working), restate the current cycle, commit the next
 * month from the same rate and the newest known count, and estimate one further. Runs
 * monthly, on the 2nd, after the day's settlement, per the queue's schedule.
 *
 * The committed and estimate rows are written once and never restated while future
 * ("frozen when published"); when their cycle arrives, actualization rewrites them from
 * their own revenue and the rate in force, so a revised budget lands at the moment of
 * truth rather than in a promise.
 */
export async function publishFundLedger(now: Date = new Date()): Promise<number> {
	const current = currentCycleKey(now);
	const next = nextCycleKey(current as CycleKey);
	const after = nextCycleKey(next);

	// Every cycle the settled books name, actualized from its own holdings — a $0
	// month included, since every settlement writes one `user_cycles` row per
	// supporter and the ledger publishes every cycle since the mechanism deployed.
	const settledCycles = await db
		.selectDistinct({ cycle: userCycles.billingCycle })
		.from(userCycles)
		.where(sql`${userCycles.billingCycle} < ${current}`);
	let published = 0;
	for (const row of settledCycles) {
		await actualizeCycle(row.cycle as CycleKey, now);
		published++;
	}

	// The current cycle — in flight; its count stays live until the cycle ends.
	await actualizeCycle(current as CycleKey, now);
	published++;

	// The projection is the same service level against the newest count there is — the
	// current cycle's live count — because on the path's first cycles there is no frozen
	// history to project from.
	const [projection] = await db
		.select({ count: poolFundLedger.activeFreeAccounts })
		.from(poolFundLedger)
		.where(sql`${poolFundLedger.billingCycle} = ${current}`)
		.limit(1);
	const settings = await loadPlanSettings();
	const cap = await smallestPaidPool();
	const recurring = await charitableRevenueForCycle(current as CycleKey);
	const projectedActive = projection?.count ?? 0;
	const fund = timePoolFundActual({
		ratePerAccount: Math.min(settings.timePoolRatePerUser, cap),
		activeFreeAccounts: projectedActive,
		capPerAccount: cap,
	});

	await insertFutureRow(next, "committed", recurring, settings, cap, projectedActive, fund, now);
	await insertFutureRow(after, "estimate", recurring, settings, cap, projectedActive, fund, now);
	published += 2;

	return published;
}

/**
 * Insert a future cycle's row only when absent — frozen thereafter. The row records the
 * rate and the projected count it was computed against, which is the honest thing to show
 * beside a promise.
 */
async function insertFutureRow(
	cycle: CycleKey,
	status: "committed" | "estimate",
	recurring: Decimal,
	settings: FundSettings,
	cap: number,
	projectedActive: number,
	fund: { pool: Decimal; slice: Decimal; rate: Decimal },
	now: Date,
): Promise<void> {
	const [existing] = await db
		.select({ id: poolFundLedger.id })
		.from(poolFundLedger)
		.where(eq(poolFundLedger.billingCycle, cycle))
		.limit(1);
	if (existing) return;
	await db.insert(poolFundLedger).values({
		billingCycle: cycle,
		status,
		charitableRevenue: recurring.toFixed(2),
		adminBudgetShare: settings.adminBudgetShare,
		freeAccessShare: settings.freeAccessShare,
		ratePerAccount: fund.rate.toFixed(2),
		capPerAccount: cap.toFixed(2),
		poolAmount: fund.pool.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
		activeFreeAccounts: projectedActive,
		slicePerAccount: fund.slice.toFixed(2),
		actualizedAt: null,
		updatedAt: now,
	});
}

/**
 * The published ledger, as the public route serves it — the transparency surface,
 * newest first: every cycle since the mechanism deployed, actuals and the
 * commitment and the estimate alike, each row saying which it is.
 */
export async function publishedFundLedger(): Promise<
	{
		billingCycle: string;
		status: string;
		charitableRevenue: number;
		ratePerAccount: number;
		capPerAccount: number;
		poolAmount: number;
		activeFreeAccounts: number;
		slicePerAccount: number;
	}[]
> {
	const rows = await db
		.select()
		.from(poolFundLedger)
		.orderBy(desc(poolFundLedger.billingCycle))
		.limit(24);
	return rows.map((row) => ({
		billingCycle: row.billingCycle,
		status: row.status,
		charitableRevenue: Number(row.charitableRevenue),
		ratePerAccount: Number(row.ratePerAccount),
		capPerAccount: Number(row.capPerAccount),
		poolAmount: Number(row.poolAmount),
		activeFreeAccounts: row.activeFreeAccounts,
		slicePerAccount: Number(row.slicePerAccount),
	}));
}
