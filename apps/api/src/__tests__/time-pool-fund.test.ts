// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund's ledger — the mechanism's own suite.
 *
 * The rules under test (the budget-line model settled 2026-11-07):
 * - **The Fund is a choice, not a share**: the pool is the chosen rate per eligible free
 *   account times the accounts, capped at a Root supporter's Time Pool; the slice is
 *   floored to the cent. Revenue is published beside it as context and never becomes
 *   the pool's basis.
 * - **The count and the rate freeze**: raw attention rows prune, so a past cycle's
 *   eligible count and the rate it was funded at are taken once and never recomputed.
 * - **The platform is not a beneficiary**: @anthers.org holds no Anthers Badge, so
 *   without an explicit exclusion it would count itself free and dilute every real
 *   account's slice.
 * - **A commitment freezes**: the next month is published once from the rate and the
 *   newest known count, and never restated while future.
 *
 * ⭐ The expected slices are computed from the shared core (`timePoolFundActual`), the
 * same call the service makes — never a copied formula.
 */
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badges, poolFundLedger, userBadges, userCycles } from "@anthers/db/schema";
import type { CycleKey } from "@anthers/shared/billing-cycle";
import { currentCycleKey, cycleEnd, cycleStart, nextCycleKey } from "@anthers/shared/billing-cycle";
import { PUBLIC_ACCESS_PRICE, timePoolByTimeFor } from "@anthers/shared/constants";
import { timePoolFundActual } from "@anthers/shared/time-pool-fund";
import { and, eq } from "drizzle-orm";
import { createAccount } from "../__tests__/account-fixture.js";
import { ensureAnthersLadder } from "../__tests__/anthers-ladder-fixture.js";
import { insertAttentionRange } from "../__tests__/attention-fixture.js";
import { purgeAccountIds, purgeAccountsCreatedHere } from "../__tests__/cleanup.js";
import app from "../index";
import {
	activeFreeAccountsForCycle,
	freeSliceForCycle,
	publishFundLedger,
} from "../services/time-pool-fund";

await ensureAnthersLadder();
purgeAccountsCreatedHere();

const tag = `tpf_${Date.now().toString(36)}`;
let n = 0;
const madeUserIds: number[] = [];
const madeCycles: string[] = [];

afterEach(async () => {
	// The ledger is a CYCLE-wide read (`services/time-pool-fund.ts` reads the cycle's
	// books and attention across every supporter), so this suite cannot leave a cycle's
	// fixtures behind without leaking them into the next test's denominators. A test
	// names its cycle, purges its users (the books cascade), and clears its rows.
	for (const cycle of madeCycles) {
		await db.delete(poolFundLedger).where(eq(poolFundLedger.billingCycle, cycle));
		await db.delete(userCycles).where(eq(userCycles.billingCycle, cycle));
	}
	madeCycles.length = 0;
	await purgeAccountIds(madeUserIds);
	madeUserIds.length = 0;
});

afterAll(async () => {
	await purgeAccountIds(madeUserIds);
});

/** A test cycle the suite owns — the last of the suite's months, far from any fixture month. */
function aCycle(): CycleKey {
	const key = nextCyclesFrom(currentCycleKey(new Date("2031-01-15T00:00:00Z")), ++n % 400);
	madeCycles.push(key, nextCycleKey(key), nextCycleKey(nextCycleKey(key)));
	return key;
}

function nextCyclesFrom(key: CycleKey, count: number): CycleKey {
	let k = key;
	for (let i = 0; i < count; i++) k = nextCycleKey(k);
	return k;
}

/** A watched PA second from a free account's fixture user (the count's signal), inside `cycle`. */
async function makeWatcher(cycle: CycleKey): Promise<number> {
	n += 1;
	const account = await createAccount(`${tag}_w${n}`);
	madeUserIds.push(account.userId);
	// Inside `cycle`, well clear of the month's edges — the range the window reads.
	await insertAttentionRange({
		userId: account.userId,
		creatorId: account.userId,
		eventType: "watch",
		seconds: 60,
		publicAccess: true,
		viaShareLink: false,
		endsAt: new Date(`${cycle.slice(0, 10).replace("-01", "-15")}T00:00:00Z`),
	});
	return account.userId;
}

