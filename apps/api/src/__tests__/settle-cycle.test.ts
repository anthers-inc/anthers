// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cycle settlement — and specifically the Time Pool that reaches nobody.
 *
 * 🚨 **A viewer's pool is a fixed half of what they give Anthers, and since the Public Access
 * fix it only pays creators whose work they streamed ungated.** So a viewer with no Public
 * Access seconds funds a pool that reaches no one, and until 2026-08-29 that money landed
 * nowhere at all — the budget was recorded, the remainder was computed net of it, and no
 * `pool_distributions` row was written, so the amount was booked to neither a creator nor the
 * mission. Parker settled it on 2026-08-26: **it falls to the remainder.**
 *
 * ⚠️ **The failure this suite guards against is the opposite one — booking it twice.** The two
 * jobs run on different clocks, `distribute-pool` daily and `settle-cycle` monthly, so taking
 * the difference while the pool job can still pay some of it out would land the same dollars in
 * a creator's ledger and in the remainder. That is what `cycleStillOpen` exists for and it has
 * its own test below.
 *
 * ⭐ Figures are asserted against `anthersSupportBreakdown` and `timePoolFor` rather than
 * against literals wherever the model defines the answer — a copied number drifts exactly the
 * way the code it was copied from does.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accountCycles,
	accounts,
	attentionEvents,
	crfLedger,
	poolDistributions,
	stickers,
	users,
} from "@anthers/db/schema";
import { supportAmount, timePoolFor } from "@anthers/shared/constants";
import { anthersSupportBreakdown, paymentsSplit } from "@anthers/shared/fees";
import { SHARE_LINK_POOL_FRACTION } from "@anthers/shared/public-access";
import Decimal from "decimal.js";
import { and, eq, like } from "drizzle-orm";
import { distributePool } from "../jobs/distribute-pool";
import { settleCycle } from "../jobs/settle-cycle";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

/** A cycle far enough out that it cannot collide with fixture or dev data. */
const CYCLE = "2031-05-01";
const PERIOD_START = new Date("2031-05-01T00:00:00Z");
const PERIOD_END = new Date("2031-06-01T00:00:00Z");
const WATCHED_AT = new Date("2031-05-15T12:00:00Z");
/** Where the account's period lands once the cycle under test has ended. */
const NEXT_PERIOD_START = new Date("2031-06-01T00:00:00Z");
const NEXT_PERIOD_END = new Date("2031-07-01T00:00:00Z");

/** Everything this suite created, so teardown does not depend on guessing. */
const madeUserIds: number[] = [];
const tag = `sc_${Date.now().toString(36)}`;

let n = 0;
async function makeUser(kind: string): Promise<number> {
	n += 1;
	const [row] = await db
		.insert(users)
		.values({
			username: `${tag}_${kind}_${n}`,
			email: `${tag}_${kind}_${n}@example.com`,
			passwordHash: "x",
		})
		.returning({ id: users.id });
	madeUserIds.push(row.id);
	return row.id;
}

/** A viewer giving Anthers `anthersSupport` a month, with their period on the cycle. */
async function makeViewer(anthersSupport: number, periodStart: Date = PERIOD_START) {
	const userId = await makeUser("viewer");
	const [acct] = await db
		.insert(accounts)
		.values({
			userId,
			anthersSupport: anthersSupport.toFixed(2),
			currentPeriodStart: periodStart,
			currentPeriodEnd: PERIOD_END,
			isActive: true,
		})
		.returning({ id: accounts.id });
	return { userId, accountId: acct.id };
}

/**
 * Move the account's period past the cycle under test, as a month's end would.
 *
 * 🚨 **This is the real sequence, not a convenience.** `distribute-pool` keys its rows by the
 * account's *current* period, so it can only distribute while the period is the cycle — and
 * `settle-cycle` refuses to book a shortfall until the period has moved on, because until then
 * the pool job could still pay some of it out. A test that settled without this would be
 * testing the open-cycle guard by accident and asserting nothing about the shortfall.
 */
async function endPeriod(accountId: number) {
	await db
		.update(accounts)
		.set({ currentPeriodStart: NEXT_PERIOD_START, currentPeriodEnd: NEXT_PERIOD_END })
		.where(eq(accounts.id, accountId));
}

