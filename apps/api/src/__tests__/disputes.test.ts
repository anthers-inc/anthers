// SPDX-License-Identifier: Apache-2.0
/**
 * Disputes — recording a chargeback, and what it does to the buyer's access.
 *
 * The rules under test are settled in two places, neither negotiable from here: the
 * never-contest posture (Parker, 2026-09-14 — the money is gone the moment the dispute
 * lands) and the access decision (Parker, 2026-10-02 — a dispute revokes the buyer's
 * access to the purchased Work, and a won or withdrawn dispute restores it). The scope of
 * this layer is in `services/disputes.ts`'s docblock: record + revoke, never net, never
 * contest.
 *
 * What is worth pinning here, because every one of these fails silently:
 *
 *   • the purchase row flipping `completed → disputed`, which is the *whole* revocation
 *     (`resolveAccess` counts only `completed`) — and `completed` coming back on a win.
 *   • the invoice path keeping its existing behavior (`status → disputed`, no purchase flip).
 *   • idempotency on the Stripe dispute id: Stripe redelivers, and a redelivery must be
 *     one row and no double effect.
 *   • a dispute on a charge Anthers has no purchase and no invoice for still writing its
 *     row, nulls intact — a chargeback is a record of money that left whether or not we
 *     know what it was for.
 *   • the dispute-activity ratio: the numerator skips `warning_*` (radar, not a dispute
 *     that landed) and the denominator counts successful payments, returning null rather
 *     than 0% on an empty window.
 *
 * Like `refunds.test.ts`, nothing here reaches the network: `webhooks` is a real Stripe
 * instance so signature verification runs genuine HMAC, and everything else is a stub —
 * the dispute path makes no processor call at all, which is itself the point (the webhook
 * payload carries the full dispute object).
 *
 * Verified by sabotage before being committed, with predicted counts:
 *   • stubbing the purchase status flip to a no-op failed **4** (the flip, the redelivery's
 *     status assertion, the win's and the loss's mid-assertions) — predicted 4, observed 4;
 *   • removing the created insert's conflict guard failed **1** (the redelivery test, on
 *     the unique constraint) — predicted 1, observed 1;
 *   • dropping the win-restore's `disputed` predicate failed **1** (the refunded purchase
 *     was resurrected) — predicted 1, observed 1.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { disputes, invoices, purchases, users, works } from "@anthers/db/schema";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { resolveAccess } from "../services/access.js";
import { disputeActivityRatio } from "../services/disputes.js";
import { refundsAfterDownloadInWindow } from "../services/refunds.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const WEBHOOK_SECRET = "whsec_test_secret_for_dispute_signatures";
const FAKE_KEY = "sk_test_fake_no_network";

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * A dispute as Stripe delivers it in a `charge.dispute.*` event. Shaped by hand on
 * purpose: the fixture carries exactly the fields the service reads, so a field the
 * service *started* reading shows up here as a type error rather than as a silent
 * default. `evidence_details.due_by` is a Unix timestamp; the service converts.
 */
function stripeDispute(opts: {
	id: string;
	intentId: string;
	amountCents?: number;
	status?: string;
	reason?: string;
	dueBy?: number | null;
}) {
	return {
		id: opts.id,
		object: "dispute",
		amount: opts.amountCents ?? 500,
		charge: `ch_${uid()}`,
		created: Math.floor(Date.now() / 1000),
		currency: "usd",
		payment_intent: opts.intentId,
		reason: opts.reason ?? "fraudulent",
		status: opts.status ?? "needs_response",
		evidence_details: { due_by: opts.dueBy === undefined ? 1_800_000_000 : opts.dueBy },
	};
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

/** POST a webhook with a real signature, and deliberately no Origin header. */
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

const signer = new Stripe(FAKE_KEY);
const run = crypto.randomUUID().slice(0, 8);
const creatorName = `dp_cr_${run}`;
const buyerName = `dp_buy_${run}`;
const supporterName = `dp_sup_${run}`;

const PRICE = "5.00";
const FOR_SALE = [{ threshold: 0, allow: true, price: PRICE }];

let realClient: Stripe | null;
let previousWebhookSecret: string | undefined;
let creatorId: number;
let buyerId: number;
let supporterId: number;
let workId: number;
/** The highest `disputes.id` before this suite ran — everything above is ours to take. */
let disputeWater = 0;

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const account = await createAccount(username);
	const [row] = await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.email, `${username}@example.com`))
		.returning({ id: users.id });
	return { cookie: account.cookie, id: row.id };
}

