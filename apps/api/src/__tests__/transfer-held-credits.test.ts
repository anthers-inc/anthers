// SPDX-License-Identifier: Apache-2.0
/**
 * The transfer step — a creator's settled money, moved once, after its own hold.
 *
 * 🚨 **The defect this suite exists for is money moving twice or moving early.** The
 * crash window between the Stripe call and the DB write is the one place a payments bug
 * can cost real money with no test able to see it, and the 14-day hold counted from each
 * credit's own `settledAt` (never a month's settlement date) is the one place a
 * well-intentioned shortcut creates a policy violation that reads as a simplification.
 *
 * ⭐ The hold cases are asserted against `HOLD_DAYS` itself, and the idempotency cases
 * against the fake's recorded call count — a test that asserts "one transfer" by reading
 * our own rows would pass while Stripe received two calls, which is the exact failure
 * the idempotency key exists to prevent.
 *
 * ⚠️ Each run is scoped per creator, because a full run finds every creator in the
 * database and this suite shares its database with every other suite in the run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	creatorCredits,
	creatorTransferCredits,
	creatorTransfers,
	stripeAccounts,
	users,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { HOLD_DAYS, transferHeldCredits } from "../jobs/transfer-held-credits";
import { getStripe, setStripeClient } from "../lib/stripe";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

/** Far enough out that it cannot collide with fixture or dev data. */
const SETTLED_AT = new Date("2031-05-15T02:00:00Z");
/** One day short of the hold. */
const AT_13_DAYS = new Date(SETTLED_AT.getTime() + (HOLD_DAYS - 1) * 24 * 60 * 60 * 1000);
/** The hold passed. */
const AT_15_DAYS = new Date(SETTLED_AT.getTime() + (HOLD_DAYS + 1) * 24 * 60 * 60 * 1000);

const DAY_MS = 24 * 60 * 60 * 1000;

const tag = `tc_${Date.now().toString(36)}`;
const madeUserIds: number[] = [];
const madeTransferIds: number[] = [];
let n = 0;

afterAll(async () => {
	// The transfer rows outlive the account by design (set-null creator), so deleting the
	// fixture users first would orphan them — exactly the leak shape cleanup.ts exists to
	// stop. The coverage rows go before the transfer rows they point at, and the transfers
	// before the accounts, in dependency order.
	if (madeTransferIds.length > 0) {
		await db
			.delete(creatorTransferCredits)
			.where(inArray(creatorTransferCredits.transferId, madeTransferIds));
		await db.delete(creatorTransfers).where(inArray(creatorTransfers.id, madeTransferIds));
	}
	// The credits are taken by the account purge (both their creator and subscriber are
	// fixture accounts), which is why the transfers are cleaned above rather than relying
	// on the same cascade: the credits' coverage rows are gone by now, and a second run
	// must not find them.
});

/** A creator fixture with payouts enabled, holding the ids for teardown. */
async function makeCreator(): Promise<number> {
	n += 1;
	const account = await createAccount(`${tag}_creator_${n}`);
	madeUserIds.push(account.userId);
	await enablePayoutsFor(account.userId);
	return account.userId;
}

/** A bare account — a creator whose payouts have not been set up. */
async function makeBareUser(): Promise<number> {
	n += 1;
	const account = await createAccount(`${tag}_bare_${n}`);
	madeUserIds.push(account.userId);
	return account.userId;
}

/** A settled credit, as `settleCycle` would have written it. */
async function credit(creatorId: number, amount: string, settledAt: Date = SETTLED_AT) {
	const [row] = await db
		.insert(creatorCredits)
		.values({
			creatorId,
			subscriberId: creatorId, // the transfer step never reads the subscriber side
			billingCycle: "2031-05-01",
			kind: "time_pool",
			fundedBy: "supporter",
			amount,
			settledAt,
		})
		.returning({ id: creatorCredits.id });
	return row.id;
}

/** The transfer rows written for one creator. */
async function transfersFor(creatorId: number) {
	const rows = await db
		.select()
		.from(creatorTransfers)
		.where(eq(creatorTransfers.creatorId, creatorId));
	for (const row of rows) madeTransferIds.push(row.id);
	return rows;
}