/** The Anthers rung's holding for the CURRENT cycle, as a renewal has written it. */
async function holdRung(threshold: string): Promise<void> {
	n += 1;
	const account = await createAccount(`${tag}_h${n}`);
	madeUserIds.push(account.userId);
	const anthersId = await ensureAnthersLadder();
	const [rung] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, threshold)))
		.limit(1);
	if (!rung) throw new Error(`no Anthers rung at $${threshold} — the ladder fixture failed`);
	await db
		.insert(userBadges)
		.values({ userId: account.userId, badgeId: rung.id, billingCycle: currentCycleKey() });
}

/** Settle-book `cycle` for `foundation` dollars — the ledger's settled revenue basis. */
async function bookCycle(cycle: CycleKey, foundation: number): Promise<void> {
	// A dedicated books host that watches nothing: the active-count's signal is
	// Public Access attention alone, and a bookkeeping row must not enter the count.
	n += 1;
	const host = await createAccount(`${tag}_b${n}`);
	madeUserIds.push(host.userId);
	const userId = host.userId;
	await db.insert(userCycles).values({
		userId,
		billingCycle: cycle,
		foundation: foundation.toFixed(2),
	});
}

const rowFor = async (cycle: CycleKey) =>
	(
		await db.select().from(poolFundLedger).where(eq(poolFundLedger.billingCycle, cycle)).limit(1)
	)[0];

const expected = (active: number) =>
	timePoolFundActual({
		ratePerAccount: timePoolByTimeFor(PUBLIC_ACCESS_PRICE),
		activeFreeAccounts: active,
		capPerAccount: timePoolByTimeFor(PUBLIC_ACCESS_PRICE),
	});

describe("the slice the funding path reads", () => {
	it("ensures the row on first need: in flight, $0 books, a $0 pool", async () => {
		const cycle = aCycle();
		const fund = await freeSliceForCycle(cycle);
		expect(fund.slice).toBe(0);
		const row = await rowFor(cycle);
		expect(row?.status).toBe("actual");
		expect(row?.actualizedAt).toBeNull(); // in flight — the count still restates
	});

	it("funds every eligible free account at the service level — a budget line, not a revenue share", async () => {
		const cycle = aCycle();
		// Revenue is published context. Under the budget-line model it never becomes
		// the pool's basis: two eligible accounts are funded at the chosen rate each.
		await bookCycle(cycle, 20);
		await makeWatcher(cycle);
		await makeWatcher(cycle);
		expect(await activeFreeAccountsForCycle(cycle)).toBe(2);

		const fund = await freeSliceForCycle(cycle);
		expect(fund.pool.toFixed(2)).toBe(expected(2).pool.toFixed(2));
		expect(fund.slice.toFixed(2)).toBe(expected(2).slice.toFixed(2));
		expect(fund.pool.toFixed(2)).toBe("2.00");
		expect(fund.slice.toFixed(2)).toBe("1.00");
	});

	it("publishes the rate and the cap it was funded at", async () => {
		const cycle = aCycle();
		await makeWatcher(cycle);
		const fund = await freeSliceForCycle(cycle);
		expect(fund.pool.toFixed(2)).toBe("1.00");
		expect(fund.slice.toFixed(2)).toBe("1.00");
		const row = await rowFor(cycle);
		expect(row?.ratePerAccount).toBe("1.00");
		expect(row?.capPerAccount).toBe("1.00");
	});

	it("freezes the count and the rate after the cycle ends, while revenue still restates up", async () => {
		const cycle = aCycle();
		await bookCycle(cycle, 20);
		await makeWatcher(cycle);
		// The cycle long ended: the day after its end is when the count and rate freeze.
		const after = new Date(cycleEnd(cycle).getTime() + 86_400_000);
		const fund = await freeSliceForCycle(cycle, after);
		expect(fund.activeFreeAccounts).toBe(1);
		const row = await rowFor(cycle);
		expect(row?.actualizedAt).not.toBeNull();
		expect(row?.charitableRevenue).toBe("20.00");

		// The books restated upward (a late invoice settled); the revenue column follows,
		// but the count, the rate and the pool it funded must not move.
		await bookCycle(cycle, 20);
		// And a second account going active after the freeze must not appear either —
		// this is the test that catches an unfrozen count.
		await makeWatcher(cycle);
		const restated = await freeSliceForCycle(cycle, after);
		expect(restated.activeFreeAccounts).toBe(1);
		expect(restated.pool.toFixed(2)).toBe(expected(1).pool.toFixed(2));
		const still = await rowFor(cycle);
		expect(still?.actualizedAt?.getTime()).toBe(row?.actualizedAt?.getTime());
		expect(still?.ratePerAccount).toBe(row.ratePerAccount);
		expect(still?.charitableRevenue).toBe("40.00");
	});

	it("never counts the platform's own account as an eligible free account", async () => {
		const cycle = aCycle();
		const anthersId = await ensureAnthersLadder();
		// The platform watches the commons just like anybody; it must not be paid from
		// its own Fund, and it must not dilute a real free account's slice.
		await insertAttentionRange({
			userId: anthersId,
			creatorId: anthersId,
			eventType: "watch",
			seconds: 60,
			publicAccess: true,
			viaShareLink: false,
			endsAt: new Date(`${cycle.slice(0, 10).replace("-01", "-15")}T00:00:00Z`),
		});
		await makeWatcher(cycle);
		expect(await activeFreeAccountsForCycle(cycle)).toBe(1);
	});
});

