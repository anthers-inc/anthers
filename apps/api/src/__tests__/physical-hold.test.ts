// SPDX-License-Identifier: Apache-2.0
/**
 * A physical good's hold — the creator's share waits for the parcel.
 *
 * The suite's claims, one spec each:
 * - **A good's money is credited, not transferred, at completion.** The purchase row has no
 *   transfer and a `sale` credit names it, so the release question is asked of the shipment
 *   rather than of a date.
 * - **The release rule is one sentence, and a complaint freezes it.** Delivered plus a closed
 *   window releases; an open complaint on the same order does not, however settled the parcel
 *   is.
 * - **A refund takes a held credit away and closes a released one.** Before release the money
 *   simply never moves; after it, the creator was paid and recovery is the netting ledger's.
 * - **The retry path never pays a good early.** A completed physical row is excluded from
 *   `retryFailedTransfers`, which would otherwise pay at completion and leave the credit to
 *   pay again after delivery.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	creatorCredits,
	creatorTransferCredits,
	creatorTransfers,
	purchases,
	shipmentComplaints,
	shipments,
} from "@anthers/db/schema";
import { eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import { transferHeldCredits } from "../jobs/transfer-held-credits";
import { getStripe, setStripeClient } from "../lib/stripe";
import { retryFailedTransfers, settleSaleCreditOnRefund } from "../services/purchase-split";
import { releasableOrders } from "../services/shipments";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";

purgeAccountsCreatedHere();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2031-06-01T12:00:00Z");
const tag = `hold_${Date.now().toString(36)}`;

let creator: FixtureAccount;
const purchaseIds: number[] = [];
const transferIds: number[] = [];

function fakeStripe() {
	const byKey = new Map<string, Stripe.Transfer>();
	const client = {
		transfers: {
			create: (...args: unknown[]) => {
				const [params, options] = args as [Stripe.TransferCreateParams, Stripe.RequestOptions?];
				const key = options?.idempotencyKey ?? `nokey_${byKey.size}`;
				if (byKey.has(key)) return Promise.resolve(byKey.get(key));
				const transfer = {
					id: `tr_${crypto.randomUUID().slice(0, 16)}`,
					object: "transfer",
					amount: params.amount,
					currency: params.currency ?? "usd",
					// The job stamps `transferred_at` from this, exactly as it does from Stripe's
					// own object; a fake without it writes an Invalid Date.
					created: Math.floor(NOW.getTime() / 1000),
				} as Stripe.Transfer;
				byKey.set(key, transfer);
				return Promise.resolve(transfer);
			},
		},
	} as unknown as Stripe;
	return { client, created: () => byKey.size };
}

let fake: ReturnType<typeof fakeStripe>;
let realClient: Stripe | null;

beforeAll(async () => {
	realClient = getStripe();
	creator = await createAccount(`${tag}_creator`, { emailVerified: true });
	await enablePayoutsFor(creator.userId);
}, 60_000);

beforeEach(() => {
	fake = fakeStripe();
	setStripeClient(fake.client);
});

afterAll(async () => {
	setStripeClient(realClient);
	if (purchaseIds.length > 0) {
		await db.delete(shipmentComplaints).where(inArray(shipmentComplaints.purchaseId, purchaseIds));
		await db.delete(shipments).where(inArray(shipments.purchaseId, purchaseIds));
		await db.delete(creatorCredits).where(inArray(creatorCredits.purchaseId, purchaseIds));
		for (const id of purchaseIds) await db.delete(purchases).where(eq(purchases.id, id));
	}
	if (transferIds.length > 0) {
		await db
			.delete(creatorTransferCredits)
			.where(inArray(creatorTransferCredits.transferId, transferIds));
		await db.delete(creatorTransfers).where(inArray(creatorTransfers.id, transferIds));
	}
});

/** A completed physical purchase, its shipment, and the sale credit completion would write. */
async function makeHeldOrder(opts: {
	delivered?: boolean;
	windowClosed?: boolean;
	complaint?: boolean;
}): Promise<{ purchaseId: number; creditId: number }> {
	const [purchase] = await db
		.insert(purchases)
		.values({
			buyerId: creator.userId,
			creatorId: creator.userId,
			workTitle: "A mug",
			workType: "physical",
			workPublicId: 1,
			type: "physical",
			amount: "36.00",
			processingFee: "1.34",
			salesTax: "2.11",
			creatorEarnings: "41.16",
			quantity: 2,
			shippingAmount: "6.50",
			handlingBusinessDays: 3,
			stripePaymentIntentId: `pi_hold_${crypto.randomUUID().slice(0, 8)}`,
			status: "completed",
		})
		.returning();
	purchaseIds.push(purchase.id);

	const deliveredAt = opts.delivered === false ? null : new Date(NOW.getTime() - 10 * DAY_MS);
	await db.insert(shipments).values({
		purchaseId: purchase.id,
		handlingBusinessDays: 3,
		shipByAt: new Date(NOW.getTime() - 20 * DAY_MS),
		shippedAt: new Date(NOW.getTime() - 15 * DAY_MS),
		deliveredAt,
		deliverySource: deliveredAt ? "buyer" : null,
		complaintWindowEndsAt:
			deliveredAt == null
				? null
				: new Date(deliveredAt.getTime() + (opts.windowClosed === false ? 30 : 7) * DAY_MS),
		events: [],
	});

	if (opts.complaint) {
		await db.insert(shipmentComplaints).values({
			purchaseId: purchase.id,
			buyerId: creator.userId,
			reason: "damaged",
			details: "Cracked handle",
			status: "open",
		});
	}

	const [credit] = await db
		.insert(creatorCredits)
		.values({
			creatorId: creator.userId,
			subscriberId: creator.userId,
			billingCycle: "2031-06-01",
			kind: "sale",
			fundedBy: "buyer",
			amount: "41.16",
			settledAt: new Date(NOW.getTime() - 2 * DAY_MS),
			purchaseId: purchase.id,
		})
		.returning({ id: creatorCredits.id });
	return { purchaseId: purchase.id, creditId: credit.id };
}

