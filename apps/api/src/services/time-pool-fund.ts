// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund — the ledger's one writer, and the slice's one reader.
 *
 * Free accounts' Time Pools are funded by the Fund, not by a constant: a stated
 * share of the charitable remainder after the admin budget, published monthly,
 * divided across the cycle's active free accounts (`packages/shared/src/
 * time-pool-fund.ts` carries the arithmetic; `financial_plan_settings` carries the
 * shares — the plan tool's settings row is the raw data host this mechanism reads).
 *
 * One row per cycle in `time_pool_fund_ledger` is the published record:
 *
 * - **Actual** — the cycle ended or is in flight, computed from that cycle's own
 *   booked Anthers holdings. An ended cycle's holdings may still grow through
 *   Stripe's payment retries, so its revenue, pool and slice restate upward (the
 *   parity ceiling recomputes against the frozen count each time); **the active
 *   count never does.** It is taken from raw `attention_events` and frozen at the
 *   row's first post-cycle actualization, because the daily rollup is
 *   identity-free and the raw rows prune after `ATTENTION_RAW_RETENTION_DAYS` —
 *   the row is the only durable record of a past cycle's count.
 * - **Committed** — the next month, published in advance from the recurring base
 *   (the current cycle's holdings, which renew) and frozen once written.
 * - **Estimate** — one cycle past the commitment, from the same recurring base.
 *
 * Nothing here re-derives another module's arithmetic: revenue is read from the
 * holdings through `anthersSupportBreakdown` at the model's fee split (the same
 * decomposition `growth.ts`'s ledger and settlement's books compose from), shares
 * come from `loadPlanSettings`, and the smallest paid pool — the parity ceiling's
 * base — comes from the seeded ladder's bottom rung. A commitment is a promise to
 * free accounts and a floor restated by revenue overshooting alone, which
 * self-corrects the following month; it is never quietly revised down.
 */
import { db } from "@anthers/db/client";
import {
	attentionEvents,
	badges,
	timePoolFundLedger,
	userBadges,
	userCycles,
} from "@anthers/db/schema";
import type { CycleKey } from "@anthers/shared/billing-cycle";
import { currentCycleKey, cycleEnd, cycleStart, nextCycleKey } from "@anthers/shared/billing-cycle";
import { PUBLIC_ACCESS_PRICE, supportAmount, timePoolFor } from "@anthers/shared/constants";
import { anthersSupportBreakdown, paymentsSplit } from "@anthers/shared/fees";
import { type FundStatus, timePoolFundPool } from "@anthers/shared/time-pool-fund";
import Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { anthersUserId, loadAnthersLadder } from "./anthers-badges.js";
import { loadPlanSettings } from "./financial-plan.js";

/** A cycle has ended: its last second is behind `now`. */
function cycleEnded(cycle: string, now: Date): boolean {
	return cycleEnd(cycle as CycleKey).getTime() < now.getTime();
}

/**
 * The parity ceiling's base: the smallest paid pool — a Root supporter's, from the
 * seeded ladder's bottom rung (the price given to `timePoolFor`, never the price
 * itself). The rows are the source of truth — the same read the ladder route serves
 * the browser — and the fallback is the shared constant, which is what a fallback
 * exists for (see the web side's ladder store note on the 503/unseeded case).
 */
async function smallestPaidPool(): Promise<number> {
	const { publicAccessPrice } = await loadAnthersLadder();
	const price = publicAccessPrice ?? PUBLIC_ACCESS_PRICE;
	return timePoolFor(price);
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
 *   webhook rule), so this is paid revenue, not intent; it is also the recurring
 *   base a commitment or estimate projects from, because a holding renews.
 *
 * The two describe one cycle and converge to the settled basis; a free account holds
 * no Anthers rung and contributes nothing, which is what charitable revenue is.
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
 * The cycle's active free accounts — with at least one credited Public Access second
 * in the cycle and no Anthers holding for it.
 *
 * ⚠️ **Raw rows are the signal, and they are a superset of what the range split
 * credits** (the split can only shrink a total; it never creates seconds). A user the
 * raw rows see active but whose split credits under a second is a rounding-edge case
 * in a policy count — worth an honest note here, not a second full-table
 * `splitOverlappingRanges` pass per night. The raw rows prune at
 * `ATTENTION_RAW_RETENTION_DAYS`, so this query answers only inside the retention
 * window — which is exactly why a past cycle's count is frozen into its ledger row
 * on first actualization rather than recomputed forever.
 */
export async function activeFreeAccountsForCycle(cycle: CycleKey): Promise<number> {
	const anthersId = await anthersUserId();
	// The window is the billing-cycle helpers' arithmetic, never local month math —
	// the one calendar this codebase admits.
	const startIso = cycleStart(cycle).toISOString();
	const endIso = cycleEnd(cycle).toISOString();
	const [row] = await db
		.select({
			count: sql<number>`COUNT(DISTINCT ${attentionEvents.userId})::int`,
		})
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
				// Free means no Anthers holding this cycle — the same predicate
				// `distributePool` reads when it decides whose pool is subsidized.
				sql`NOT EXISTS (SELECT 1 FROM ${userBadges} ub JOIN ${badges} b ON b.id = ub.badge_id
					WHERE ub.user_id = ${attentionEvents.userId} AND ub.billing_cycle = ${cycle}
					AND b.creator_id = ${anthersId})`,
			),
		);
	return row?.count ?? 0;
}

/**
 * Compute one cycle's actual figures from the live data: revenue from the holdings,
 * the count from attention (raw rows) unless the row has frozen one, and the slice.
 * Shared by the nightly read and the monthly publish; the only writer of rows.
 */
async function actualizeCycle(cycle: CycleKey, now: Date) {
	const settings = await loadPlanSettings();
	const rootPool = await smallestPaidPool();
	const revenue = await charitableRevenueForCycle(cycle);
	const ended = cycleEnded(cycle, now);

	const [existing] = await db
		.select()
		.from(timePoolFundLedger)
		.where(eq(timePoolFundLedger.billingCycle, cycle))
		.limit(1);

	// The frozen count rule: a count is taken once, after the cycle ended, and never
	// recomputed (the raw rows it came from prune away; the row is where it survives).
	let active: number;
	let actualizedAt: Date | null;
	if (existing?.actualizedAt != null) {
		active = existing.activeFreeAccounts;
		actualizedAt = existing.actualizedAt;
	} else {
		active = await activeFreeAccountsForCycle(cycle);
		actualizedAt = ended ? now : null;
	}

	const fund = timePoolFundPool({
		charitableRevenue: revenue,
		adminBudgetShare: settings.adminBudgetShare,
		freeAccessShare: settings.freeAccessShare,
		activeFreeAccounts: active,
		rootPool,
	});

	const values = {
		status: "actual" as FundStatus,
		charitableRevenue: revenue.toFixed(2),
		adminBudgetShare: settings.adminBudgetShare,
		freeAccessShare: settings.freeAccessShare,
		poolAmount: fund.pool.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
		activeFreeAccounts: active,
		slicePerAccount: fund.slice.toFixed(2),
		actualizedAt,
		updatedAt: now,
	};

	if (existing) {
		await db
			.update(timePoolFundLedger)
			.set(values)
			.where(eq(timePoolFundLedger.billingCycle, cycle));
	} else {
		await db.insert(timePoolFundLedger).values({ billingCycle: cycle, ...values });
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
 * month from the recurring base, estimate one further. Runs monthly, on the 2nd,
 * after the day's settlement, per the queue's schedule.
 *
 * The committed and estimate rows are written once and never restated while future
 * ("frozen when published"); when their cycle arrives, actualization rewrites them
 * from their own holdings — restating a commitment only by revenue overshooting,
 * down at the moment of truth, with the difference self-correcting in the next
 * month's commitment.
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

	// The recurring base is the current cycle's holdings (they renew), computed by
	// the same read the actual rows use; the committed row's revenue column records
	// the basis it projects from. The ceiling's projection is the newest count there
	// is — the current cycle's live count — because on the path's first cycles there
	// is no frozen history to project from.
	const [projection] = await db
		.select({ count: timePoolFundLedger.activeFreeAccounts })
		.from(timePoolFundLedger)
		.where(sql`${timePoolFundLedger.billingCycle} = ${current}`)
		.limit(1);
	const settings = await loadPlanSettings();
	const rootPool = await smallestPaidPool();
	const recurring = await charitableRevenueForCycle(current as CycleKey);
	const fund = timePoolFundPool({
		charitableRevenue: recurring,
		adminBudgetShare: settings.adminBudgetShare,
		freeAccessShare: settings.freeAccessShare,
		activeFreeAccounts: projection?.count ?? 0,
		rootPool,
	});

	await insertFutureRow(next, "committed", recurring, settings, projection?.count ?? 0, fund, now);
	await insertFutureRow(after, "estimate", recurring, settings, projection?.count ?? 0, fund, now);
	published += 2;

	return published;
}

/**
 * Insert a future cycle's row only when absent — frozen thereafter. `pool` and
 * `slice` come from the caller's single computation; the row records the projection
 * count it was computed against, which is the honest thing to show beside a promise.
 */
async function insertFutureRow(
	cycle: CycleKey,
	status: "committed" | "estimate",
	recurring: Decimal,
	settings: FundSettings,
	projectedActive: number,
	fund: { pool: Decimal; slice: Decimal },
	now: Date,
): Promise<void> {
	const [existing] = await db
		.select({ id: timePoolFundLedger.id })
		.from(timePoolFundLedger)
		.where(eq(timePoolFundLedger.billingCycle, cycle))
		.limit(1);
	if (existing) return;
	await db.insert(timePoolFundLedger).values({
		billingCycle: cycle,
		status,
		charitableRevenue: recurring.toFixed(2),
		adminBudgetShare: settings.adminBudgetShare,
		freeAccessShare: settings.freeAccessShare,
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
		poolAmount: number;
		activeFreeAccounts: number;
		slicePerAccount: number;
	}[]
> {
	const rows = await db
		.select()
		.from(timePoolFundLedger)
		.orderBy(desc(timePoolFundLedger.billingCycle))
		.limit(24);
	return rows.map((row) => ({
		billingCycle: row.billingCycle,
		status: row.status,
		charitableRevenue: Number(row.charitableRevenue),
		poolAmount: Number(row.poolAmount),
		activeFreeAccounts: row.activeFreeAccounts,
		slicePerAccount: Number(row.slicePerAccount),
	}));
}
