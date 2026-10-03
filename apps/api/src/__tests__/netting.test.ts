// SPDX-License-Identifier: Apache-2.0
/**
 * Netting — a creator's share of returned money, recovered from their later earnings
 * (Parker, 2026-09-14, the collect-and-pay-out decision's "Money That Comes Back").
 *
 * 🚨 **The defect this suite exists for is a creator being billed, or money moving twice.**
 * The decision's own words are the invariant: "netting never sends a creator a bill" —
 * no account debit, no negative transfer, never below zero — and the crash-window pair
 * (a retry must neither double-transfer nor double-net) is the other place a payments
 * bug costs real money with no error.
 *
 * The cases worth pinning, because every one of them fails silently:
 *
 *   • a dispute on a purchase writes a netting row for the row's EARNINGS — never the
 *     buyer's full charge, never the tax, never the platform's share;
 *   • a refund whose transfer reversal recovered the share writes NO netting row (the
 *     `reverse_transfer` case, the before-transfer mechanism that already works);
 *   • a refund whose reversal is absent — the paid-out creator — writes one;
 *   • netting that exceeds held credits transfers NOTHING and stays open;
 *   • partial netting reduces the transfer and writes application rows;
 *   • a won dispute reverses the netting: nothing applied cancels the row, some applied
 *     also writes the compensating credit;
 *   • the creator-visible record: the earnings endpoint's `nettedTotal` and
 *     `nettingOpenTotal`.
 *
 * Nothing here reaches the network: the transfer step drives a recording fake Stripe
 * shaped like the one in `transfer-held-credits.test.ts`, and the webhook path signs
 * with a real Stripe instance so signature verification runs genuine HMAC.
 *
 * Verified by sabotage before being committed, with predicted counts and observed counts:
 *   • skipping the netting plan (`nettingPlanFor` returning the raw sum) failed **5**,
 *     predicted 5 — every recovery assertion and the earnings surface;
 *   • `recordNettingForDispute` no-op failed **8**, predicted 7 — the eighth is the
 *     dispute-idempotency test, a genuine dependent (its one row IS the write);
 *   • `applyNettingPlan` no-op failed **5**, predicted 5;
 *   • `reverseNettingForWonDispute` no-op failed **2**, predicted 2;
 *   • `recordNettingForRefund` no-op failed **1**, predicted 1;
 *   • dropping the zero floor in the plan failed **1** (the mixed-set case below), predicted 1;
 *   • `refundPurchase` hardcoding the share as unrecovered failed **1** (the
 *     before-transfer refund test), predicted 1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	creatorCredits,
	creatorNettingApplications,
	creatorNettings,
	creatorTransferCredits,
	creatorTransfers,
	disputes,
	purchases,
} from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import type Stripe from "stripe";
import StripeSdk from "stripe";
import app from "../index";
import { HOLD_DAYS, transferHeldCredits } from "../jobs/transfer-held-credits";
import { getStripe, setStripeClient } from "../lib/stripe";
import {
	nettingPlanFor,
	recordNettingForDispute,
	reverseNettingForWonDispute,
} from "../services/netting";
import { refundPurchase } from "../services/refunds";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { enablePayoutsFor } from "./payouts-fixture";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const WEBHOOK_SECRET = "whsec_test_secret_for_netting_signatures";
const FAKE_KEY = "sk_test_fake_no_network";

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** POST a webhook with a real signature. */
async function sendWebhook(payload: object) {
	const body = JSON.stringify(payload);
	const signature = await signer.webhooks.generateTestHeaderStringAsync({
		payload: body,
		secret: WEBHOOK_SECRET,
	});
	return testFetch(
		new Request("http://localhost/api/payments/stripe/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json", "stripe-signature": signature },
			body,
		}),
	);
}

function stripeEvent(type: string, object: unknown) {
	return {
		id: `evt_${uid()}`,
		object: "event",
		api_version: "2025-01-01",
		created: Math.floor(Date.now() / 1000),
		livemode: false,
		pending_webhooks: 0,
		request: { id: null, idempotency_key: null },
		type,
		data: { object },
	};
}

const signer = new StripeSdk(FAKE_KEY);

const DAY_MS = 24 * 60 * 60 * 1000;
const SETTLED_AT = new Date("2031-06-15T02:00:00Z");
/** The hold passed. */
const AT_15_DAYS = new Date(SETTLED_AT.getTime() + (HOLD_DAYS + 1) * DAY_MS);

const tag = `nt_${Date.now().toString(36)}`;
let n = 0;
const madeUserIds: number[] = [];
const madeTransferIds: number[] = [];

