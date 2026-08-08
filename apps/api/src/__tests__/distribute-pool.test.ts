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
import { accounts, poolDistributions, seedAllocations, users } from "@anthers/db/schema";
import { SEED_PRICE } from "@anthers/shared/constants";
import { paymentsSplit, supportBreakdown } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { distributePool } from "../jobs/distribute-pool";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

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

/** A viewer holding `anthersSeeds`, with `directed` dollars pointed at each creator. */
async function seedCycle(anthersSeeds: number, directed: { creatorId: number; amount: string }[]) {
	const userId = await makeUser("viewer");
	const [acct] = await db
		.insert(accounts)
		.values({
			userId,
			anthersSeeds,
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

async function payouts(userId: number) {
	const rows = await db
		.select()
		.from(poolDistributions)
		.where(
			and(eq(poolDistributions.subscriberId, userId), eq(poolDistributions.billingCycle, CYCLE)),
		);
	return new Map(rows.map((r) => [r.creatorId, new Decimal(r.seedAmount)]));
}

describe("distributePool — directed Seeds are paid NET of the card fee", () => {
	beforeAll(async () => {
		await db.execute("SELECT 1");
	}, DB_SETUP_TIMEOUT);

	it("pays the model's figure exactly for the worst case: one Seed, alone", async () => {
		const creatorId = await makeUser("creator");
		const { userId, accountId } = await seedCycle(0, [
			{ creatorId, amount: SEED_PRICE.toFixed(2) },
		]);

		await distributePool({ accountId });

		// $3.00 gross − $0.39 card = $2.61. Asserted against the model, not a literal.
		const expected = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 }).creatorNet;
		expect(expected.toFixed(2)).toBe("2.61"); // the figure the marketing copy quotes
		expect((await payouts(userId)).get(creatorId)?.toFixed(2)).toBe(expected.toFixed(2));
	});

	it("pays MORE per Seed when the charge is batched — the fixed $0.30 amortises", async () => {
		const soloCreator = await makeUser("creator");
		const batchedCreator = await makeUser("creator");

		const solo = await seedCycle(0, [{ creatorId: soloCreator, amount: SEED_PRICE.toFixed(2) }]);
		// Same single directed Seed, but riding on a charge that also carries 3 to Anthers.
		const batched = await seedCycle(3, [
			{ creatorId: batchedCreator, amount: SEED_PRICE.toFixed(2) },
		]);

		await distributePool({ accountId: solo.accountId });
		await distributePool({ accountId: batched.accountId });

		const soloPaid = (await payouts(solo.userId)).get(soloCreator)!;
		const batchedPaid = (await payouts(batched.userId)).get(batchedCreator)!;
		expect(batchedPaid.greaterThan(soloPaid)).toBe(true);
		expect(batchedPaid.toFixed(2)).toBe(
			supportBreakdown({ anthersSeeds: 3, creatorSeeds: 1 }).creatorNet.toFixed(2),
		);
	});

	it("conserves the pot exactly across several creators — no cent invented or lost", async () => {
		// Three creators at uneven amounts, chosen so the pro-rata split does not divide
		// evenly into cents and the drift correction has to do real work.
		const a = await makeUser("creator");
		const b = await makeUser("creator");
		const c = await makeUser("creator");
		const { userId, accountId } = await seedCycle(1, [
			{ creatorId: a, amount: "3.00" },
			{ creatorId: b, amount: "6.00" },
			{ creatorId: c, amount: "9.00" },
		]);

		await distributePool({ accountId });

		const paid = await payouts(userId);
		const total = [a, b, c].reduce((acc, id) => acc.plus(paid.get(id) ?? 0), new Decimal(0));
		const gross = new Decimal(18);
		const fee = paymentsSplit(1, 6).creator;
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
