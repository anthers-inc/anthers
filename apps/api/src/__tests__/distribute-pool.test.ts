// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pool distribution job — the thing that decides what a creator is actually paid.
 *
 * It had no coverage at all until 2026-08-08, which is how it drifted away from the
 * economic model without anyone noticing: it credited the GROSS directed-Seed amount
 * while `fees.ts` said creators are paid NET of the card fee, so Anthers silently
 * absorbed ~$0.39 on every Seed from a pure-direct user. These tests exist so the
 * ledger and the model can never disagree again, and they assert against
 * `supportBreakdown()` rather than against literals wherever the model defines the
 * answer — a copied literal would drift the same way the code did.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accounts,
	attentionEvents,
	poolDistributions,
	seedAllocations,
	users,
} from "@anthers/db/schema";
import { PUBLIC_ACCESS_PRICE, timePoolFor } from "@anthers/shared/constants";
import { paymentsSplit, supportBreakdown } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { distributePool } from "../jobs/distribute-pool";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

/** A cycle far enough out that it can't collide with fixture or dev data. */
const CYCLE = "2031-03-01";
const PERIOD_START = new Date("2031-03-01T00:00:00Z");
const PERIOD_END = new Date("2031-04-01T00:00:00Z");

let n = 0;
async function makeUser(tag: string): Promise<number> {
	n += 1;
	const [row] = await db
		.insert(users)
		.values({
			username: `dp_${tag}_${n}_${Date.now().toString(36)}`,
			email: `dp_${tag}_${n}_${Date.now().toString(36)}@example.com`,
			passwordHash: "x",
		})
		.returning({ id: users.id });
	return row.id;
}

/** A viewer giving Anthers `anthersSupport`, with `directed` dollars at each creator. */
async function seedCycle(
	anthersSupport: number,
	directed: { creatorId: number; amount: string }[],
) {
	const userId = await makeUser("viewer");
	const [acct] = await db
		.insert(accounts)
		.values({
			userId,
			anthersSupport: anthersSupport.toFixed(2),
			currentPeriodStart: PERIOD_START,
			currentPeriodEnd: PERIOD_END,
			isActive: true,
		})
		.returning({ id: accounts.id });
	for (const d of directed) {
		await db
			.insert(seedAllocations)
			.values({ userId, creatorId: d.creatorId, amount: d.amount, billingCycle: CYCLE });
	}
	return { userId, accountId: acct.id };
}

/** Seconds this viewer spent with this creator, inside the cycle, flagged or not. */
async function watch(
	userId: number,
	creatorId: number,
	seconds: number,
	publicAccess: boolean,
	viaShareLink = false,
): Promise<void> {
	await db.insert(attentionEvents).values({
		userId,
		creatorId,
		eventType: "watch",
		durationSeconds: seconds,
		publicAccess,
		viaShareLink,
		// Inside the cycle under test — the column defaults to now(), which is not.
		createdAt: new Date("2031-03-15T12:00:00Z"),
	});
}

/** The same, arriving through one of this account's **share links**. */
async function watchViaLink(userId: number, creatorId: number, seconds: number): Promise<void> {
	await watch(userId, creatorId, seconds, true, true);
}

async function ledger(userId: number) {
	const rows = await db
		.select()
		.from(poolDistributions)
		.where(
			and(eq(poolDistributions.subscriberId, userId), eq(poolDistributions.billingCycle, CYCLE)),
		);
	return new Map(rows.map((r) => [r.creatorId, r]));
}

async function payouts(userId: number) {
	const rows = await ledger(userId);
	return new Map([...rows].map(([id, r]) => [id, new Decimal(r.seedAmount)]));
}

async function poolPaid(userId: number) {
	const rows = await ledger(userId);
	return new Map([...rows].map(([id, r]) => [id, new Decimal(r.poolAmount)]));
}

