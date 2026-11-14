// SPDX-License-Identifier: Apache-2.0
/**
 * A Collab Work's money: a sale's split, a refund's reversal, and the Time Pool's share.
 *
 * The suite pins the properties the feature is paid for, not the UI:
 * - **A sale freezes an even split at completion.** One purchase row stays the buyer's
 *   receipt; `purchase_splits` carries one row per owner, summing to the creator earnings
 *   in cents. Every owner is transferred their own slice, and the purchase row's own
 *   transfer stays empty.
 * - **Redelivery and a later ownership change cannot re-split or re-pay.** The split rows
 *   are the record, not today's owner set.
 * - **The retry job pays only the shares the completion path missed**, through the same
 *   per-owner idempotency key.
 * - **A refund reverses every owner's slice**, and nets each slice that could not be
 *   recovered — never the publisher's whole earnings, and never one owner twice.
 * - **A dispute nets every owner's frozen slice.**
 * - **A physical sale holds one credit per owner**, with no transfer at completion.
 * - **The Time Pool divides a Work's credited seconds across its owners**, conserving the
 *   row and the pool total.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	attentionEvents,
	creatorCredits,
	creatorNettings,
	disputes,
	purchaseSplits,
	purchases,
	workCollaborators,
} from "@anthers/db/schema";
import { PUBLIC_ACCESS_PRICE, timePoolFor } from "@anthers/shared/constants";
import { calculateFees } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { computeMonth } from "../jobs/distribute-pool";
import { getStripe, setStripeClient } from "../lib/stripe";
import { recordNettingForDispute } from "../services/netting";
import { retryFailedTransfers, splitChargeToCreators } from "../services/purchase-split";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const RUN = crypto.randomUUID().slice(0, 8);
const PRICE = "5.00";
const fees = calculateFees(new Decimal(PRICE), { type: "digital" });
const TOTAL_CENTS = Math.round(Number(fees.creatorEarnings) * 100);
const HALF_LOW = Math.floor(TOTAL_CENTS / 2);
const HALF_HIGH = TOTAL_CENTS - HALF_LOW;

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

// ── The fake Stripe client ───────────────────────────────────────────────────

interface ReversalCall {
	transfer: string;
	amount: number;
	key: string | undefined;
}

function fakeStripe() {
	const transfersByKey = new Map<string, Stripe.Transfer>();
	const reversals: ReversalCall[] = [];
	const createCalls: Array<{ amount: number; key: string | undefined; creator: unknown }> = [];
	let failCreator: string | null = null;
	let failReversals = false;

	const client = {
		transfers: {
			create: (params: Stripe.TransferCreateParams, options?: Stripe.RequestOptions) => {
				createCalls.push({
					amount: params.amount ?? 0,
					key: options?.idempotencyKey,
					creator: params.metadata?.creatorId,
				});
				if (failCreator != null && params.metadata?.creatorId === failCreator) {
					return Promise.reject(new Error("simulated transfer failure"));
				}
				const key = options?.idempotencyKey ?? `nokey_${transfersByKey.size}`;
				const existing = transfersByKey.get(key);
				if (existing) return Promise.resolve(existing);
				const transfer = {
					id: `tr_${crypto.randomUUID().slice(0, 16)}`,
					object: "transfer",
					amount: params.amount,
					currency: params.currency ?? "usd",
				} as Stripe.Transfer;
				transfersByKey.set(key, transfer);
				return Promise.resolve(transfer);
			},
			createReversal: (
				transferId: string,
				params: Stripe.TransferCreateReversalParams,
				options?: Stripe.RequestOptions,
			) => {
				reversals.push({
					transfer: transferId,
					amount: params.amount ?? 0,
					key: options?.idempotencyKey,
				});
				if (failReversals) return Promise.reject(new Error("simulated payout already left"));
				return Promise.resolve({
					id: `trr_${crypto.randomUUID().slice(0, 16)}`,
					object: "transfer_reversal",
					transfer: transferId,
				} as Stripe.TransferReversal);
			},
		},
		refunds: {
			create: () => Promise.resolve({ id: `re_${crypto.randomUUID().slice(0, 16)}` }),
		},
		paymentIntents: {
			retrieve: (id: string) =>
				Promise.resolve({ id, latest_charge: `ch_${crypto.randomUUID().slice(0, 8)}` }),
		},
	} as unknown as Stripe;

	return {
		client,
		transfers: () => [...transfersByKey.values()],
		createCalls,
		reversals,
		setFailCreator: (creatorId: number | null) => {
			failCreator = creatorId == null ? null : String(creatorId);
		},
		setFailReversals: (fail: boolean) => {
			failReversals = fail;
		},
	};
}

type Fake = ReturnType<typeof fakeStripe>;

let fake: Fake;
let realClient: Stripe | null;

// ── Fixtures ─────────────────────────────────────────────────────────────────

let publisher: FixtureAccount;
let collaborator: FixtureAccount;
let buyer: FixtureAccount;

/** Every purchase this suite wrote, so the rows can be taken back afterward. */
const purchaseIds: number[] = [];