async function makeCreator(): Promise<{ userId: number; cookie: string }> {
	n += 1;
	const account = await createAccount(`${tag}_creator_${n}`);
	madeUserIds.push(account.userId);
	await enablePayoutsFor(account.userId);
	return { userId: account.userId, cookie: account.cookie };
}

/** A settled credit, as `settleCycle` would have written it. */
async function credit(creatorId: number, amount: string, settledAt: Date = SETTLED_AT) {
	const [row] = await db
		.insert(creatorCredits)
		.values({
			creatorId,
			subscriberId: creatorId,
			billingCycle: "2031-06-01",
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

/** A completed purchase of a fixture Work on a fresh PaymentIntent. */
async function completedPurchase(
	creatorId: number,
	buyerId: number,
	workId: number,
	earnings = "4.55",
) {
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId,
			workId,
			creatorId,
			workTitle: "Netting work",
			workType: "game",
			workPublicId: null,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			salesTax: "0.00",
			creatorEarnings: earnings,
			stripePaymentIntentId: `pi_${uid()}`,
			status: "completed",
		})
		.returning();
	return row;
}

let realClient: Stripe | null;
let previousWebhookSecret: string | undefined;

beforeAll(() => {
	// The webhook branch's signature verification needs its secret; the dispute-created
	// hook is the one genuine integration this suite exercises through the route.
	process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

// ── The fake Stripe client — the recording transfers surface ───────────────────

function fakeStripe() {
	const calls: { method: string; args: unknown[] }[] = [];
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
		// The refunds surface `refundPurchase` drives, with the transfer-reversal fact the
		// netting write turns on: a reversal object present says the share came back at
		// Stripe; null (the paid-out creator) says it did not.
		refunds: {
			create: (...args: unknown[]) => {
				calls.push({ method: "refunds.create", args });
				return Promise.resolve({
					id: `re_${uid()}`,
					object: "refund",
					status: "succeeded",
					source_transfer_reversal: refundReversal,
				} as unknown as Stripe.Refund);
			},
		},
		// The webhook route verifies signatures through the shared client, so the fake
		// carries a real `webhooks` namespace — a genuine HMAC check against the same
		// secret the test signs with, exactly the shape `disputes.test.ts` uses.
		webhooks: new StripeSdk(FAKE_KEY).webhooks,
	} as unknown as Stripe;
	return {
		client,
		calls,
		created: () => byKey.size,
	};
}

/** What the next fake refund's `source_transfer_reversal` reads. */
let refundReversal: unknown = null;
let fake: ReturnType<typeof fakeStripe>;

beforeAll(() => {
	realClient = getStripe();
	previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
});

beforeEach(() => {
	fake = fakeStripe();
	setStripeClient(fake.client);
});

afterAll(async () => {
	setStripeClient(realClient);
	if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
	else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;

	// The netting rows outlive their accounts by design (set-null creator), so they are
	// swept by creator before the accounts — the same shape the transfer suite's teardown
	// follows, in dependency order: applications, nettings, coverage, transfers. Scoped to
	// this suite's creators rather than the whole table, because the session's database is
	// shared with every other suite in the run.
	if (madeUserIds.length > 0) {
		const ours = await db
			.select({ id: creatorNettings.id })
			.from(creatorNettings)
			.where(inArray(creatorNettings.creatorId, madeUserIds));
		if (ours.length > 0) {
			await db.delete(creatorNettingApplications).where(
				inArray(
					creatorNettingApplications.nettingId,
					ours.map((o) => o.id),
				),
			);
			await db.delete(creatorNettings).where(inArray(creatorNettings.creatorId, madeUserIds));
		}
	}
	if (madeTransferIds.length > 0) {
		await db
			.delete(creatorTransferCredits)
			.where(inArray(creatorTransferCredits.transferId, madeTransferIds));
		await db.delete(creatorTransfers).where(inArray(creatorTransfers.id, madeTransferIds));
	}
});

// ─────────────────────────────────────────────────────────────────────────────

describe("writing netting rows", () => {
	it("🚨 a dispute arriving through the webhook writes the netting row — the route integration", async () => {
		const { userId: creatorId } = await makeCreator();
		const buyer = await createAccount(`${tag}_buyer_w`);
		madeUserIds.push(buyer.userId);
		const work = await insertWork({
			creatorId,
			type: "game",
			title: `Netting work ${uid()}`,
		});
		const purchase = await completedPurchase(creatorId, buyer.userId, work.id, "4.55");

		// A real `charge.dispute.created` event, signed: the route records the dispute,
		// flips the purchase, and hands the netting half its rows.
		const dispute = {
			id: `dp_${uid()}`,
			object: "dispute",
			amount: 545,
			charge: `ch_${uid()}`,
			created: Math.floor(Date.now() / 1000),
			currency: "usd",
			payment_intent: purchase.stripePaymentIntentId,
			reason: "fraudulent",
			status: "needs_response",
			evidence_details: { due_by: 1_800_000_000 },
		};
		const res = await sendWebhook(stripeEvent("charge.dispute.created", dispute));
		expect(res.status).toBe(200);

		const rows = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.creatorId, creatorId));
		expect(rows).toHaveLength(1);
		expect(rows[0].amount).toBe("4.55");
		// The dispute source links the row, and the dispute names the purchase.
		expect(rows[0].purchaseId).toBeNull();
		const [disputeRow] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, dispute.id));
		expect(disputeRow.purchaseId).toBe(purchase.id);
		expect(rows[0].disputeId).toBe(disputeRow.id);

		// And a won close through the same door reverses it.
		const closed = await sendWebhook(
			stripeEvent("charge.dispute.closed", { ...dispute, status: "won" }),
		);
		expect(closed.status).toBe(200);
		const [reversed] = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.creatorId, creatorId));
		expect(reversed.reversedAt).not.toBeNull();
	});

	it("🚨 a dispute on a purchase nets the row's EARNINGS, not the buyer's charge", async () => {
		const { userId: creatorId } = await makeCreator();
		const buyer = await createAccount(`${tag}_buyer_d`);
		madeUserIds.push(buyer.userId);
		const work = await insertWork({
			creatorId,
			type: "game",
			title: `Netting work ${uid()}`,
		});
		const purchase = await completedPurchase(creatorId, buyer.userId, work.id, "4.55");

		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				stripePaymentIntentId: purchase.stripePaymentIntentId,
				amount: "5.45", // the buyer's full charge — what must NOT be netted
				currency: "usd",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();

		await recordNettingForDispute(disputeRow, purchase, new Date());

		const rows = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.disputeId, disputeRow.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].amount).toBe("4.55"); // the creator's earnings, never the charge
		expect(rows[0].creatorId).toBe(creatorId);
	});

	it("is idempotent on the dispute — a redelivered event writes one row", async () => {
		const { userId: creatorId } = await makeCreator();
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "5.00",
				processingFee: "0.00",
				creatorEarnings: "5.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "5.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();

		await recordNettingForDispute(disputeRow, purchase, new Date());
		await recordNettingForDispute(disputeRow, purchase, new Date());

		expect(
			(await db.select().from(creatorNettings).where(eq(creatorNettings.disputeId, disputeRow.id)))
				.length,
		).toBe(1);
	});

	it("🚨 a refund whose transfer reversal recovered the share writes NO netting row", async () => {
		const { userId: creatorId } = await makeCreator();
		const buyer = await createAccount(`${tag}_buyer_r1`);
		madeUserIds.push(buyer.userId);
		const work = await insertWork({
			creatorId,
			type: "game",
			title: `Netting work ${uid()}`,
		});
		const purchase = await completedPurchase(creatorId, buyer.userId, work.id);

		// The before-transfer case: the reversal is present, the share came back at Stripe.
		refundReversal = { id: `trr_${uid()}`, object: "transfer_reversal", amount: 455 };
		await refundPurchase(purchase, { initiator: "buyer", reason: "test" });

		expect(
			(await db.select().from(creatorNettings).where(eq(creatorNettings.purchaseId, purchase.id)))
				.length,
		).toBe(0);
	});

	it("🚨 a refund whose reversal is absent — the paid-out creator — writes one", async () => {
		const { userId: creatorId } = await makeCreator();
		const buyer = await createAccount(`${tag}_buyer_r2`);
		madeUserIds.push(buyer.userId);
		const work = await insertWork({
			creatorId,
			type: "game",
			title: `Netting work ${uid()}`,
		});
		const purchase = await completedPurchase(creatorId, buyer.userId, work.id);

		// The after-transfer case: no reversal came back — the connected balance could not
		// fund it, and netting takes the recovery.
		refundReversal = null;
		await refundPurchase(purchase, { initiator: "buyer", reason: "test" });

		const rows = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.purchaseId, purchase.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].amount).toBe("4.55");
		expect(rows[0].stripeRefundId).toBeTruthy();
	});
});

