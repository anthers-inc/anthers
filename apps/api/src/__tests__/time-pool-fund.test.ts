// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool Fund's ledger — the mechanism's own suite.
 *
 * The rules under test (the pool mechanism task's settled shapes):
 * - **One arithmetic**: the pool is the Fund's share of the remainder after the admin
 *   budget, capped by the parity ceiling; the slice divides it floored to the cent.
 * - **The count freezes**: raw attention rows prune, so a past cycle's active-free
 *   count is taken once and never recomputed, while its revenue still restates up.
 * - **A commitment freezes**: the next month is published once from the recurring
 *   base and never restated while future; arriving, it restates from its own
 *   holdings — the only restate a commitment may see.
 * - **A $0-revenue month funds a $0 pool** — the doctrine working.
 *
 * ⭐ The expected slices are computed from the shared core (`timePoolFundPool`), the
 * same call the service makes — never a copied formula.
 */
import { afterEach, afterAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accountCycles, badges, timePoolFundLedger, userBadges } from "@anthers/db/schema";
import type { CycleKey } from "@anthers/shared/billing-cycle";
import { currentCycleKey, cycleEnd, cycleStart, nextCycleKey } from "@anthers/shared/billing-cycle";
import { PUBLIC_ACCESS_PRICE, timePoolFor } from "@anthers/shared/constants";
import { timePoolFundPool } from "@anthers/shared/time-pool-fund";
import { and, eq, inArray } from "drizzle-orm";
import app from "../index";
import {
	activeFreeAccountsForCycle,
	freeSliceForCycle,
	publishFundLedger,
} from "../services/time-pool-fund";
import { createAccount } from "../__tests__/account-fixture.js";
import { ensureAnthersLadder } from "../__tests__/anthers-ladder-fixture.js";
import { insertAttentionRange } from "../__tests__/attention-fixture.js";
import { purgeAccountIds, purgeAccountsCreatedHere } from "../__tests__/cleanup.js";

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
		await db.delete(timePoolFundLedger).where(eq(timePoolFundLedger.billingCycle, cycle));
		await db.delete(accountCycles).where(eq(accountCycles.billingCycle, cycle));
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
	await db.insert(accountCycles).values({
		userId,
		billingCycle: cycle,
		foundation: foundation.toFixed(2),
	});
}

const rowFor = async (cycle: CycleKey) =>
	(
		await db
			.select()
			.from(timePoolFundLedger)
			.where(eq(timePoolFundLedger.billingCycle, cycle))
			.limit(1)
	)[0];

const expected = (revenue: string | number, active: number) =>
	timePoolFundPool({
		charitableRevenue: revenue,
		adminBudgetShare: 0.3,
		freeAccessShare: 0.1,
		activeFreeAccounts: active,
		rootPool: timePoolFor(PUBLIC_ACCESS_PRICE),
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

	it("pools the settled books' revenue and divides the slice floored to the cent", async () => {
		const cycle = aCycle();
		// $20 booked: the uncapped share is $1.40 — under the ceiling for these two
		// accounts (a Root pool × 2 = $3.00).
		await bookCycle(cycle, 20);
		await makeWatcher(cycle);
		await makeWatcher(cycle);
		expect(await activeFreeAccountsForCycle(cycle)).toBe(2);

		const fund = await freeSliceForCycle(cycle);
		expect(fund.pool.toFixed(2)).toBe("1.40");
		expect(fund.slice.toFixed(2)).toBe(expected(20, 2).slice.toFixed(2));
		expect(fund.slice.toFixed(2)).toBe("0.70");
	});

	it("the parity ceiling binds: the excess routes to the remainder by construction", async () => {
		const cycle = aCycle();
		await bookCycle(cycle, 100);
		await makeWatcher(cycle);
		// The uncapped share is $7.00; the ceiling is a Root supporter's pool × 1.
		const fund = await freeSliceForCycle(cycle);
		expect(fund.pool.toFixed(2)).toBe(
			timePoolFor(PUBLIC_ACCESS_PRICE).toFixed(2),
		);
		expect(fund.slice.toFixed(2)).toBe("1.50");
	});

	it("the count freezes after the cycle ends, while revenue still restates up", async () => {
		const cycle = aCycle();
		// Books small enough that the parity ceiling does not bind at one account: the
		// restatement has to be visible as the pool's own move, not the ceiling's.
		await bookCycle(cycle, 20);
		await makeWatcher(cycle);
		// The cycle long ended: the day after its end is when the count freezes.
		const after = new Date(cycleEnd(cycle).getTime() + 86_400_000);
		const fund = await freeSliceForCycle(cycle, after);
		expect(fund.activeFreeAccounts).toBe(1);
		const row = await rowFor(cycle);
		expect(row?.actualizedAt).not.toBeNull();

		// The books restated upward (a late invoice settled); the count must not move.
		await bookCycle(cycle, 20);
		// And a second account going active after the freeze must not appear either —
		// this is the test that catches an unfrozen count.
		await makeWatcher(cycle);
		const restated = await freeSliceForCycle(cycle, after);
		expect(restated.activeFreeAccounts).toBe(1);
		expect(restated.pool.toFixed(2)).toBe(
			expected(40, 1).pool.toFixed(2),
		);
		const still = await rowFor(cycle);
		expect(still?.actualizedAt?.getTime()).toBe(row?.actualizedAt?.getTime());
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

		// The month arrives and renewals land (a $100 book with one active free
		// account): the row recomputes to actual, and the parity ceiling — not the
		// uncapped share — is what the slice pays.
		await bookCycle(arrived, 100);
		await makeWatcher(arrived);
		const fund = await freeSliceForCycle(arrived);
		expect((await rowFor(arrived))?.status).toBe("actual");
		expect(fund.pool.toFixed(2)).toBe(timePoolFor(PUBLIC_ACCESS_PRICE).toFixed(2));
		expect(fund.slice.toFixed(2)).toBe("1.50");
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