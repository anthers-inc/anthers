// SPDX-License-Identifier: Apache-2.0
/**
 * What a month is — the one definition, in UTC.
 *
 * Every account renews on the 1st, so distribution, settlement, allocations, gate clearing,
 * Sticker budgets and the subsidy job all key the same calendar month. That only holds if
 * they all compute the key the same way, and until 2026-09-15 **four functions computed it
 * independently** — `billingCycleDate` in `jobs/distribute-pool.ts`, `currentBillingCycle` in
 * both `services/billing.ts` and `services/access.ts`, and `getCurrentBillingCycle` in
 * `routes/subscriptions.ts`. They agreed, which is what made them safe to leave.
 *
 * 🚨 **Pinned to UTC, and that is the fix rather than a detail.** All four read the process's
 * local time while the crons that call them run in UTC, so on a machine behind UTC the last
 * hours of a month were keyed to the month that had already ended at Stripe. "The 1st" has to
 * be the 1st *somewhere specific* once every account in the world renews on it, and Stripe
 * schedules in UTC, so that is the somewhere. Never reach for `getFullYear`/`getMonth` here —
 * they are the local-time users this module exists to replace.
 *
 * This module imports nothing but the platform: it is reachable from the web SPA's bundle
 * graph (its calendar helpers answer `SettingsPage` and friends), so it holds **no
 * decimal.js** — the money arithmetic that started here, `reductionFor`, lives in
 * `fees.ts`, the one module allowed to import the library
 * (`scripts/web-bundle-decimal-guard.test.ts` walks the web import graph and fails the
 * build the day one appears).
 */

/** `YYYY-MM-01` — the key every per-cycle table is keyed by. */
export type CycleKey = string;

const KEY_PATTERN = /^\d{4}-\d{2}-01$/;

/** Whether a string is a well-formed cycle key. */
export function isCycleKey(value: string): value is CycleKey {
	return KEY_PATTERN.test(value);
}

/** The cycle a moment falls in. */
export function cycleKeyFor(date: Date): CycleKey {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, "0");
	return `${y}-${m}-01`;
}

/** The cycle we are in now. `now` is a parameter so a test can stand somewhere else. */
export function currentCycleKey(now: Date = new Date()): CycleKey {
	return cycleKeyFor(now);
}

/** Midnight UTC on the 1st — the instant the cycle opens. */
export function cycleStart(key: CycleKey): Date {
	return new Date(`${key}T00:00:00.000Z`);
}

/** Midnight UTC on the next 1st — exclusive, so a cycle is `[start, end)`. */
export function cycleEnd(key: CycleKey): Date {
	const start = cycleStart(key);
	return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
}

/** The cycle after this one. */
export function nextCycleKey(key: CycleKey): CycleKey {
	return cycleKeyFor(cycleEnd(key));
}

/**
 * The cycle before this one — what a settlement run reaches back to.
 *
 * ⚠️ **Built by stepping back from the 1st rather than by `setMonth(m - 1)`**, which is the
 * shape that goes wrong on the 31st: `setMonth` keeps the day-of-month and overflows, so 31
 * March minus one month is 3 March. Every key here is already the 1st, so there is no day to
 * preserve and no overflow to hit — but the arithmetic is written this way so that stays true
 * if somebody passes a date rather than a key.
 */
export function previousCycleKey(key: CycleKey): CycleKey {
	const start = cycleStart(key);
	return cycleKeyFor(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1)));
}

/** How many days this particular month has — 28 through 31, never an average. */
export function daysInCycle(key: CycleKey): number {
	return (cycleEnd(key).getTime() - cycleStart(key).getTime()) / 86_400_000;
}

/**
 * Which day of the month a moment is, 1-based.
 *
 * ⚠️ **The day something started is the day it is charged for**, so the 20th is day 20 and
 * the nineteen days before it are what the reduction pays back. Reading this 0-based would
 * hand back one day too many to everybody and one full day of a $0 line to nobody.
 */
export function dayOfCycle(date: Date): number {
	return date.getUTCDate();
}