/** The credit ids a creator's coverage rows name. */
async function coveredCreditsFor(creatorId: number): Promise<number[]> {
	const rows = await db
		.select({
			transferId: creatorTransferCredits.transferId,
			creditId: creatorTransferCredits.creditId,
		})
		.from(creatorTransferCredits)
		.innerJoin(creatorTransfers, eq(creatorTransferCredits.transferId, creatorTransfers.id))
		.where(eq(creatorTransfers.creatorId, creatorId));
	for (const row of rows) madeTransferIds.push(row.transferId);
	return rows.map((r) => r.creditId);
}

// ── The fake Stripe client ───────────────────────────────────────────────────

interface Call {
	method: string;
	args: unknown[];
}

/**
 * A recording stand-in for the SDK's transfers surface, shaped like the one in
 * `payments-stripe.test.ts`. Every call is recorded so a test can assert on what we
 * sent Stripe, and the fake honors the idempotency key the way real Stripe does: a
 * replayed key returns the original transfer and creates no second one. What a test
 * asserts on for the crash window is the number of DISTINCT transfers created —
 * "Stripe was asked twice" is the expected shape of a retry and is harmless; "Stripe
 * made two transfers" is the double-spend the key exists to prevent.
 */
function fakeStripe() {
	const calls: Call[] = [];
	const byKey = new Map<string, Stripe.Transfer>();
	const client = {
		transfers: {
			create: (...args: unknown[]) => {
				calls.push({ method: "transfers.create", args });
				const [params, options] = args as [Stripe.TransferCreateParams, Stripe.RequestOptions?];
				const key = options?.idempotencyKey ?? `nokey_${calls.length}`;
				if (byKey.has(key)) return Promise.resolve(byKey.get(key));
				const transfer = {
					id: `tr_${crypto.randomUUID().slice(0, 16)}`,
					object: "transfer",
					amount: params.amount,
					currency: params.currency ?? "usd",
					created: Math.floor(AT_15_DAYS.getTime() / 1000),
				} as Stripe.Transfer;
				byKey.set(key, transfer);
				return Promise.resolve(transfer);
			},
			retrieve: (...args: unknown[]) => {
				calls.push({ method: "transfers.retrieve", args });
				return Promise.resolve({ id: args[0] } as Stripe.Transfer);
			},
		},
	} as unknown as Stripe;
	return {
		client,
		calls,
		created: () => byKey.size,
		createdFor: (amount: number) => [...byKey.values()].filter((t) => t.amount === amount).length,
	};
}

let fake: ReturnType<typeof fakeStripe>;
let realClient: Stripe | null;

// 🚨 Captured once, in `beforeAll` — NOT in `beforeEach`, which is the leak this file
// caught in its own first draft: assigning `realClient = setStripeClient(fake.client)` per
// test means the second test's capture is the FIRST test's fake, and `afterAll` then
// "restores" a fake as the shared client. The next suite to run — suspension-money,
// which expects Stripe unconfigured — reads a client without `invoicePayments` on it and
// dies in `processor.ts` for a reason that has nothing to do with it.
beforeAll(() => {
	realClient = getStripe();
});

beforeEach(() => {
	fake = fakeStripe();
	setStripeClient(fake.client);
});

afterAll(async () => {
	// The client seam is restored even if a test fails mid-flight.
	setStripeClient(realClient);
});