/** The Work row `resolveAccess` needs, loadable without a route call. */
async function workForAccess() {
	const [work] = await db.select().from(works).where(eq(works.id, workId)).limit(1);
	return work;
}

/** A completed purchase of the fixture Work on a fresh PaymentIntent. */
async function completedPurchase(status = "completed") {
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId,
			workId,
			creatorId,
			workTitle: "Dispute work",
			workType: "game",
			workPublicId: null,
			type: "digital",
			amount: PRICE,
			processingFee: "0.45",
			deliveryFee: "0.00",
			crfFee: "0.00",
			creatorEarnings: "4.55",
			stripePaymentIntentId: `pi_${uid()}`,
			status,
		})
		.returning();
	return row;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${buyerName}@example.com`}`, sql`${`${supporterName}@example.com`}`], sql`, `)})`,
	);

	// The dispute path makes no processor call, so no fake client is needed — but the
	// webhook route's `paymentsConfigured()` guard runs before any handler, so *some*
	// client must be present. A bare instance is enough; nothing reaches it.
	realClient = getStripe();
	setStripeClient(new Stripe(FAKE_KEY));
	previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
	process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

	({ id: creatorId } = await signUp(creatorName));
	({ id: buyerId } = await signUp(buyerName));
	({ id: supporterId } = await signUp(supporterName));

	const work = await insertWork({
		creatorId,
		type: "game",
		title: `Dispute work ${run}`,
		streamEnabled: false,
		downloadEnabled: true,
		access: FOR_SALE,
	});
	workId = work.id;

	const [tallest] = await db
		.select({ id: disputes.id })
		.from(disputes)
		.orderBy(sql`${disputes.id} DESC`)
		.limit(1);
	disputeWater = tallest?.id ?? 0;
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	setStripeClient(realClient);
	if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
	else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
	// The dispute rows are swept with the accounts — `disputes.user_id` is `set null`, so
	// purging the account would orphan them. Taken by high-water mark first, then the
	// accounts, the same shape `purgeAccountsCreatedHere` uses.
	const fixtureDisputes = await db
		.select({ id: disputes.id })
		.from(disputes)
		.where(sql`${disputes.id} > ${disputeWater}`);
	if (fixtureDisputes.length > 0) {
		await db.delete(disputes).where(
			sql`${disputes.id} IN (${sql.join(
				fixtureDisputes.map((d) => sql`${d.id}`),
				sql`, `,
			)})`,
		);
	}
	await db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${buyerName}@example.com`}`, sql`${`${supporterName}@example.com`}`], sql`, `)})`,
	);
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Webhook: charge.dispute.created", () => {
	it("records a purchase dispute and revokes the buyer's access", async () => {
		const purchase = await completedPurchase();
		const dispute = stripeDispute({
			id: `dp_${uid()}`,
			intentId: purchase.stripePaymentIntentId,
		});
		expect((await sendWebhook(stripeEvent("charge.dispute.created", dispute))).status).toBe(200);

		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.status).toBe("disputed");

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, dispute.id));
		expect(record).toBeDefined();
		expect(record.purchaseId).toBe(purchase.id);
		expect(record.invoiceId).toBeNull();
		expect(record.userId).toBe(buyerId);
		expect(record.stripeChargeId).toBe(dispute.charge);
		expect(record.stripePaymentIntentId).toBe(purchase.stripePaymentIntentId);
		expect(new Decimal(record.amount).toFixed(2)).toBe("5.00");
		expect(record.reason).toBe("fraudulent");
		expect(record.status).toBe("needs_response");
		expect(record.outcome).toBeNull();
		expect(record.evidenceDueBy?.getTime()).toBe(1_800_000_000 * 1000);

		// The revocation, asserted through the resolver that enforces it rather than
		// through the status column alone — the flip only matters because
		// `resolveAccess` counts `completed`.
		const work = await workForAccess();
		const access = await resolveAccess(work, buyerId);
		expect(access.canAccess).toBe(false);
		expect(access.reason).toBe("payment_required");

		// And the creator is untouched by the flip: they reach their own work.
		expect((await resolveAccess(work, creatorId)).canAccess).toBe(true);
	});

	it("records a support dispute and marks the invoice, without touching any purchase", async () => {
		const intentId = `pi_${uid()}`;
		const [invoice] = await db
			.insert(invoices)
			.values({
				userId: supporterId,
				stripeInvoiceId: `in_${uid()}`,
				stripePaymentIntentId: intentId,
				billingCycle: "2026-10-01",
				status: "paid",
				subtotal: "6.00",
				tax: "0.00",
				total: "6.00",
				processingFee: "0.45",
			})
			.returning();

		const before = await db.select().from(purchases).where(eq(purchases.buyerId, buyerId));
		const dispute = stripeDispute({ id: `dp_${uid()}`, intentId, amountCents: 600 });
		expect((await sendWebhook(stripeEvent("charge.dispute.created", dispute))).status).toBe(200);

		const [row] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
		expect(row.status).toBe("disputed");

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, dispute.id));
		expect(record).toBeDefined();
		expect(record.invoiceId).toBe(invoice.id);
		expect(record.purchaseId).toBeNull();
		expect(record.userId).toBe(supporterId);
		expect(new Decimal(record.amount).toFixed(2)).toBe("6.00");

		// No purchase was flipped: the buyer's rows are exactly what they were.
		const after = await db.select().from(purchases).where(eq(purchases.buyerId, buyerId));
		expect(after).toHaveLength(before.length);
		const statusOf = new Map(before.map((b) => [b.id, b.status] as const));
		for (const row of after) expect(row.status).toBe(statusOf.get(row.id) ?? "");
	});

	it("is idempotent across a redelivery — one row, no double effect", async () => {
		const purchase = await completedPurchase();
		const dispute = stripeDispute({
			id: `dp_${uid()}`,
			intentId: purchase.stripePaymentIntentId,
		});
		const event = stripeEvent("charge.dispute.created", dispute);
		expect((await sendWebhook(event)).status).toBe(200);
		expect((await sendWebhook(event)).status).toBe(200);

		const rows = await db.select().from(disputes).where(eq(disputes.stripeDisputeId, dispute.id));
		expect(rows).toHaveLength(1);

		// And a purchase already flipped is not flipped anywhere else — the status is a
		// single value, not a counter.
		const [purchaseRow] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(purchaseRow.status).toBe("disputed");
	});

	it("records a dispute on a charge that matches nothing, with nulls and no crash", async () => {
		const dispute = stripeDispute({ id: `dp_${uid()}`, intentId: `pi_${uid()}` });
		expect((await sendWebhook(stripeEvent("charge.dispute.created", dispute))).status).toBe(200);

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, dispute.id));
		expect(record).toBeDefined();
		expect(record.purchaseId).toBeNull();
		expect(record.invoiceId).toBeNull();
		expect(record.userId).toBeNull();
		expect(record.stripePaymentIntentId).toBe(dispute.payment_intent as string);
	});

	it("does not flip a purchase that was refunded before the dispute arrived", async () => {
		// The `completed` predicate is the latch: a refunded row is left alone, so the
		// dispute record does not overwrite a state a person already acted on.
		const purchase = await completedPurchase("refunded");
		const dispute = stripeDispute({
			id: `dp_${uid()}`,
			intentId: purchase.stripePaymentIntentId,
		});
		expect((await sendWebhook(stripeEvent("charge.dispute.created", dispute))).status).toBe(200);

		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.status).toBe("refunded");

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, dispute.id));
		expect(record.status).toBe("needs_response");
	});
});