describe("applying netting at the transfer step", () => {
	it("🚨 netting exceeds held → nothing transfers, netting stays open, never below zero", async () => {
		const { userId: creatorId } = await makeCreator();
		const held = await credit(creatorId, "3.00");
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "10.00",
				processingFee: "0.00",
				creatorEarnings: "10.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "10.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		// The set closed (a money question was asked and answered) — but with a
		// zero-sum row, and NO Stripe call: nothing moved.
		expect(creators).toBe(1);
		expect(fake.calls.filter((c) => c.method === "transfers.create")).toHaveLength(0);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("0.00");

		// The netting consumed the 3.00 that was held — the recovery is recorded, and
		// never an account debit for the 7.00 it could not reach.
		const nettingRow = (
			await db.select().from(creatorNettings).where(eq(creatorNettings.disputeId, disputeRow.id))
		)[0];
		const [application] = await db
			.select()
			.from(creatorNettingApplications)
			.where(eq(creatorNettingApplications.nettingId, nettingRow.id));
		expect(application.creditId).toBe(held);
		expect(application.amount).toBe("3.00");
		// The row is still open (10.00 − 3.00 remains), and there is no bill: the next run
		// derives the same 7.00 remainder against whatever is held then.
		expect(nettingRow.reversedAt).toBeNull();
		const open = await nettingPlanFor(creatorId, []);
		expect(open.sum.toFixed(2)).toBe("0.00"); // nothing held to apply against
	});

	it("🚨 netting never pushes below zero — a mixed set's negative sum floors at the zero-sum close", async () => {
		const { userId: creatorId } = await makeCreator();
		await credit(creatorId, "3.00");
		await credit(creatorId, "-1.00"); // a correction in the held set
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "10.00",
				processingFee: "0.00",
				creatorEarnings: "10.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "10.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());

		// Netting consumes the 3.00 credit (a netting never consumes a negative credit —
		// that would be a bill by another name), leaving the -1.00 correction and a plan
		// sum of -1.00 BEFORE the floor. The floor is the invariant: no negative sum ever
		// reaches Stripe, and the set closes as zero.
		const plan = await nettingPlanFor(creatorId, [
			{ id: 1, amount: "3.00" },
			{ id: 2, amount: "-1.00" },
		]);
		expect(plan.sum.toFixed(2)).toBe("0.00");
		expect(plan.applications).toHaveLength(1);
		expect(plan.applications[0].amount).toBe("3.00");

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		// Closed with no Stripe call, never a negative transfer.
		expect(creators).toBe(1);
		expect(fake.calls.filter((c) => c.method === "transfers.create")).toHaveLength(0);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("0.00");
	});

	it("🚨 partial netting → reduced transfer, application rows", async () => {
		const { userId: creatorId } = await makeCreator();
		const held = await credit(creatorId, "10.00");
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "4.00",
				processingFee: "0.00",
				creatorEarnings: "4.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "4.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());

		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		expect(creators).toBe(1);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("6.00"); // 10.00 held − 4.00 netted

		// The application row names the credit and the amount consumed.
		const [application] = await db
			.select()
			.from(creatorNettingApplications)
			.where(
				eq(
					creatorNettingApplications.nettingId,
					(
						await db
							.select()
							.from(creatorNettings)
							.where(eq(creatorNettings.disputeId, disputeRow.id))
					)[0].id,
				),
			);
		expect(application.creditId).toBe(held);
		expect(application.amount).toBe("4.00");

		// And a re-run moves nothing more.
		const again = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(again.creators).toBe(0);
	});

	it("🚨 the crash window holds — a retry neither double-transfers nor double-nets", async () => {
		const { userId: creatorId } = await makeCreator();
		const id = await credit(creatorId, "12.00");
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "5.00",
				processingFee: "0.00",
				creatorEarnings: "5.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "5.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());

		// Crash after Stripe accepts, before the DB write — the transaction that would
		// have written the transfer row, the coverage rows AND the netting application
		// rows (they are one decision now) never lands.
		const originalTransaction = db.transaction.bind(db);
		let crashOnce = true;
		// biome-ignore lint/suspicious/noExplicitAny: a test seam — the sabotage swaps the method out and puts it back.
		(db as any).transaction = async () => {
			if (crashOnce) {
				crashOnce = false;
				throw new Error("simulated crash after the Stripe call, before the DB write");
			}
		};
		try {
			await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		} finally {
			// biome-ignore lint/suspicious/noExplicitAny: put the seam back.
			(db as any).transaction = originalTransaction;
		}

		// The crash left Stripe's yes and no rows — the money moved at Stripe, the
		// coverage set is still "uncovered" here, and the netting never applied.
		expect(await transfersFor(creatorId)).toHaveLength(0);

		// The retry: same credits, same still-unapplied netting, same post-netting
		// amount, SAME key — one transfer at Stripe, and netting applied exactly once.
		const { creators } = await transferHeldCredits({ creatorId, now: AT_15_DAYS });
		expect(creators).toBe(1);
		expect(fake.created()).toBe(1);
		const [row] = await transfersFor(creatorId);
		expect(row.amount).toBe("7.00");

		// And netting applied exactly once.
		const nettingRow = (
			await db.select().from(creatorNettings).where(eq(creatorNettings.disputeId, disputeRow.id))
		)[0];
		const applications = await db
			.select()
			.from(creatorNettingApplications)
			.where(eq(creatorNettingApplications.nettingId, nettingRow.id));
		expect(applications).toHaveLength(1);
		expect(applications[0].amount).toBe("5.00");
		expect(applications[0].creditId).toBe(id);
	});
});

