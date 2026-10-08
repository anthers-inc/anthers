// SPDX-License-Identifier: Apache-2.0
/**
 * The Noun Project spend guards — the per-creator daily budget, the key-wide circuit
 * breaker, and the blocklist — and the only module that writes their records.
 *
 * 🚨 **THE PER-CREATOR BUDGET IS THE ONE THAT IS EASY TO SKIP AND IS NOT OPTIONAL.** At a
 * thousand creators, ten obsessive ones at a dollar a day is $300 a month — the only
 * scenario in the Badge Maker's design that reaches the vendor's Custom plan minimum,
 * and it would reach it while producing nothing. Icon calls track compositions rather
 * than distinct icons, so no maturity effect ever saturates the spend curve; this budget
 * is the bound on the platform.
 *
 * 🚨 **Exhaustion degrades rather than errors.** The ladder a creator already made keeps
 * rendering from its stored composites; new searches and saves decline politely. The
 * answers here are structured refusals the picker states, never a 500 and never a
 * broken page.
 *
 * 🚨 **Search results are not cached at all, in any form** — the vendor's API access
 * review stated the term in writing — so there is deliberately no query cache here to
 * tune: the debounce on the client and THIS budget are what bound a futzing creator.
 * What persists is what the vendor permits for an icon a creator actually selected: the
 * provenance row and the composed Badge PNG.
 */

import { db } from "@anthers/db/client";
import { nounSpend } from "@anthers/db/schema";
import { and, eq, sql } from "drizzle-orm";
import { CALL_PRICE, type CallClass } from "../lib/noun/client";

/** Per-creator daily limits — about three times what a five-rung ladder actually takes. */
export const DAILY_ICON_BUDGET = 25;
export const DAILY_SERVICE_BUDGET = 300;

/**
 * The UTC day a spend lands on, as `YYYY-MM-DD` — the key the counter is read and
 * incremented under. Days rather than rolling 24-hour windows, because a budget a
 * creator can reason about is one that resets at a time they can name.
 */
export function spendDay(at = new Date()): string {
	return at.toISOString().slice(0, 10);
}

export interface SpendVerdict {
	/** False when the named call class is over budget and the request declines. */
	ok: boolean;
	/** What this creator has spent of each class today. */
	iconCalls: number;
	serviceCalls: number;
	iconBudget: number;
	serviceBudget: number;
}

/**
 * Read one creator's spend today, without recording anything.
 *
 * The picker reads this to show a creator where they stand, and the routes read it
 * before every vendor call.
 */
export async function spendToday(creatorId: number, day = spendDay()): Promise<SpendVerdict> {
	const [row] = await db
		.select()
		.from(nounSpend)
		.where(and(eq(nounSpend.creatorId, creatorId), eq(nounSpend.day, day)))
		.limit(1);
	return {
		ok: true,
		iconCalls: row?.iconCalls ?? 0,
		serviceCalls: row?.serviceCalls ?? 0,
		iconBudget: DAILY_ICON_BUDGET,
		serviceBudget: DAILY_SERVICE_BUDGET,
	};
}

/**
 * Check whether one more call of a class fits today's budget, without recording it.
 *
 * 🚨 **Check BEFORE the vendor call, record AFTER it succeeded** — recording on the way
 * in would charge a creator for a call the vendor refused, and checking after the call
 * would be a budget that exists to be exceeded.
 */
export async function checkBudget(creatorId: number, klass: CallClass): Promise<SpendVerdict> {
	const day = spendDay();
	const [row] = await db
		.select()
		.from(nounSpend)
		.where(and(eq(nounSpend.creatorId, creatorId), eq(nounSpend.day, day)))
		.limit(1);
	const iconCalls = row?.iconCalls ?? 0;
	const serviceCalls = row?.serviceCalls ?? 0;
	const overIcon = klass === "icon" && iconCalls >= DAILY_ICON_BUDGET;
	const overService = klass === "service" && serviceCalls >= DAILY_SERVICE_BUDGET;
	return {
		ok: !overIcon && !overService,
		iconCalls,
		serviceCalls,
		iconBudget: DAILY_ICON_BUDGET,
		serviceBudget: DAILY_SERVICE_BUDGET,
	};
}