describe("Webhook: charge.dispute.closed", () => {
	it("restores the purchase on a won dispute — the buyer keeps the Work", async () => {
		const purchase = await completedPurchase();
		const disputeId = `dp_${uid()}`;

		await sendWebhook(
			stripeEvent(
				"charge.dispute.created",
				stripeDispute({
					id: disputeId,
					intentId: purchase.stripePaymentIntentId,
				}),
			),
		);
		let [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.status).toBe("disputed");

		expect(
			(
				await sendWebhook(
					stripeEvent(
						"charge.dispute.closed",
						stripeDispute({
							id: disputeId,
							intentId: purchase.stripePaymentIntentId,
							status: "won",
							dueBy: null,
						}),
					),
				)
			).status,
		).toBe(200);

		[row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.status).toBe("completed");

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, disputeId));
		expect(record.status).toBe("won");
		expect(record.outcome).toBe("won");
		expect(record.evidenceDueBy).toBeNull();

		// And access is back, through the resolver that took it away.
		const work = await workForAccess();
		expect((await resolveAccess(work, buyerId)).canAccess).toBe(true);
	});

	it("leaves the purchase disputed on a lost dispute", async () => {
		const purchase = await completedPurchase();
		const disputeId = `dp_${uid()}`;

		await sendWebhook(
			stripeEvent(
				"charge.dispute.created",
				stripeDispute({
					id: disputeId,
					intentId: purchase.stripePaymentIntentId,
				}),
			),
		);
		expect(
			(
				await sendWebhook(
					stripeEvent(
						"charge.dispute.closed",
						stripeDispute({
							id: disputeId,
							intentId: purchase.stripePaymentIntentId,
							status: "lost",
							dueBy: null,
						}),
					),
				)
			).status,
		).toBe(200);

		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.status).toBe("disputed");

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, disputeId));
		expect(record.status).toBe("lost");
		expect(record.outcome).toBe("lost");
	});

	it("records a close for a dispute whose created event never arrived", async () => {
		const disputeId = `dp_${uid()}`;
		const intentId = `pi_${uid()}`;
		expect(
			(
				await sendWebhook(
					stripeEvent(
						"charge.dispute.closed",
						stripeDispute({
							id: disputeId,
							intentId,
							status: "lost",
							dueBy: null,
						}),
					),
				)
			).status,
		).toBe(200);

		const [record] = await db
			.select()
			.from(disputes)
			.where(eq(disputes.stripeDisputeId, disputeId));
		expect(record).toBeDefined();
		expect(record.outcome).toBe("lost");
		expect(record.status).toBe("lost");
	});

	it("does not resurrect a purchase that was refunded after the dispute", async () => {
		// The restore's `disputed` predicate is its own latch: a purchase a person
		// refunded while the dispute was open stays refunded when the dispute is won.
		const purchase = await completedPurchase();
		const disputeId = `dp_${uid()}`;

		await sendWebhook(
			stripeEvent(
				"charge.dispute.created",
				stripeDispute({
					id: disputeId,
					intentId: purchase.stripePaymentIntentId,
				}),
			),
		);
		await db.update(purchases).set({ status: "refunded" }).where(eq(purchases.id, purchase.id));

		await sendWebhook(
			stripeEvent(
				"charge.dispute.closed",
				stripeDispute({
					id: disputeId,
					intentId: purchase.stripePaymentIntentId,
					status: "won",
					dueBy: null,
				}),
			),
		);

		const [row] = await db.select().from(purchases).where(eq(purchases.id, purchase.id));
		expect(row.status).toBe("refunded");
	});
});