async function makeWork(title: string): Promise<number> {
	const work = await insertWork({
		creatorId: publisher.userId,
		type: "game",
		title,
		streamEnabled: false,
		downloadEnabled: true,
		access: [{ threshold: 0, allow: true, price: PRICE }],
	});
	await db.insert(workCollaborators).values({
		workId: work.id,
		creatorId: collaborator.userId,
		status: "accepted",
		invitedById: publisher.userId,
	});
	return work.id;
}

async function makePurchase(
	opts: { type?: string; workId?: number; price?: string } = {},
): Promise<typeof purchases.$inferSelect> {
	const workId = opts.workId ?? (await makeWork(`Collab sale ${crypto.randomUUID().slice(0, 8)}`));
	const price = new Decimal(opts.price ?? PRICE);
	const splitFees = calculateFees(price, {
		type: opts.type === "physical" ? "physical" : "digital",
	});
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId: buyer.userId,
			workId,
			creatorId: publisher.userId,
			workTitle: `Collab sale ${crypto.randomUUID().slice(0, 8)}`,
			workType: "game",
			workPublicId: null,
			type: opts.type ?? "digital",
			amount: price.toFixed(2),
			processingFee: splitFees.processingFee.toFixed(2),
			salesTax: "0.00",
			creatorEarnings: splitFees.creatorEarnings.toFixed(2),
			stripePaymentIntentId: `pi_${crypto.randomUUID().slice(0, 16)}`,
			status: "completed",
		})
		.returning();
	purchaseIds.push(row.id);
	return row;
}

async function splitsFor(purchaseId: number) {
	return db
		.select()
		.from(purchaseSplits)
		.where(eq(purchaseSplits.purchaseId, purchaseId))
		.orderBy(purchaseSplits.id);
}

beforeAll(async () => {
	realClient = getStripe();
	fake = fakeStripe();
	setStripeClient(fake.client);

	publisher = await createAccount(`cwm_pub_${RUN}`, {
		emailVerified: true,
		fields: { creatorMode: true },
	});
	collaborator = await createAccount(`cwm_col_${RUN}`, {
		emailVerified: true,
		fields: { creatorMode: true },
	});
	buyer = await createAccount(`cwm_buy_${RUN}`, { emailVerified: true });
	await enablePayoutsFor(publisher.userId);
	await enablePayoutsFor(collaborator.userId);
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	setStripeClient(realClient);
	if (purchaseIds.length > 0) {
		await db.delete(creatorNettings).where(inArray(creatorNettings.purchaseId, purchaseIds));
		await db.delete(creatorCredits).where(inArray(creatorCredits.purchaseId, purchaseIds));
		await db.delete(purchases).where(inArray(purchases.id, purchaseIds));
	}
});

// ─────────────────────────────────────────────────────────────────────────────