describe("a won dispute reverses the netting", () => {
	it("🚨 nothing applied — the row is canceled, no compensation", async () => {
		const { userId: creatorId } = await makeCreator();
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "5.00",
				processingFee: "0.00",
				creatorEarnings: "5.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "5.00",
				reason: "fraudulent",
				status: "won",
				outcome: "won",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());

		await reverseNettingForWonDispute(disputeRow.id, new Date());
		// A redelivered close is a no-op.
		await reverseNettingForWonDispute(disputeRow.id, new Date());

		const [row] = await db
			.select()
			.from(creatorNettings)
			.where(eq(creatorNettings.disputeId, disputeRow.id));
		expect(row.reversedAt).not.toBeNull();
		// No compensation: nothing was recovered, so nothing is owed back.
		const compensations = await db
			.select()
			.from(creatorCredits)
			.where(
				and(eq(creatorCredits.creatorId, creatorId), eq(creatorCredits.kind, "netting_reversal")),
			);
		expect(compensations).toHaveLength(0);
	});

	it("🚨 some applied — the applications reverse and the compensating credit hands it back", async () => {
		const { userId: creatorId } = await makeCreator();
		await credit(creatorId, "10.00");
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "4.00",
				processingFee: "0.00",
				creatorEarnings: "4.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "4.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());

		// The netting consumed 4.00 of the held credit.
		await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		await reverseNettingForWonDispute(disputeRow.id, new Date());

		const nettingRow = (
			await db.select().from(creatorNettings).where(eq(creatorNettings.disputeId, disputeRow.id))
		)[0];
		expect(nettingRow.reversedAt).not.toBeNull();

		// The application reversed: it no longer counts as recovery.
		const [application] = await db
			.select()
			.from(creatorNettingApplications)
			.where(eq(creatorNettingApplications.nettingId, nettingRow.id));
		expect(application.reversedAt).not.toBeNull();

		// The compensating credit: exactly what was applied, back to the creator.
		const [compensation] = await db
			.select()
			.from(creatorCredits)
			.where(
				and(eq(creatorCredits.creatorId, creatorId), eq(creatorCredits.kind, "netting_reversal")),
			);
		expect(compensation.amount).toBe("4.00");
	});
});