describe("distributePool — directed Seeds are paid NET of the card fee", () => {
	beforeAll(async () => {
		await db.execute("SELECT 1");
	}, DB_SETUP_TIMEOUT);

	it("pays the model's figure exactly for the worst case: one Seed, alone", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(0, [
			{ creatorId, amount: PUBLIC_ACCESS_PRICE.toFixed(2) },
		]);

		await distributePool({ accountId });

		// $3.00 gross − $0.39 card = $2.61. Asserted against the model, not a literal.
		const expected = supportBreakdown({ anthersDollars: 0, creatorDollars: 3 }).creatorNet;
		expect(expected.toFixed(2)).toBe("2.61"); // the figure the marketing copy quotes
		expect((await payouts(userId)).get(creatorId)?.toFixed(2)).toBe(expected.toFixed(2));
	});

	it("pays MORE per Seed when the charge is batched — the fixed $0.30 amortizes", async () => {
		const soloCreator = await makeUser("creator");
		const batchedCreator = await makeUser("creator");

		const solo = await seedCycle(0, [
			{ creatorId: soloCreator, amount: PUBLIC_ACCESS_PRICE.toFixed(2) },
		]);
		// The same $3 to one creator, riding on a charge that also carries $9 to Anthers.
		const batched = await seedCycle(9, [
			{ creatorId: batchedCreator, amount: PUBLIC_ACCESS_PRICE.toFixed(2) },
		]);

		await distributePool({ accountId: solo.accountId });
		await distributePool({ accountId: batched.accountId });

		const soloPaid = (await payouts(solo.userId)).get(soloCreator)!;
		const batchedPaid = (await payouts(batched.userId)).get(batchedCreator)!;
		expect(batchedPaid.greaterThan(soloPaid)).toBe(true);
		expect(batchedPaid.toFixed(2)).toBe(
			supportBreakdown({ anthersDollars: 9, creatorDollars: 3 }).creatorNet.toFixed(2),
		);
	});

	it("conserves the pot exactly across several creators — no cent invented or lost", async () => {
		// Three creators at uneven amounts, chosen so the pro-rata split does not divide
		// evenly into cents and the drift correction has to do real work.
		const a = await makeUser("creator");
		const b = await makeUser("creator");
		const c = await makeUser("creator");
		const { userId, accountId } = await seedCycle(3, [
			{ creatorId: a, amount: "3.00" },
			{ creatorId: b, amount: "6.00" },
			{ creatorId: c, amount: "9.00" },
		]);

		await distributePool({ accountId });

		const paid = await payouts(userId);
		const total = [a, b, c].reduce((acc, id) => acc.plus(paid.get(id) ?? 0), new Decimal(0));
		const gross = new Decimal(18);
		const fee = paymentsSplit(3, 18).creator;
		expect(total.toFixed(2)).toBe(gross.minus(fee).toFixed(2));
		// And nobody was paid more than was directed at them.
		expect(paid.get(a)!.lessThan(3)).toBe(true);
		expect(paid.get(c)!.lessThan(9)).toBe(true);
	});

	it("never pays a creator more than the gross directed at them", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(0, [{ creatorId, amount: "3.00" }]);
		await distributePool({ accountId });
		expect((await payouts(userId)).get(creatorId)!.lessThan(3)).toBe(true);
	});

	it("leaves the gift record on seed_allocations untouched — that is gross, by design", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(0, [{ creatorId, amount: "3.00" }]);
		await distributePool({ accountId });

		const [alloc] = await db
			.select()
			.from(seedAllocations)
			.where(and(eq(seedAllocations.userId, userId), eq(seedAllocations.billingCycle, CYCLE)));
		// What the user chose to give is a different fact from what the creator was paid.
		expect(new Decimal(alloc.amount).toFixed(2)).toBe("3.00");
		expect((await payouts(userId)).get(creatorId)!.toFixed(2)).toBe("2.61");
	});

	it("is idempotent — re-running does not deduct the fee twice", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(0, [{ creatorId, amount: "3.00" }]);

		await distributePool({ accountId });
		const first = (await payouts(userId)).get(creatorId)!.toFixed(2);
		await distributePool({ accountId });
		const second = (await payouts(userId)).get(creatorId)!.toFixed(2);

		// The job upserts, and it recomputes from seed_allocations rather than from the
		// row it wrote last time — so a second run must land on the same number.
		expect(second).toBe(first);
		expect(second).toBe("2.61");
	});
});

/**
 * The Time Pool buys the commons and nothing else.
 *
 * Distributor-pays: gated or sold work is paid in full by whoever cleared the gate or
 * bought it, and only ungated streaming — Public Access — draws the pool. Until
 * 2026-08-26 this job summed every attention row, so a creator the viewer had already
 * paid was paid a second time and every Public Access creator on that cycle was diluted
 * by exactly that much.
 *
 * ⚠️ **Assert on where the money went, never only on whether it summed.** The bug
 * conserved the pot perfectly — the pool was distributed in full, to the wrong people —
 * so a totals check passes against both versions of the job. Every test here that can
 * fail names a creator and a figure. The conservation case is kept for the property it
 * does cover (excluding rows must not strand cents) and is labeled as not being the
 * guard.
 */