/** Seconds this viewer spent with a creator inside the cycle. */
async function watch(
	userId: number,
	creatorId: number,
	seconds: number,
	opts: { publicAccess?: boolean; viaShareLink?: boolean } = {},
) {
	await db.insert(attentionEvents).values({
		userId,
		creatorId,
		eventType: "watch",
		durationSeconds: seconds,
		publicAccess: opts.publicAccess ?? true,
		viaShareLink: opts.viaShareLink ?? false,
		// The column defaults to now(), which is not inside the cycle under test.
		createdAt: WATCHED_AT,
	});
}

/** The settlement ledger row for this account and cycle, or null. */
async function inflowFor(userId: number): Promise<Decimal | null> {
	const [row] = await db
		.select({ amount: crfLedger.amount })
		.from(crfLedger)
		.where(like(crfLedger.description, `[settle u${userId} ${CYCLE}]%`))
		.limit(1);
	return row ? new Decimal(row.amount) : null;
}

/** The cycle snapshot for this account. */
async function snapshotFor(userId: number) {
	const [row] = await db
		.select()
		.from(accountCycles)
		.where(and(eq(accountCycles.userId, userId), eq(accountCycles.billingCycle, CYCLE)))
		.limit(1);
	return row ?? null;
}

/** What the model says this account's own remainder is, before any undistributed pool. */
function remainderFor(anthersSupport: number): Decimal {
	const n = supportAmount(anthersSupport.toFixed(2));
	const split = paymentsSplit(n, 0);
	return Decimal.max(
		0,
		anthersSupportBreakdown(n, { payments: split.anthers }).foundation,
	).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

describe("settleCycle — an undistributed Time Pool falls to the remainder", () => {
	beforeAll(async () => {
		await db.execute("SELECT 1");
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// 🚨 The ledger rows do NOT cascade — `crf_ledger` references purchases, never users,
		// so deleting the fixture accounts would leave every settlement row behind looking
		// like real charitable income. Take them first, by the marker they carry.
		for (const userId of madeUserIds) {
			await db.delete(crfLedger).where(like(crfLedger.description, `[settle u${userId} %`));
		}
		for (const userId of madeUserIds) {
			await db.delete(users).where(eq(users.id, userId));
		}
	});

	it("🚨 books the WHOLE pool to the remainder when the viewer streamed no Public Access", async () => {
		// The headline case. Six dollars to Anthers funds a $3.00 pool; nothing was watched
		// ungated, so it reaches nobody and every cent of it is the mission's.
		const { userId, accountId } = await makeViewer(6);

		await distributePool({ accountId });
		await endPeriod(accountId);
		await settleCycle({ accountId, cycle: CYCLE });

		const pool = new Decimal(timePoolFor(6));
		const snap = await snapshotFor(userId);
		expect(snap?.timePool).toBe(pool.toFixed(2));
		expect(snap?.timePoolUndistributed).toBe(pool.toFixed(2));

		// The budget is still the budget — it records the promise, and the shortfall sits
		// beside it rather than overwriting it.
		expect(new Decimal(snap!.foundation).toFixed(2)).toBe(remainderFor(6).plus(pool).toFixed(2));
		expect((await inflowFor(userId))?.toFixed(2)).toBe(remainderFor(6).plus(pool).toFixed(2));
	});

	it("books nothing extra when the pool reached creators", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await makeViewer(6);
		await watch(userId, creatorId, 1800);

		await distributePool({ accountId });
		await endPeriod(accountId);
		await settleCycle({ accountId, cycle: CYCLE });

		const snap = await snapshotFor(userId);
		expect(snap?.timePoolUndistributed).toBe("0.00");
		expect(new Decimal(snap!.foundation).toFixed(2)).toBe(remainderFor(6).toFixed(2));
	});

	it("🚨 books a directed Sticker as PAID, never as an undistributed pool", async () => {
		// The failure this guards is silent and points the wrong way: a Sticker is an override
		// of the Time Pool, so `distribute-pool` deliberately leaves the directed part out of
		// `pool_amount`. Measuring the shortfall against `pool_amount` alone would read that
		// gap as money that reached nobody and hand it to Anthers' own remainder — money a
		// user aimed at a named creator, quietly redirected, with every total still adding up.
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await makeViewer(12);
		await watch(userId, creatorId, 1800);
		await db.insert(stickers).values({
			giverId: userId,
			creatorId,
			subjectType: "work",
			subjectId: 1,
			billingCycle: CYCLE,
			amount: "1.00",
		});

		await distributePool({ accountId });
		await endPeriod(accountId);
		await settleCycle({ accountId, cycle: CYCLE });

		const snap = await snapshotFor(userId);
		// The pool reached creators in full — part by time, part by hand.
		expect(snap?.timePoolUndistributed).toBe("0.00");
		expect(new Decimal(snap!.foundation).toFixed(2)).toBe(remainderFor(12).toFixed(2));
	});

	it("🚨 books only the part a share-link ceiling left behind", async () => {
		// The case the older framing misses. This viewer logged plenty of attention — through
		// their own share link — so "truly zero attention time" does not describe them, and
		// `distribute-pool` still leaves most of their pool unspent: the share-link slice is a
		// ceiling rather than a reservation, so a sharer who watched nothing themselves
		// distributes that slice and no more.
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await makeViewer(12);
		await watch(userId, creatorId, 3600, { viaShareLink: true });

		await distributePool({ accountId });
		await endPeriod(accountId);
		await settleCycle({ accountId, cycle: CYCLE });

		const pool = new Decimal(timePoolFor(12));
		const sharedSlice = pool
			.mul(SHARE_LINK_POOL_FRACTION)
			.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
		const snap = await snapshotFor(userId);
		expect(snap?.timePoolUndistributed).toBe(pool.minus(sharedSlice).toFixed(2));
		expect(new Decimal(snap!.foundation).toFixed(2)).toBe(
			remainderFor(12).plus(pool.minus(sharedSlice)).toFixed(2),
		);
	});

	it("🚨 books nothing while distribute-pool can still write to the cycle", async () => {
		// The double-booking guard. This account's own billing period still maps onto the
		// cycle being settled, so the pool job has not finished with it — taking the shortfall
		// now would put the same dollars in the remainder and, tomorrow, in a creator's
		// ledger. The remainder is left exactly as it was before any of this existed.
		const { userId, accountId } = await makeViewer(6);
		// Deliberately no `endPeriod` — the period still maps onto the cycle being settled.
		await settleCycle({ accountId, cycle: CYCLE });

		const snap = await snapshotFor(userId);
		expect(snap?.timePoolUndistributed).toBe("0.00");
		expect(new Decimal(snap!.foundation).toFixed(2)).toBe(remainderFor(6).toFixed(2));
	});

	it("settles once — a second run adds no second inflow", async () => {
		const { userId, accountId } = await makeViewer(6);
		await endPeriod(accountId);

		await settleCycle({ accountId, cycle: CYCLE });
		await settleCycle({ accountId, cycle: CYCLE });

		const rows = await db
			.select({ id: crfLedger.id })
			.from(crfLedger)
			.where(like(crfLedger.description, `[settle u${userId} ${CYCLE}]%`));
		expect(rows.length).toBe(1);
	});

	it("leaves the creators' own ledger untouched", async () => {
		// Settlement books to the mission, never to a creator. If it ever wrote a
		// `pool_distributions` row the shortfall would be paid twice — once as a distribution
		// and once as remainder — so the absence is the assertion.
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await makeViewer(6);
		await watch(userId, creatorId, 600);

		await distributePool({ accountId });
		const before = await db
			.select()
			.from(poolDistributions)
			.where(
				and(eq(poolDistributions.subscriberId, userId), eq(poolDistributions.billingCycle, CYCLE)),
			);
		await settleCycle({ accountId, cycle: CYCLE });
		const after = await db
			.select()
			.from(poolDistributions)
			.where(
				and(eq(poolDistributions.subscriberId, userId), eq(poolDistributions.billingCycle, CYCLE)),
			);

		expect(after.length).toBe(before.length);
		expect(after.map((r) => r.poolAmount)).toEqual(before.map((r) => r.poolAmount));
	});
});