describe("A disputed purchase and the refund cap", () => {
	it("does not consume the buyer's refund allowance", async () => {
		const purchase = await completedPurchase();
		const before = await refundsAfterDownloadInWindow(buyerId);
		await sendWebhook(
			stripeEvent(
				"charge.dispute.created",
				stripeDispute({
					id: `dp_${uid()}`,
					intentId: purchase.stripePaymentIntentId,
				}),
			),
		);
		const after = await refundsAfterDownloadInWindow(buyerId);
		expect(after).toBe(before);
	});
});

describe("Dispute-activity ratio", () => {
	it("counts disputes against successful payments in the window", async () => {
		const now = new Date();
		const start = new Date(now.getTime() - 1000);
		const end = new Date(now.getTime() + 1000);

		const purchase = await completedPurchase();
		await sendWebhook(
			stripeEvent(
				"charge.dispute.created",
				stripeDispute({
					id: `dp_${uid()}`,
					intentId: purchase.stripePaymentIntentId,
				}),
			),
		);

		const ratio = await disputeActivityRatio(start, end);
		expect(ratio).not.toBeNull();
		// At least one dispute over at least this window's successful payments. The
		// suite's other fixtures are inside the window too, so the exact figure is not
		// pinned — the null and the sign of the number are.
		expect(ratio?.greaterThan(0)).toBe(true);
	});

	it("returns null when the window holds no successful payments", async () => {
		const past = new Date("2020-01-01T00:00:00Z");
		const before = new Date("2020-01-31T00:00:00Z");
		expect(await disputeActivityRatio(past, before)).toBeNull();
	});
});