describe("distributePool — the Time Pool pays for Public Access only", () => {
	beforeAll(async () => {
		await db.execute("SELECT 1");
	}, DB_SETUP_TIMEOUT);

	it("pays nothing from the pool for a creator the viewer already paid to reach", async () => {
		const commons = await makeUser("creator");
		const alreadyPaid = await makeUser("creator");
		const { userId, accountId } = await seedCycle(PUBLIC_ACCESS_PRICE, []);

		// An hour with each. One Work was ungated streaming; the other was gated or
		// bought, so its seconds were stamped `public_access = false` when they happened.
		await watch(userId, commons, 3600, true);
		await watch(userId, alreadyPaid, 3600, false);

		await distributePool({ accountId });

		const pool = await poolPaid(userId);
		const wholePool = new Decimal(timePoolFor(PUBLIC_ACCESS_PRICE));
		expect(pool.get(commons)?.toFixed(2)).toBe(wholePool.toFixed(2));
		// Not a smaller share — no ledger row at all, because nothing was owed.
		expect(pool.has(alreadyPaid)).toBe(false);
	});

	it("does not let paid-for seconds move the split between Public Access creators", async () => {
		const a = await makeUser("creator");
		const b = await makeUser("creator");
		const gated = await makeUser("creator");
		const { userId, accountId } = await seedCycle(6, []);

		await watch(userId, a, 3000, true);
		await watch(userId, b, 1000, true);
		// More time than both of them together, and it must not change either figure.
		await watch(userId, gated, 8000, false);

		await distributePool({ accountId });

		const pool = await poolPaid(userId);
		const wholePool = new Decimal(timePoolFor(6));
		expect(pool.get(a)?.toFixed(2)).toBe(wholePool.mul("0.75").toFixed(2));
		expect(pool.get(b)?.toFixed(2)).toBe(wholePool.mul("0.25").toFixed(2));
		expect(pool.has(gated)).toBe(false);
	});

	it("records the seconds that earned the money, so the ledger row can be audited", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(PUBLIC_ACCESS_PRICE, []);

		await watch(userId, creatorId, 600, true);
		await watch(userId, creatorId, 5400, false); // same creator, gated Work

		await distributePool({ accountId });

		// `attention_seconds` is the numerator of the split, so it holds the 600 that
		// earned the pool and not the 6000 the viewer spent with this creator overall.
		expect((await ledger(userId)).get(creatorId)?.attentionSeconds).toBe(600);
	});

	it("still pays directed support to a creator whose only time was gated", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(0, [{ creatorId, amount: "3.00" }]);

		await watch(userId, creatorId, 3600, false);

		await distributePool({ accountId });

		const row = (await ledger(userId)).get(creatorId);
		// Directed support is the other half of distributor-pays and is untouched by this:
		// the viewer paid this creator on purpose, and gets no pool draw on top of it.
		expect(new Decimal(row?.seedAmount ?? 0).toFixed(2)).toBe("2.61");
		expect(new Decimal(row?.poolAmount ?? 0).toFixed(2)).toBe("0.00");
		expect(row?.attentionSeconds).toBe(0);
	});

	it("holds the whole pool undistributed when the viewer watched no Public Access", async () => {
		const gated = await makeUser("creator");
		const { userId, accountId } = await seedCycle(9, []);

		await watch(userId, gated, 7200, false);

		await distributePool({ accountId });

		// Nobody is paid, rather than the gated creator being paid twice. What happens to
		// a Time Pool with nowhere to go is a model question this job does not answer —
		// `account_cycles.time_pool` still records the budget either way.
		expect((await poolPaid(userId)).size).toBe(0);
	});

	it("strands no cents when excluded seconds shrink the population", async () => {
		// ⚠️ NOT the guard against the double-pay bug — the bug conserved the pot too.
		// This covers the neighboring failure: dropping rows from the aggregate must not
		// leave the drift correction with a target it can no longer reach.
		const a = await makeUser("creator");
		const b = await makeUser("creator");
		const gated = await makeUser("creator");
		const { userId, accountId } = await seedCycle(9, []);

		// Uneven enough that the pro-rata split does not divide evenly into cents.
		await watch(userId, a, 1111, true);
		await watch(userId, b, 2222, true);
		await watch(userId, gated, 9999, false);

		await distributePool({ accountId });

		const total = [...(await poolPaid(userId)).values()].reduce(
			(s, v) => s.plus(v),
			new Decimal(0),
		);
		expect(total.toFixed(2)).toBe(new Decimal(timePoolFor(9)).toFixed(2));
	});
});