describe("a Collab Work's sale", () => {
	it("freezes an even split and transfers one share per owner", async () => {
		const purchase = await makePurchase();
		await splitChargeToCreators({ id: purchase.stripePaymentIntentId, latestCharge: `ch_${RUN}` }, [
			purchase,
		]);

		const splits = await splitsFor(purchase.id);
		expect(splits).toHaveLength(2);
		const total = splits.reduce((sum, row) => sum.plus(row.amount), new Decimal(0));
		expect(total.toFixed(2)).toBe(purchase.creatorEarnings);
		expect(new Set(splits.map((row) => row.creatorId))).toEqual(
			new Set([publisher.userId, collaborator.userId]),
		);
		// The split is the frozen record; every row names its own transfer.
		expect(splits.every((row) => row.stripeTransferId != null)).toBe(true);

		// One transfer per owner, each their slice, funded by the buyer's charge.
		const transfers = fake.transfers();
		expect(transfers).toHaveLength(2);
		expect(transfers.map((transfer) => transfer.amount).sort((a, b) => a - b)).toEqual([
			HALF_LOW,
			HALF_HIGH,
		]);
		// The purchase row stays the buyer's receipt and is never stamped with one owner's
		// transfer — its money lives in the splits.
		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.stripeTransferId).toBeNull();
	});

	it("does not re-split or re-pay on redelivery, even after ownership changes", async () => {
		const purchase = await makePurchase();
		const charge = { id: purchase.stripePaymentIntentId, latestCharge: `ch_${RUN}` };
		await splitChargeToCreators(charge, [purchase]);
		const before = await splitsFor(purchase.id);

		// The collaborator leaves after the sale. The frozen record must not follow today's
		// owner set — the publisher was paid their own slice, and the leaver theirs.
		await db.delete(workCollaborators).where(eq(workCollaborators.workId, purchase.workId!));

		const callsBefore = fake.createCalls.length;
		const [again] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		await splitChargeToCreators(charge, [again]);

		const after = await splitsFor(purchase.id);
		expect(after.map((row) => [row.creatorId, row.amount])).toEqual(
			before.map((row) => [row.creatorId, row.amount]),
		);
		expect(after.every((row) => row.stripeTransferId != null)).toBe(true);
		// Both shares were already stamped, so the redelivery asks Stripe for nothing.
		expect(fake.createCalls.length).toBe(callsBefore);
	});

	it("the retry job pays only the share the completion path missed", async () => {
		const purchase = await makePurchase();
		const charge = { id: purchase.stripePaymentIntentId, latestCharge: `ch_${RUN}` };

		// One owner's transfer fails at completion; the other's lands.
		fake.setFailCreator(collaborator.userId);
		await splitChargeToCreators(charge, [purchase]);
		fake.setFailCreator(null);

		const afterFailure = await splitsFor(purchase.id);
		const failed = afterFailure.find((row) => row.creatorId === collaborator.userId);
		const landed = afterFailure.find((row) => row.creatorId === publisher.userId);
		expect(failed?.stripeTransferId).toBeNull();
		expect(landed?.stripeTransferId).not.toBeNull();

		const callsBefore = fake.createCalls.length;
		const attempted = await retryFailedTransfers();
		expect(attempted).toBeGreaterThanOrEqual(1);
		expect(fake.createCalls.length).toBe(callsBefore + 1);

		const afterRetry = await splitsFor(purchase.id);
		expect(afterRetry.every((row) => row.stripeTransferId != null)).toBe(true);
		// The owner who was already paid keeps their transfer; only the missed slice moves.
		expect(afterRetry.find((row) => row.creatorId === publisher.userId)?.stripeTransferId).toBe(
			landed?.stripeTransferId,
		);
		const retried = fake.createCalls.at(-1);
		expect(retried?.creator).toBe(String(collaborator.userId));
		expect(retried?.amount).toBe(Math.round(Number(failed?.amount) * 100));
	});

	it("a physical sale holds one credit per owner, with no transfer at completion", async () => {
		const purchase = await makePurchase({ type: "physical" });
		await splitChargeToCreators({ id: purchase.stripePaymentIntentId, latestCharge: `ch_${RUN}` }, [
			purchase,
		]);

		const splits = await splitsFor(purchase.id);
		expect(splits).toHaveLength(2);
		expect(splits.every((row) => row.stripeTransferId == null)).toBe(true);

		const credits = await db
			.select()
			.from(creatorCredits)
			.where(eq(creatorCredits.purchaseId, purchase.id));
		expect(credits).toHaveLength(2);
		expect(credits.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2)).toBe(
			purchase.creatorEarnings,
		);
		expect(new Set(credits.map((row) => row.creatorId))).toEqual(
			new Set([publisher.userId, collaborator.userId]),
		);
	});
});