/**
 * Record one spent call of a class for a creator, on today's counter.
 *
 * The row is created on first spend and updated thereafter, atomically enough for a
 * counter whose failure direction is "one call uncounted" rather than "a creator blocked".
 */
export async function recordSpend(creatorId: number, klass: CallClass): Promise<void> {
	const day = spendDay();
	const col = klass === "icon" ? nounSpend.iconCalls : nounSpend.serviceCalls;
	await db
		.insert(nounSpend)
		.values({ creatorId, day, iconCalls: 0, serviceCalls: 0 })
		.onConflictDoNothing();
	await db
		.update(nounSpend)
		.set({
			[klass === "icon" ? "iconCalls" : "serviceCalls"]: sql`${col} + 1`,
			updatedAt: new Date(),
		})
		.where(and(eq(nounSpend.creatorId, creatorId), eq(nounSpend.day, day)));
}

// ── The circuit breaker ──────────────────────────────────────────────────────

/**
 * The key's monthly spend, estimated from what Anthers has recorded.
 *
 * 🚨 **The breaker's job is to degrade BEFORE the vendor's own cap hard-fails a creator
 * mid-save.** The estimate sums every creator's recorded spend for the current month —
 * deliberately local rather than a live `/v2/client/usage` read, because a breaker that
 * depends on a vendor call to decide whether to make a vendor call cannot open when the
 * vendor is the thing that is degraded. The estimate is what the routes consult; the
 * dashboard's configured cap is the authority it approximates.
 */
export async function monthSpendEstimate(now = new Date()): Promise<number> {
	const month = now.toISOString().slice(0, 7);
	const rows = await db
		.select({
			iconCalls: sql<number>`coalesce(sum(${nounSpend.iconCalls}), 0)`,
			serviceCalls: sql<number>`coalesce(sum(${nounSpend.serviceCalls}), 0)`,
		})
		.from(nounSpend)
		.where(sql`${nounSpend.day} like ${`${month}%`}`);
	const r = rows[0];
	return (
		Number(r?.iconCalls ?? 0) * CALL_PRICE.icon + Number(r?.serviceCalls ?? 0) * CALL_PRICE.service
	);
}

/**
 * The configured monthly spend cap, in dollars — an env for the same reason every
 * deployment-shaping figure is one. Unset means the breaker is inert, which is the
 * development posture; a public deployment sets it. Provisioned through
 * `make spec-apply` like the key itself.
 */
export function monthlySpendCap(): number | null {
	const raw = (process.env.NOUN_PROJECT_MONTHLY_CAP_USD ?? "").trim();
	if (!raw) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Whether the key-wide breaker allows one more call of a class.
 *
 * ⚠️ **The breaker compares the ESTIMATE against the cap with headroom, not at equality**:
 * at 90% of the cap the picker already degrades, so a launch is throttled before the
 * vendor's own wall is met rather than after.
 */
export async function breakerAllows(klass: CallClass): Promise<boolean> {
	const cap = monthlySpendCap();
	if (cap === null) return true;
	const spend = await monthSpendEstimate();
	const projected = spend + CALL_PRICE[klass];
	// Degrade at 90%: the last 10% of the cap is the buffer that keeps a save from
	// straddling the wall.
	return projected <= cap * 0.9;
}

export interface BudgetRefusal {
	code: "budget_exhausted" | "breaker_open";
	iconCalls: number;
	serviceCalls: number;
	iconBudget: number;
	serviceBudget: number;
}

/**
 * The structured refusal a route answers when a guard declines — degrade, never error.
 */
export function budgetRefusal(verdict: SpendVerdict, breakerOpen: boolean): BudgetRefusal {
	return {
		code: breakerOpen ? "breaker_open" : "budget_exhausted",
		iconCalls: verdict.iconCalls,
		serviceCalls: verdict.serviceCalls,
		iconBudget: verdict.iconBudget,
		serviceBudget: verdict.serviceBudget,
	};
}