describe("distributePool — the share-link slice is a ceiling, not a reservation", () => {
	beforeAll(async () => {
		await db.execute("SELECT 1");
	}, DB_SETUP_TIMEOUT);

	it("🚨 pays a non-sharer's creators the WHOLE pool, exactly as before", async () => {
		// The regression this rule invites, and the one that would hit almost everybody.
		// Reserving the slice unconditionally would quietly cut every account that never
		// shared anything by a tenth, to fund a feature they never used — and it would look
		// like a rounding change rather than a policy one.
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(PUBLIC_ACCESS_PRICE, []);
		await watch(userId, creatorId, 3600, true);

		await distributePool({ accountId });

		const paid = (await poolPaid(userId)).get(creatorId);
		expect(paid?.toFixed(2)).toBe(new Decimal(timePoolFor(PUBLIC_ACCESS_PRICE)).toFixed(2));
	});

	it("🚨 caps what strangers command at the fraction, however much they watched", async () => {
		/*
		 * The property the whole design turns on: **sharing never costs the sharer anything.**
		 * Here the link is watched for nine times as long as the sharer watched anything
		 * themselves, and the creator they actually chose is still paid 90% — the viral link
		 * cannot dilute their own choices, it can only fill its own slice.
		 */
		const chosen = await makeUser("creator");
		const viaLink = await makeUser("creator");
		const { userId, accountId } = await seedCycle(PUBLIC_ACCESS_PRICE, []);
		await watch(userId, chosen, 600, true);
		await watchViaLink(userId, viaLink, 5400);

		await distributePool({ accountId });

		const pool = await poolPaid(userId);
		const whole = new Decimal(timePoolFor(PUBLIC_ACCESS_PRICE));
		expect(pool.get(chosen)?.toFixed(2)).toBe(whole.mul("0.9").toFixed(2));
		expect(pool.get(viaLink)?.toFixed(2)).toBe(whole.mul("0.1").toFixed(2));
	});

	it("splits the shared slice among the creators the links actually reached", async () => {
		const a = await makeUser("creator");
		const b = await makeUser("creator");
		const own = await makeUser("creator");
		const { userId, accountId } = await seedCycle(PUBLIC_ACCESS_PRICE, []);
		await watch(userId, own, 1000, true);
		await watchViaLink(userId, a, 750);
		await watchViaLink(userId, b, 250);

		await distributePool({ accountId });

		const pool = await poolPaid(userId);
		const whole = new Decimal(timePoolFor(PUBLIC_ACCESS_PRICE));
		expect(pool.get(own)?.toFixed(2)).toBe(whole.mul("0.9").toFixed(2));
		expect(pool.get(a)?.toFixed(2)).toBe(whole.mul("0.1").mul("0.75").toFixed(2));
		expect(pool.get(b)?.toFixed(2)).toBe(whole.mul("0.1").mul("0.25").toFixed(2));
	});

	it("⚠️ leaves the other 90% undistributed when the sharer watched nothing themselves", async () => {
		// Deliberately NOT symmetric with the first case. A ceiling that lifted whenever the
		// sharer happened to watch nothing would be no ceiling at all — somebody could post one
		// link publicly, never open the site, and hand strangers command of their whole pool.
		// The remainder is the subject of its own open question, which a viewer with no
		// attention at all already raises.
		const viaLink = await makeUser("creator");
		const { userId, accountId } = await seedCycle(PUBLIC_ACCESS_PRICE, []);
		await watchViaLink(userId, viaLink, 3600);

		await distributePool({ accountId });

		const whole = new Decimal(timePoolFor(PUBLIC_ACCESS_PRICE));
		expect((await poolPaid(userId)).get(viaLink)?.toFixed(2)).toBe(whole.mul("0.1").toFixed(2));
	});
});