describe("the creator's earnings surface", () => {
	it("🚨 shows what was recovered and what is still open", async () => {
		const { userId: creatorId, cookie: creatorCookie } = await makeCreator();
		await credit(creatorId, "10.00");
		const [purchase] = await db
			.insert(purchases)
			.values({
				creatorId,
				workTitle: "x",
				type: "digital",
				amount: "4.00",
				processingFee: "0.00",
				creatorEarnings: "4.00",
				stripePaymentIntentId: `pi_${uid()}`,
				status: "disputed",
			})
			.returning();
		const [disputeRow] = await db
			.insert(disputes)
			.values({
				stripeDisputeId: `dp_${uid()}`,
				stripeChargeId: `ch_${uid()}`,
				amount: "4.00",
				reason: "fraudulent",
				status: "needs_response",
				purchaseId: purchase.id,
			})
			.returning();
		await recordNettingForDispute(disputeRow, purchase, new Date());
		await transferHeldCredits({ creatorId, now: AT_15_DAYS });

		const res = await app.fetch(
			new Request("http://localhost/api/subscriptions/earnings", {
				headers: { Cookie: creatorCookie },
			}),
		);
		const body = (await res.json()) as { nettedTotal: string; nettingOpenTotal: string };
		// 4.00 recovered; nothing open remains.
		expect(body.nettedTotal).toBe("4.00");
		expect(body.nettingOpenTotal).toBe("0.00");
	});
});