describe("the 14-day hold, counted from each credit's own settledAt", () => {
	it("transfers nothing at 13 days", async () => {
		const creatorId = await makeCreator();
		const id = await credit(creatorId, "10.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_13_DAYS });

		expect(creators).toBe(0);
		expect(fake.calls).toHaveLength(0);
		expect(await transfersFor(creatorId)).toHaveLength(0);
		expect(await coveredCreditsFor(creatorId)).not.toContain(id);
	});

	it("transfers at 14+ days", async () => {
		const creatorId = await makeCreator();
		const id = await credit(creatorId, "10.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		expect(creators).toBe(1);
		expect(fake.calls.filter((c) => c.method === "transfers.create")).toHaveLength(1);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("10.00");
		expect(await coveredCreditsFor(creatorId)).toEqual([id]);
	});

	it("🚨 holds a late-settled credit from its OWN settlement, not the month's", async () => {
		// Two credits for one creator: an early one settled on the 15th, a late-paid
		// invoice's settled on the 25th. At the moment the early one's hold has passed but
		// the late one's has not, exactly the early one transfers — the late money must
		// neither jump ahead of money credited earlier nor restart the earlier clock.
		const creatorId = await makeCreator();
		const early = await credit(creatorId, "4.00", SETTLED_AT);
		const late = await credit(creatorId, "6.00", new Date(SETTLED_AT.getTime() + 10 * DAY_MS));

		// The early credit is 14+ days old; the late one is 4 days old.
		const { creators } = await transferHeldCredits({
			creatorId,
			now: new Date(SETTLED_AT.getTime() + (HOLD_DAYS + 1) * DAY_MS),
		});

		expect(creators).toBe(1);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("4.00");
		expect(await coveredCreditsFor(creatorId)).toEqual([early]);
		expect(await coveredCreditsFor(creatorId)).not.toContain(late);

		// Ten days later the late credit's own hold passes, and it transfers alone — the
		// early one is already covered, and never re-transfers.
		const { creators: secondRun } = await transferHeldCredits({
			creatorId,
			now: new Date(SETTLED_AT.getTime() + (HOLD_DAYS + 11) * DAY_MS),
		});
		expect(secondRun).toBe(1);
		const rows = await transfersFor(creatorId);
		expect(rows).toHaveLength(2);
		const [second] = rows.filter((r) => r.amount === "6.00");
		expect(second).toBeDefined();
	});
});

describe("a creator who cannot be paid yet", () => {
	it("🚨 accumulates — nothing moves, nothing is dropped — and transfers once ready", async () => {
		const bareId = await makeBareUser();
		const id = await credit(bareId, "7.00");

		// No connected account at all.
		const first = await transferHeldCredits({ creatorId: bareId, now: AT_15_DAYS });
		expect(first.creators).toBe(0);
		expect(fake.calls).toHaveLength(0);

		// A connected account that Stripe has not finished with.
		await db.insert(stripeAccounts).values({
			userId: bareId,
			stripeAccountId: `acct_test_${bareId}_halfway`,
			onboardingComplete: true,
			payoutsEnabled: false,
		});
		const second = await transferHeldCredits({ creatorId: bareId, now: AT_15_DAYS });
		expect(second.creators).toBe(0);
		expect(fake.calls).toHaveLength(0);
		expect(await transfersFor(bareId)).toHaveLength(0);

		// Ready — the money that accumulated is the money that moves, all of it.
		await db
			.update(stripeAccounts)
			.set({ payoutsEnabled: true })
			.where(eq(stripeAccounts.userId, bareId));
		const third = await transferHeldCredits({ creatorId: bareId, now: AT_15_DAYS });
		expect(third.creators).toBe(1);
		const [row] = await transfersFor(bareId);
		expect(row.amount).toBe("7.00");
		expect(await coveredCreditsFor(bareId)).toEqual([id]);
	});

	it("leaves a suspended creator's money entirely alone", async () => {
		const creatorId = await makeCreator();
		const id = await credit(creatorId, "9.00");
		await db
			.update(users)
			.set({ suspendedAt: new Date("2031-05-16T00:00:00Z") })
			.where(eq(users.id, creatorId));

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		expect(creators).toBe(0);
		expect(fake.calls).toHaveLength(0);
		expect(await coveredCreditsFor(creatorId)).not.toContain(id);
	});
});

describe("corrections in the held set", () => {
	it("🚨 never transfers a negative sum — a correction outweighing its set is left uncovered", async () => {
		const creatorId = await makeCreator();
		const id = await credit(creatorId, "-5.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		expect(creators).toBe(0);
		expect(fake.calls).toHaveLength(0);
		// Uncovered: money that came back is the reversal build's to move, and the next
		// run must still see it — covered here would be "dropped" by another name.
		expect(await coveredCreditsFor(creatorId)).not.toContain(id);
	});

	it("nets a correction against its set and transfers the remainder", async () => {
		const creatorId = await makeCreator();
		const earned = await credit(creatorId, "10.00");
		const correction = await credit(creatorId, "-3.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		expect(creators).toBe(1);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("7.00");
		// Both rows are covered — the correction is part of the set that moved.
		const covered = await coveredCreditsFor(creatorId);
		expect(covered.sort((a, b) => a - b)).toEqual([earned, correction].sort((a, b) => a - b));
	});

	it("closes a zero-sum set with no Stripe call, and marks it covered", async () => {
		const creatorId = await makeCreator();
		const earned = await credit(creatorId, "8.00");
		const correction = await credit(creatorId, "-8.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		// A movement of nothing is not a movement; the set is still closed.
		expect(creators).toBe(1);
		expect(fake.calls).toHaveLength(0);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("0.00");
		expect(row.stripeTransferId.startsWith("tr_local_zerosum_")).toBe(true);
		const covered = await coveredCreditsFor(creatorId);
		expect(covered).toContain(earned);
		expect(covered).toContain(correction);

		// And a re-run does not re-read it.
		const again = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(again.creators).toBe(0);
	});
});

describe("the crash window", () => {
	it("🚨 a Stripe-success/DB-failure retry creates exactly ONE transfer — the idempotency key replays", async () => {
		const creatorId = await makeCreator();
		const id = await credit(creatorId, "12.00");

		// The crash between the Stripe call and the DB write, simulated by patching
		// `db.transaction` to throw for the FIRST run only — the process "dies" with
		// Stripe's yes and no rows — and then running the job again, which is the retry
		// after the crash. The job's own key derivation is what makes the two runs agree,
		// so this tests the job rather than a hand-typed key.
		const originalTransaction = db.transaction.bind(db);
		let crashOnce = true;
		// biome-ignore lint/suspicious/noExplicitAny: a test seam — the sabotage swaps the method out and puts it back.
		(db as any).transaction = async (body: any) => {
			if (crashOnce) {
				crashOnce = false;
				throw new Error("simulated crash after the Stripe call, before the DB write");
			}
			return originalTransaction(body);
		};
		try {
			await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: put the seam back.
			(db as any).transaction = originalTransaction;
		}

		// The crash left Stripe's yes and no rows — the money moved at Stripe and the
		// coverage set is still "uncovered" here.
		expect(await transfersFor(creatorId)).toHaveLength(0);

		// The retry: same uncovered credits, same deterministic key.
		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(creators).toBe(1);
		// 🚨 The assertion that matters: exactly ONE transfer exists at Stripe. The
		// retry was the second CALL, and the key made it a replay — the money moved once.
		expect(fake.created()).toBe(1);
		expect(fake.createdFor(1200)).toBe(1);

		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("12.00");
		expect(await coveredCreditsFor(creatorId)).toEqual([id]);
	});

	it("🚨 writes the transfer row and its coverage in one transaction, so a half-written transfer cannot exist", async () => {
		const creatorId = await makeCreator();
		const id = await credit(creatorId, "5.00");

		await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		const [row] = await transfersFor(creatorId);
		expect(row).toBeDefined();
		const coverage = await db
			.select({ creditId: creatorTransferCredits.creditId })
			.from(creatorTransferCredits)
			.where(eq(creatorTransferCredits.transferId, row.id));
		expect(coverage.map((c) => c.creditId)).toEqual([id]);
	});
});

describe("the creator's earnings surface", () => {
	it("🚨 shows held and transferred beside the month's figures", async () => {
		// A creator with one credit still inside its hold and one already transferred:
		// the held figure is what no coverage row names, the transferred figure is what
		// the transfer row recorded.
		const creator = await createAccount(`${tag}_earnings_view`);
		madeUserIds.push(creator.userId);
		await enablePayoutsFor(creator.userId);

		// The older credit's hold has passed; the newer one settled 5 days before the
		// run's now, so its own hold has 9 days left.
		await credit(creator.userId, "2.25", new Date(SETTLED_AT.getTime() - 30 * DAY_MS));
		await credit(creator.userId, "3.50", new Date(AT_15_DAYS.getTime() - 5 * DAY_MS));
		await transferHeldCredits({ creatorId: creator.userId, now: AT_15_DAYS });

		const res = await app.fetch(
			new Request("http://localhost/api/subscriptions/earnings", {
				headers: { Cookie: creator.cookie },
			}),
		);
		const body = (await res.json()) as {
			heldTotal: string;
			transferredTotal: string;
		};

		expect(body.transferredTotal).toBe("2.25");
		expect(body.heldTotal).toBe("3.50");

		// A creator whose credits have never transferred sees them all held.
		const second = await createAccount(`${tag}_earnings_held`);
		madeUserIds.push(second.userId);
		await enablePayoutsFor(second.userId);
		await credit(second.userId, "4.00", SETTLED_AT);
		const heldRes = await app.fetch(
			new Request("http://localhost/api/subscriptions/earnings", {
				headers: { Cookie: second.cookie },
			}),
		);
		const heldBody = (await heldRes.json()) as {
			heldTotal: string;
			transferredTotal: string;
		};
		expect(heldBody.heldTotal).toBe("4.00");
		expect(heldBody.transferredTotal).toBe("0.00");
	});
});