describe("publication", () => {
	it("commits the next month from the recurring base and estimates one further, both frozen", async () => {
		await holdRung("6.00");
		const now = new Date("2031-02-03T00:00:00Z");
		const cycle = currentCycleKey(now);
		const committed = nextCycleKey(cycle);
		const estimate = nextCycleKey(committed);
		madeCycles.push(cycle, committed, estimate);
		// The recurring base reads the CURRENT cycle's holdings; the holding above is
		// $6 — its remainder is the commitment's revenue basis.
		await holdRungFor(cycle, "6.00");

		await publishFundLedger(now);
		const committedRow = await rowFor(committed);
		expect(committedRow?.status).toBe("committed");
		const estimateRow = await rowFor(estimate);
		expect(estimateRow?.status).toBe("estimate");

		// A re-run rewrites actuals but not a future row's commitment — frozen when published.
		await publishFundLedger(now);
		const still = await rowFor(committed);
		expect(still?.updatedAt.getTime()).toBe(committedRow?.updatedAt.getTime());
	});

	it("restates a commitment from its own holdings when its cycle arrives", async () => {
		const cycle = aCycle();
		const arrived = nextCycleKey(cycle);
		madeCycles.push(arrived);
		// Published while `cycle` is the current cycle — the commitment for `arrived`,
		// frozen — with a $0 recurring base, a $0 promise (the doctrine's floor case).
		await publishFundLedger(cycleStart(cycle));
		expect((await rowFor(arrived))?.status).toBe("committed");

		// The month arrives and one account is active: the row recomputes to actual and
		// pays the service level, not the revenue share.
		await bookCycle(arrived, 100);
		await makeWatcher(arrived);
		const fund = await freeSliceForCycle(arrived);
		expect((await rowFor(arrived))?.status).toBe("actual");
		expect(fund.pool.toFixed(2)).toBe(expected(1).pool.toFixed(2));
		expect(fund.slice.toFixed(2)).toBe("1.00");
	});
});

describe("the route that serves the ledger", () => {
	it("serves the published rows, newest first, to an unauthenticated caller", async () => {
		const cycle = aCycle();
		await bookCycle(cycle, 20);
		await publishFundLedger(cycleStart(cycle));
		const res = await app.fetch(new Request("http://localhost/api/subscriptions/time-pool-fund"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			cycles: Array<{ billingCycle: string; slicePerAccount: number; status: string }>;
		};
		expect(Array.isArray(body.cycles)).toBe(true);
		const own = body.cycles.find((r) => r.billingCycle === cycle);
		expect(own?.status).toBe("actual");
		expect(typeof own?.slicePerAccount).toBe("number");
	});
});

async function holdRungFor(cycle: CycleKey, threshold: string): Promise<void> {
	n += 1;
	const account = await createAccount(`${tag}_hh${n}`);
	madeUserIds.push(account.userId);
	const anthersId = await ensureAnthersLadder();
	const [rung] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, threshold)))
		.limit(1);
	if (!rung) throw new Error(`no Anthers rung at $${threshold} — the ladder fixture lacks it`);
	await db
		.insert(userBadges)
		.values({ userId: account.userId, badgeId: rung.id, billingCycle: cycle });
}