describe("the release rule", () => {
	it("releases a delivered order whose window has closed", async () => {
		const { purchaseId } = await makeHeldOrder({});
		expect((await releasableOrders([purchaseId], NOW)).has(purchaseId)).toBe(true);
	});

	it("holds an order that has not landed, and one still inside its window", async () => {
		const inTransit = await makeHeldOrder({ delivered: false });
		const open = await makeHeldOrder({ windowClosed: false });
		const set = await releasableOrders([inTransit.purchaseId, open.purchaseId], NOW);
		expect(set.has(inTransit.purchaseId)).toBe(false);
		expect(set.has(open.purchaseId)).toBe(false);
	});

	it("freezes a releasable order while a buyer's complaint is open", async () => {
		const { purchaseId } = await makeHeldOrder({ complaint: true });
		expect((await releasableOrders([purchaseId], NOW)).has(purchaseId)).toBe(false);
	});
});

describe("the transfer step with goods held", () => {
	it("moves the released credit and leaves the others alone", async () => {
		const released = await makeHeldOrder({});
		const inTransit = await makeHeldOrder({ delivered: false });
		const frozen = await makeHeldOrder({ complaint: true });

		await transferHeldCredits({ now: NOW, creatorId: creator.userId });

		const covered = await db
			.select({ creditId: creatorTransferCredits.creditId })
			.from(creatorTransferCredits)
			.innerJoin(creatorTransfers, eq(creatorTransferCredits.transferId, creatorTransfers.id))
			.where(eq(creatorTransfers.creatorId, creator.userId));
		for (const row of await db
			.select()
			.from(creatorTransfers)
			.where(eq(creatorTransfers.creatorId, creator.userId))) {
			transferIds.push(row.id);
		}
		const coveredIds = covered.map((row) => row.creditId);
		expect(coveredIds).toContain(released.creditId);
		expect(coveredIds).not.toContain(inTransit.creditId);
		expect(coveredIds).not.toContain(frozen.creditId);
		// The money that moved is exactly the credits the run covered — never the held ones.
		// (Earlier specs in this file leave their own releasable credits behind, so the set
		// is asserted by membership and by the sum, not by a fixed figure.)
		const [transfer] = await db
			.select()
			.from(creatorTransfers)
			.where(eq(creatorTransfers.creatorId, creator.userId));
		expect(transfer.amount).toBe((coveredIds.length * 41.16).toFixed(2));
		// One Stripe call for the whole set: the idempotency key is the coverage set.
		expect(fake.created()).toBe(1);
	});
});

describe("a refund against a held sale", () => {
	it("takes a credit that was never transferred", async () => {
		const { purchaseId, creditId } = await makeHeldOrder({ delivered: false });
		expect(await settleSaleCreditOnRefund(purchaseId)).toBe("held");
		const rows = await db.select().from(creatorCredits).where(eq(creatorCredits.id, creditId));
		expect(rows).toHaveLength(0);
	});

	it("reports a released credit so recovery moves to netting", async () => {
		const { purchaseId, creditId } = await makeHeldOrder({});
		const [transfer] = await db
			.insert(creatorTransfers)
			.values({
				creatorId: creator.userId,
				stripeTransferId: `tr_test_${crypto.randomUUID().slice(0, 8)}`,
				amount: "41.16",
				transferredAt: NOW,
			})
			.returning();
		transferIds.push(transfer.id);
		await db.insert(creatorTransferCredits).values({ transferId: transfer.id, creditId });

		expect(await settleSaleCreditOnRefund(purchaseId)).toBe("released");
		// The credit stays: the money moved, and the books say so.
		const rows = await db.select().from(creatorCredits).where(eq(creatorCredits.id, creditId));
		expect(rows).toHaveLength(1);
	});

	it("answers none for a purchase with no credit at all", async () => {
		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId: creator.userId,
				creatorId: creator.userId,
				workTitle: "An old order",
				workType: "physical",
				workPublicId: 2,
				type: "physical",
				amount: "18.00",
				processingFee: "0.82",
				salesTax: "0.00",
				creatorEarnings: "17.18",
				stripePaymentIntentId: `pi_old_${crypto.randomUUID().slice(0, 8)}`,
				status: "completed",
			})
			.returning();
		purchaseIds.push(purchase.id);
		expect(await settleSaleCreditOnRefund(purchase.id)).toBe("none");
	});
});

describe("the retry path", () => {
	it("never pays a physical row early", async () => {
		const [purchase] = await db
			.insert(purchases)
			.values({
				buyerId: creator.userId,
				creatorId: creator.userId,
				workTitle: "A held good",
				workType: "physical",
				workPublicId: 3,
				type: "physical",
				amount: "18.00",
				processingFee: "0.82",
				salesTax: "0.00",
				creatorEarnings: "17.18",
				stripePaymentIntentId: `pi_retry_${crypto.randomUUID().slice(0, 8)}`,
				status: "completed",
			})
			.returning();
		purchaseIds.push(purchase.id);

		await retryFailedTransfers();

		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.stripeTransferId).toBeNull();
		expect(fake.created()).toBe(0);
	});
});