describe("a refund of a Collab Work", () => {
	it("reverses each owner's own slice, and nets each slice it cannot recover", async () => {
		const purchase = await makePurchase();
		await splitChargeToCreators({ id: purchase.stripePaymentIntentId, latestCharge: `ch_${RUN}` }, [
			purchase,
		]);
		const splits = await splitsFor(purchase.id);

		// The paid-out creator: the connected balance cannot fund either reversal.
		fake.setFailReversals(true);
		const response = await req(`/api/payments/purchases/${purchase.id}/refund`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ORIGIN,
				Cookie: buyer.cookie,
			},
			body: JSON.stringify({}),
		});
		expect(response.status).toBe(200);

		// One reversal per owner, each for exactly their frozen slice, each with its own
		// idempotency key — and never the publisher's whole earnings.
		expect(fake.reversals).toHaveLength(2);
		expect(fake.reversals.map((call) => call.amount).sort((a, b) => a - b)).toEqual([
			HALF_LOW,
			HALF_HIGH,
		]);
		expect(new Set(fake.reversals.map((call) => call.key)).size).toBe(2);
		expect(fake.reversals.map((call) => call.transfer).sort()).toEqual(
			splits.flatMap((row) => (row.stripeTransferId == null ? [] : [row.stripeTransferId])).sort(),
		);

		const nettings = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.purchaseId, purchase.id));
		expect(nettings).toHaveLength(2);
		expect(nettings.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2)).toBe(
			purchase.creatorEarnings,
		);
		expect(new Set(nettings.map((row) => row.creatorId))).toEqual(
			new Set([publisher.userId, collaborator.userId]),
		);

		const [refunded] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(refunded.status).toBe("refunded");
	});
});

describe("a dispute on a Collab Work", () => {
	it("nets every owner's frozen slice, one row each", async () => {
		const purchase = await makePurchase();
		await splitChargeToCreators({ id: purchase.stripePaymentIntentId, latestCharge: `ch_${RUN}` }, [
			purchase,
		]);
		const [dispute] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${crypto.randomUUID().slice(0, 16)}`,
				stripeChargeId: `ch_${crypto.randomUUID().slice(0, 8)}`,
				stripePaymentIntentId: purchase.stripePaymentIntentId,
				amount: purchase.amount,
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
				userId: buyer.userId,
			})
			.returning();

		await recordNettingForDispute(dispute, purchase, new Date());

		const nettings = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.disputeId, dispute.id));
		expect(nettings).toHaveLength(2);
		expect(nettings.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2)).toBe(
			purchase.creatorEarnings,
		);
	});
});

describe("the Time Pool", () => {
	it("divides a Work's seconds across its owners, conserving the pool", async () => {
		const workId = await makeWork(`Pool Work ${crypto.randomUUID().slice(0, 8)}`);
		const subscriber = await createAccount(`cwm_sub_${RUN}`, { emailVerified: true });
		// One hour of Public Access on the co-owned Work, attributed to the publisher the
		// way attention stores it.
		await db.insert(attentionEvents).values({
			userId: subscriber.userId,
			creatorId: publisher.userId,
			workId,
			eventType: "watch",
			durationSeconds: 3600,
			startedAt: new Date("2032-05-10T10:00:00Z"),
			endedAt: new Date("2032-05-10T11:00:00Z"),
			createdAt: new Date("2032-05-10T11:00:00Z"),
			publicAccess: true,
			clientId: `cwm-${RUN}`,
		});

		const month = await computeMonth({
			userId: subscriber.userId,
			cycle: "2032-05-01",
			start: new Date("2032-05-01T00:00:00Z"),
			end: new Date("2032-06-01T00:00:00Z"),
			anthersDollars: PUBLIC_ACCESS_PRICE,
			freeTimePool: 0,
			charges: [],
			includeStickers: false,
		});

		// Both owners have a row, and nobody else does — the Work's hour is theirs, not the
		// publisher's alone.
		expect(new Set(month.distributions.keys())).toEqual(
			new Set([publisher.userId, collaborator.userId]),
		);
		const a = month.distributions.get(publisher.userId)!;
		const b = month.distributions.get(collaborator.userId)!;

		const whole = new Decimal(timePoolFor(PUBLIC_ACCESS_PRICE));
		expect(month.timePool.toFixed(2)).toBe(whole.toFixed(2));
		expect(month.distributedByTime.toFixed(2)).toBe(whole.toFixed(2));
		// To the cent, and the pool total is unchanged by the split.
		expect(a.poolAmount.plus(b.poolAmount).toFixed(2)).toBe(whole.toFixed(2));
		expect(a.poolAmount.minus(b.poolAmount).abs().lte("0.01")).toBe(true);
		// The attention ledger's seconds conserve too (rounded to a stored integer).
		expect(a.attentionSeconds + b.attentionSeconds).toBe(3600);
	});
});
