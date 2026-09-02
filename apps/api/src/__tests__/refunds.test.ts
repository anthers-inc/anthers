// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Refunds — the reversal path, end to end.
 *
 * The rules under test are settled in two documents and neither is negotiable
 * from here: the accounting in `services/refunds.ts` (reverse the creator to exactly
 * their earnings, let the remainder absorb the sunk card fee) and the policy in
 * Terms of Service § Refunds (refunds *after download* are automatic for the first three in
 * any twelve months; platform-initiated refunds don't count).
 *
 * What is actually worth pinning here is the money and the counting, because
 * every one of these is a failure that moves real dollars and shows no error:
 *
 *   • the parameters we hand Stripe — `reverse_transfer` on, application-fee
 *     refund *off*. Those two are the whole reversal, and the second is the easy
 *     one to "fix" wrongly: on a destination charge it would pay the retained
 *     sales tax to the creator on a sale that no longer exists.
 *   • the ledger entry, which is the only record that the remainder absorbed
 *     anything. A refund that moves money silently is the same class of bug as
 *     the gross-vs-net one that ran uncovered until 2026-08-08.
 *   • the cap arithmetic, including the two populations it must NOT count.
 *   • idempotency from both doors at once — our route and the webhook Stripe
 *     fires for the refund that route just made.
 *
 * Like `payments-stripe.test.ts`, nothing here reaches the network: `webhooks` is
 * a real Stripe instance so signature verification runs genuine HMAC, and
 * everything else is a recording fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { assets, crfLedger, purchases, users } from "@anthers/db/schema";
import { REFUND_AUTO_CAP, REFUND_CAP_WINDOW_MONTHS } from "@anthers/shared/constants";
import { calculateFees } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { markPurchaseDownloaded, refundsAfterDownloadInWindow } from "../services/refunds";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const WEBHOOK_SECRET = "whsec_test_secret_for_refund_signatures";
const FAKE_KEY = "sk_test_fake_no_network";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

// ── The fake Stripe client ───────────────────────────────────────────────────

interface Call {
	method: string;
	args: unknown[];
}

function fakeStripe() {
	const calls: Call[] = [];
	const failures: Record<string, Error | undefined> = {};
	const real = new Stripe(FAKE_KEY);

	const record =
		(method: string, fallback: (...args: never[]) => unknown) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			const failure = failures[method];
			if (failure) return Promise.reject(failure);
			return Promise.resolve((fallback as (...a: unknown[]) => unknown)(...args));
		};

	const client = {
		webhooks: real.webhooks,
		refunds: {
			create: record("refunds.create", () => ({ id: `re_${uid()}` })),
		},
	} as unknown as Stripe;

	return {
		client,
		calls,
		failures,
		callsTo: (method: string) => calls.filter((c) => c.method === method),
		lastCall: (method: string) => calls.filter((c) => c.method === method).at(-1),
		reset: () => {
			calls.length = 0;
			for (const k of Object.keys(failures)) delete failures[k];
		},
	};
}

type Fake = ReturnType<typeof fakeStripe>;

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
	return req("/api/payments/stripe/webhook", {
		method: "POST",
		headers: { "Content-Type": "application/json", "stripe-signature": signature },
		body,
	});
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const signer = new Stripe(FAKE_KEY);
const run = crypto.randomUUID().slice(0, 8);
const creatorName = `ref_creator_${run}`;
const buyerName = `ref_buyer_${run}`;
const otherName = `ref_other_${run}`;

const PRICE = "5.00";
/**
 * 2 GiB of downloadable asset. It made the delivery deduction non-zero until that
 * deduction was retired 2026-08-12; kept so the fixture is a realistic Work.
 */
const ASSET_BYTES = 2 * 1024 * 1024 * 1024;
const FOR_SALE = [{ threshold: 0, allow: true, price: PRICE }];
const _LOCKED = [{ threshold: 0, allow: false, price: "0" }];

const fees = calculateFees(new Decimal(PRICE), { type: "digital" });

let fake: Fake;
let realClient: Stripe | null;
let previousWebhookSecret: string | undefined;

let buyerCookie: string;
let otherCookie: string;
let creatorId: number;
let buyerId: number;
let otherId: number;

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const res = await req("/api/auth/sign-up", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify({
			username,
			email: `${username}@example.com`,
			password: "testpass123",
			acceptTerms: true,
		}),
	});
	expect(res.status).toBe(201);
	const cookie = res.headers.get("Set-Cookie")?.split(";")[0] as string;
	const [row] = await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.username, username))
		.returning({ id: users.id });
	return { cookie, id: row.id };
}

/** A released, download-only Work for sale, with a real-sized asset behind it. */
async function makeWork(title: string): Promise<number> {
	const work = await insertWork({
		creatorId,
		type: "game",
		title,
		streamEnabled: false,
		downloadEnabled: true,
		seedAccess: FOR_SALE,
	});
	await db.insert(assets).values({
		workId: work.id,
		file: `creators/${creatorId}/builds/${uid()}.zip`,
		filename: `${uid()}.zip`,
		fileSize: ASSET_BYTES,
	});
	return work.id;
}

/**
 * A completed purchase of a fresh Work.
 *
 * A fresh Work every time on purpose: a completed purchase is permanent access,
 * so reusing one across cases makes later checkouts and later refunds interact
 * through `resolveAccess` in ways that read as findings and aren't.
 */
async function completedPurchase(
	opts: {
		buyer?: number;
		downloadedAt?: Date | null;
		type?: string;
		workId?: number | null;
		/**
		 * A pre-2026-08-12 purchase, which really did carry the first download's
		 * delivery at $0.01/GiB. New sales record "0.00" — delivery is free — but the
		 * refund path still reads this column off the ROW, because those rows exist and
		 * their books have to close the same way they were opened.
		 */
		deliveryFee?: string;
	} = {},
) {
	const workId = opts.workId === undefined ? await makeWork(`Refund work ${uid()}`) : opts.workId;
	const [row] = await db
		.insert(purchases)
		.values({
			buyerId: opts.buyer ?? buyerId,
			workId,
			creatorId,
			workTitle: `Refund work ${uid()}`,
			workType: "game",
			workPublicId: null,
			type: opts.type ?? "digital",
			amount: PRICE,
			processingFee: fees.processingFee.toFixed(2),
			deliveryFee: opts.deliveryFee ?? fees.deliveryFee.toFixed(2),
			crfFee: "0.00",
			salesTax: fees.salesTax.toFixed(2),
			creatorEarnings: fees.creatorEarnings.toFixed(2),
			stripePaymentIntentId: `pi_${uid()}`,
			status: "completed",
			downloadedAt: opts.downloadedAt ?? null,
		})
		.returning();
	return row;
}

/** Refund via the buyer-facing route. */
function refundAs(cookie: string, purchaseId: number, reason?: string) {
	return req(`/api/payments/purchases/${purchaseId}/refund`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
		body: JSON.stringify(reason ? { reason } : {}),
	});
}

async function ledgerFor(purchaseId: number) {
	return db.select().from(crfLedger).where(eq(crfLedger.purchaseId, purchaseId));
}

async function reload(id: number) {
	const [row] = await db.select().from(purchases).where(eq(purchases.id, id)).limit(1);
	return row;
}

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${otherName})`,
	);

	realClient = getStripe();
	fake = fakeStripe();
	setStripeClient(fake.client);
	previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
	process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

	({ id: creatorId } = await signUp(creatorName));
	({ cookie: buyerCookie, id: buyerId } = await signUp(buyerName));
	({ cookie: otherCookie, id: otherId } = await signUp(otherName));
}, DB_SETUP_TIMEOUT);

beforeEach(async () => {
	fake.reset();
	// The cap is counted across a buyer's whole history, so a test that leaves
	// refunded rows behind silently changes the arithmetic of every later one.
	await db.delete(purchases).where(eq(purchases.buyerId, buyerId));
	await db.delete(purchases).where(eq(purchases.buyerId, otherId));
});

afterAll(async () => {
	setStripeClient(realClient);
	if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
	else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${otherName})`,
	);
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refunding one item out of a basket.
 *
 * 🚨 **"Full refunds only" means full refunds of an ITEM, not of a charge** (Parker,
 * 2026-08-13). A basket puts several independent purchases on one PaymentIntent; the
 * buyer chose each of them separately and refunding one must not return the others.
 *
 * The reversal lands exactly right by arithmetic rather than luck: `reverse_transfer` on
 * a partial refund reverses *proportionally*, and because the card fee and the tax are
 * both apportioned pro-rata by item value, that proportion resolves to precisely the
 * row's own recorded earnings.
 *
 * Verified by sabotage, with measured counts: re-adding the sibling settling loop fails
 * **2**, and dropping the explicit `amount` fails **1**.
 *
 * ⚠️ That second number is worth understanding rather than raising. Dropping the `amount`
 * asks Stripe for the whole charge, and only the parameter assertion notices — the fake
 * does not simulate Stripe's side effects, so the sibling ROWS stay `completed` either
 * way. What we control and can assert is the request; what the money then does is
 * Stripe's, and no fake can prove it. Same limit the file header states for the
 * destination charge.
 */
describe("A basket refunds one item at a time", () => {
	/** Three purchases on ONE PaymentIntent, apportioned the way checkout writes them. */
	async function basketOfThree() {
		const intent = `pi_basket_${uid()}`;
		const unit = new Decimal("1.00");
		const subtotal = unit.times(3);
		const whole = calculateFees(subtotal, { type: "digital" });
		const rows = [];
		for (let i = 0; i < 3; i++) {
			const share = (t: Decimal) => t.dividedBy(3).toDecimalPlaces(2);
			const [row] = await db
				.insert(purchases)
				.values({
					buyerId,
					workId: await makeWork(`Basket work ${uid()}`),
					creatorId,
					workTitle: `Basket item ${i}`,
					workType: "audio",
					workPublicId: null,
					type: "digital",
					amount: unit.toFixed(2),
					processingFee: share(whole.processingFee).toFixed(2),
					deliveryFee: "0.00",
					crfFee: "0.00",
					salesTax: share(whole.salesTax).toFixed(2),
					creatorEarnings: unit.minus(share(whole.processingFee)).toFixed(2),
					stripePaymentIntentId: intent,
					status: "completed",
				})
				.returning();
			rows.push(row);
		}
		return rows;
	}

	it("refunds only that item's share of the charge", async () => {
		const rows = await basketOfThree();
		const res = await refundAs(buyerCookie, rows[0].id);
		expect(res.status).toBe(200);

		const params = fake.lastCall("refunds.create")?.args[0] as Stripe.RefundCreateParams;
		// The item's price plus its apportioned tax — what the buyer paid for THIS thing,
		// not what they paid for the basket.
		const expected = Math.round(
			new Decimal(rows[0].amount).plus(rows[0].salesTax).toNumber() * 100,
		);
		expect(params.amount).toBe(expected);
		expect(params.reverse_transfer).toBe(true);
		// A whole-charge refund would be three times this. Stated as an inequality so it
		// keeps meaning if the fixture's prices change.
		expect(params.amount).toBeLessThan(expected * 3);
	});

	it("leaves the other two purchases untouched, and still owned", async () => {
		const rows = await basketOfThree();
		await refundAs(buyerCookie, rows[0].id);

		expect((await reload(rows[0].id)).status).toBe("refunded");
		// The assertion this whole change exists for: the buyer keeps what they kept.
		expect((await reload(rows[1].id)).status).toBe("completed");
		expect((await reload(rows[2].id)).status).toBe("completed");
	});

	it("books only that item's share of the sunk card fee", async () => {
		const rows = await basketOfThree();
		await refundAs(buyerCookie, rows[0].id);

		const ledger = await ledgerFor(rows[0].id);
		expect(ledger).toHaveLength(1);
		// The shortfall is the row's apportioned processing, so refunding all three
		// would book the whole fee once — never three times over.
		expect(new Decimal(ledger[0].amount).negated().toFixed(2)).toBe(rows[0].processingFee);
		expect(await ledgerFor(rows[1].id)).toHaveLength(0);
	});

	it("still refunds a lone purchase in full, with no amount at all", async () => {
		const purchase = await completedPurchase();
		await refundAs(buyerCookie, purchase.id);
		const params = fake.lastCall("refunds.create")?.args[0] as Stripe.RefundCreateParams;
		// The long-tested path for the common case: no `amount` means the whole charge,
		// and there is no reason to move it onto the basket's arithmetic for symmetry.
		expect(params.amount).toBeUndefined();
	});
});

describe("The reversal we ask Stripe for", () => {
	it("reverses the creator's transfer and does NOT refund the application fee", async () => {
		const purchase = await completedPurchase();

		const res = await refundAs(buyerCookie, purchase.id);
		expect(res.status).toBe(200);

		const call = fake.lastCall("refunds.create");
		const params = call?.args[0] as Stripe.RefundCreateParams;
		expect(params.payment_intent).toBe(purchase.stripePaymentIntentId);

		// The creator is clawed back exactly their earnings — without this the refund
		// comes wholly out of the platform balance and the creator keeps money for a
		// sale that no longer exists.
		expect(params.reverse_transfer).toBe(true);

		// And the application fee is deliberately left alone. On a destination charge
		// it never left the platform (it was subtracted from the transfer), so
		// refunding it would push the retained sales tax and delivery TO the creator.
		// This assertion exists because setting it looks like a completeness fix.
		expect(params.refund_application_fee).toBeUndefined();

		expect(params.reason).toBe("requested_by_customer");
	});

	it("sends an idempotency key derived from the purchase, so a retry can't double-refund", async () => {
		const purchase = await completedPurchase();
		await refundAs(buyerCookie, purchase.id);

		const options = fake.lastCall("refunds.create")?.args[1] as { idempotencyKey?: string };
		expect(options?.idempotencyKey).toBe(`refund_purchase_${purchase.id}`);
	});

	it("leaves the purchase untouched when Stripe rejects the refund", async () => {
		const purchase = await completedPurchase();
		fake.failures["refunds.create"] = new Error("card_declined");

		const res = await refundAs(buyerCookie, purchase.id);
		expect(res.status).toBe(502);

		// The row must not claim a refund that never happened — that would revoke the
		// buyer's access AND leave them unpaid, the worst of both.
		expect((await reload(purchase.id)).status).toBe("completed");
		expect(await ledgerFor(purchase.id)).toHaveLength(0);
	});
});

describe("What the remainder absorbs", () => {
	it("books the sunk card fee against the charitable ledger, as a negative entry", async () => {
		const purchase = await completedPurchase({ downloadedAt: null });
		await refundAs(buyerCookie, purchase.id);

		const rows = await ledgerFor(purchase.id);
		expect(rows).toHaveLength(1);
		// Nothing was downloaded, so the delivery was never spent — booking it would
		// overstate the loss. Only Stripe's unreturned processing fee is real.
		expect(new Decimal(rows[0].amount).toFixed(2)).toBe(fees.processingFee.negated().toFixed(2));
		expect(new Decimal(rows[0].amount).isNegative()).toBe(true);
	});

	it("absorbs only the card fee on a current sale — delivery costs nothing to absorb", async () => {
		const purchase = await completedPurchase({ downloadedAt: new Date() });
		await refundAs(buyerCookie, purchase.id);

		const rows = await ledgerFor(purchase.id);
		expect(rows).toHaveLength(1);
		expect(new Decimal(rows[0].amount).toFixed(2)).toBe(fees.processingFee.negated().toFixed(2));
		// Downloading used to make the loss bigger; since 2026-08-12 it cannot, so the
		// downloaded and never-downloaded cases now book the same amount on a new sale.
		expect(fees.deliveryFee.toNumber()).toBe(0);
	});

	/**
	 * ⚠️ **A pre-2026-08-12 purchase still has to settle its own way.** Those rows
	 * carry a real `delivery_fee`, and `refunds.ts` reads the column off the row
	 * rather than recomputing it — which is the only reason their books still close.
	 * Recomputing from today's model would silently under-book every legacy refund by
	 * the delivery it actually paid for.
	 */
	it("still books a LEGACY delivery fee, when the row carries one and the bytes went out", async () => {
		const legacy = await completedPurchase({ downloadedAt: new Date(), deliveryFee: "0.02" });
		await refundAs(buyerCookie, legacy.id);

		const rows = await ledgerFor(legacy.id);
		expect(new Decimal(rows[0].amount).toFixed(2)).toBe(
			fees.processingFee.plus("0.02").negated().toFixed(2),
		);
	});

	it("returns a LEGACY delivery fee untouched when nothing was ever downloaded", async () => {
		const legacy = await completedPurchase({ downloadedAt: null, deliveryFee: "0.02" });
		await refundAs(buyerCookie, legacy.id);

		const rows = await ledgerFor(legacy.id);
		expect(new Decimal(rows[0].amount).toFixed(2)).toBe(fees.processingFee.negated().toFixed(2));
	});

	/**
	 * The refund has to balance: every cent the buyer gets back came from someone,
	 * and `services/refunds.ts` says exactly who. The creator gives back their earnings and nothing
	 * more; the sales tax was only ever held for the state and is returned intact;
	 * whatever is left over is what Anthers absorbs out of the remainder.
	 *
	 * The delivery fee used to be the interesting term, moving between the two cases:
	 * collected to pay for a download, returned untouched if none happened and absorbed
	 * as a real loss if one did. It is $0.00 on every new sale since 2026-08-12, so the
	 * two cases now balance identically — but the term stays in the arithmetic because
	 * legacy rows carry one, and the distinction it encodes is what the refund cap is
	 * built on.
	 */
	it.each([
		["never downloaded", null as Date | null],
		["already downloaded", new Date()],
	])("balances to the cent — %s", async (_label, downloadedAt) => {
		const purchase = await completedPurchase({ downloadedAt });
		await refundAs(buyerCookie, purchase.id);

		const buyerTotal = new Decimal(purchase.amount).plus(purchase.salesTax);
		const creatorReversed = new Decimal(purchase.creatorEarnings);
		const taxReturned = new Decimal(purchase.salesTax);
		// Bytes never sent are money never spent, so that delivery goes back to the
		// buyer with the rest; bytes already sent are gone and land in `absorbed`.
		const deliveryReturned = downloadedAt ? new Decimal(0) : new Decimal(purchase.deliveryFee);
		const absorbed = new Decimal((await ledgerFor(purchase.id))[0].amount).negated();

		expect(
			buyerTotal
				.minus(creatorReversed)
				.minus(taxReturned)
				.minus(deliveryReturned)
				.minus(absorbed)
				.toFixed(2),
		).toBe("0.00");

		// And the creator is never charged beyond what they were paid — the reversal
		// is their earnings exactly, which is what stops a refund becoming a cut.
		expect(absorbed.greaterThanOrEqualTo(new Decimal(purchase.processingFee))).toBe(true);
	});
});

describe("The purchase row after a refund", () => {
	it("flips to refunded, stamped with who asked", async () => {
		const purchase = await completedPurchase();
		await refundAs(buyerCookie, purchase.id, "Didn't run on my machine");

		const row = await reload(purchase.id);
		expect(row.status).toBe("refunded");
		expect(row.refundInitiator).toBe("buyer");
		expect(row.refundReason).toBe("Didn't run on my machine");
		expect(row.refundedAt).not.toBeNull();
		expect(row.stripeRefundId).toMatch(/^re_/);
	});

	it("revokes access, because resolveAccess counts only completed purchases", async () => {
		const workId = await makeWork(`Access revoke ${uid()}`);
		const purchase = await completedPurchase({ workId });
		const work = await workRow(workId);

		// Asserted through the ownership endpoint rather than re-derived here: it runs
		// the same resolver the delivery routes do, so this pins the property that
		// actually gates the bytes.
		const before = await req(`/api/payments/owns/${work.slug}`, {
			headers: { Cookie: buyerCookie },
		});
		expect((await before.json()).owns).toBe(true);

		await refundAs(buyerCookie, purchase.id);

		const after = await req(`/api/payments/owns/${work.slug}`, {
			headers: { Cookie: buyerCookie },
		});
		expect((await after.json()).owns).toBe(false);
	});

	it("is idempotent: a second request refunds nothing twice", async () => {
		const purchase = await completedPurchase();
		expect((await refundAs(buyerCookie, purchase.id)).status).toBe(200);

		const second = await refundAs(buyerCookie, purchase.id);
		const body = await second.json();
		expect(second.status).toBe(200);
		expect(body.alreadyRefunded).toBe(true);

		// One Stripe call, one ledger row — the second pass must not re-book the
		// shortfall against the remainder.
		expect(fake.callsTo("refunds.create")).toHaveLength(1);
		expect(await ledgerFor(purchase.id)).toHaveLength(1);
	});

	it("refuses a purchase that belongs to someone else, without confirming it exists", async () => {
		const purchase = await completedPurchase();
		const res = await refundAs(otherCookie, purchase.id);
		expect(res.status).toBe(404);
		expect(fake.callsTo("refunds.create")).toHaveLength(0);
	});

	it("refuses to refund a support top-up", async () => {
		// Support is a monthly commitment, not a purchase: the Terms say a cycle in
		// progress is not pro-rated, and unwinding one here would also strand the
		// account credit `applyCreditForPurchase` has already spent.
		const purchase = await completedPurchase({ type: "seeds", workId: null });
		const res = await refundAs(buyerCookie, purchase.id);
		expect(res.status).toBe(400);
		expect(fake.callsTo("refunds.create")).toHaveLength(0);
	});
});

describe("The cap on refunds after download", () => {
	/** Park `n` already-refunded, already-downloaded purchases in the window. */
	async function priorRefunds(n: number, opts: { initiator?: string; downloaded?: boolean } = {}) {
		for (let i = 0; i < n; i++) {
			const p = await completedPurchase({
				downloadedAt: opts.downloaded === false ? null : new Date(),
			});
			await db
				.update(purchases)
				.set({
					status: "refunded",
					refundedAt: new Date(),
					refundInitiator: opts.initiator ?? "buyer",
				})
				.where(eq(purchases.id, p.id));
		}
	}

	it(`allows the first ${REFUND_AUTO_CAP} and sends the next one to a human`, async () => {
		await priorRefunds(REFUND_AUTO_CAP);
		const purchase = await completedPurchase({ downloadedAt: new Date() });

		const res = await refundAs(buyerCookie, purchase.id);
		expect(res.status).toBe(409);
		expect((await res.json()).code).toBe("review_required");

		// Nothing was asked of Stripe, and the purchase is untouched — over the cap
		// is "a person looks at this", not "refused and reversed".
		expect(fake.callsTo("refunds.create")).toHaveLength(0);
		expect((await reload(purchase.id)).status).toBe("completed");
	});

	it("still refunds automatically one short of the cap", async () => {
		await priorRefunds(REFUND_AUTO_CAP - 1);
		const purchase = await completedPurchase({ downloadedAt: new Date() });

		expect((await refundAs(buyerCookie, purchase.id)).status).toBe(200);
	});

	it("does not count refunds of things that were never downloaded", async () => {
		// The cap bounds un-sendable bytes. Nothing was sent, so nothing is bounded —
		// and a buyer who refunds three undownloaded purchases keeps a full allowance.
		await priorRefunds(REFUND_AUTO_CAP, { downloaded: false });
		expect(await refundsAfterDownloadInWindow(buyerId)).toBe(0);

		const purchase = await completedPurchase({ downloadedAt: new Date() });
		expect((await refundAs(buyerCookie, purchase.id)).status).toBe(200);
	});

	it("does not count platform-initiated refunds against the buyer", async () => {
		// A takedown or a defect refunds someone who may well have downloaded. Making
		// that spend their allowance would charge them for our decision.
		await priorRefunds(REFUND_AUTO_CAP, { initiator: "platform" });
		expect(await refundsAfterDownloadInWindow(buyerId)).toBe(0);

		const purchase = await completedPurchase({ downloadedAt: new Date() });
		expect((await refundAs(buyerCookie, purchase.id)).status).toBe(200);
	});

	it("never caps a refund of something the buyer hasn't downloaded", async () => {
		await priorRefunds(REFUND_AUTO_CAP);
		const purchase = await completedPurchase({ downloadedAt: null });

		expect((await refundAs(buyerCookie, purchase.id)).status).toBe(200);
	});

	it("counts only within the rolling window", async () => {
		await priorRefunds(REFUND_AUTO_CAP);
		// Age every one of them out by a month more than the window.
		const stale = new Date();
		stale.setMonth(stale.getMonth() - (REFUND_CAP_WINDOW_MONTHS + 1));
		await db
			.update(purchases)
			.set({ refundedAt: stale })
			.where(and(eq(purchases.buyerId, buyerId), eq(purchases.status, "refunded")));

		expect(await refundsAfterDownloadInWindow(buyerId)).toBe(0);
		const purchase = await completedPurchase({ downloadedAt: new Date() });
		expect((await refundAs(buyerCookie, purchase.id)).status).toBe(200);
	});

	it("counts per buyer, not platform-wide", async () => {
		await priorRefunds(REFUND_AUTO_CAP);
		expect(await refundsAfterDownloadInWindow(otherId)).toBe(0);
	});

	it("reports the remaining allowance to the buyer", async () => {
		const purchase = await completedPurchase({ downloadedAt: new Date() });
		const body = await (await refundAs(buyerCookie, purchase.id)).json();
		expect(body.refundsRemaining).toBe(REFUND_AUTO_CAP - 1);
	});
});

describe("charge.refunded — the refund that didn't come through our route", () => {
	function charge(opts: { intent: string; refunded: boolean; refundId?: string }) {
		return {
			id: `ch_${uid()}`,
			object: "charge",
			payment_intent: opts.intent,
			refunded: opts.refunded,
			amount: 530,
			amount_refunded: opts.refunded ? 530 : 100,
			refunds: { object: "list", data: [{ id: opts.refundId ?? `re_${uid()}` }] },
		};
	}

	it("settles a purchase refunded from the Stripe dashboard, as platform-initiated", async () => {
		const purchase = await completedPurchase({ downloadedAt: new Date() });

		const res = await sendWebhook(
			stripeEvent(
				"charge.refunded",
				charge({ intent: purchase.stripePaymentIntentId, refunded: true }),
			),
		);
		expect(res.status).toBe(200);

		const row = await reload(purchase.id);
		expect(row.status).toBe("refunded");
		// An operator's action, so it must not spend the buyer's own allowance.
		expect(row.refundInitiator).toBe("platform");
		expect(await refundsAfterDownloadInWindow(buyerId)).toBe(0);
		expect(await ledgerFor(purchase.id)).toHaveLength(1);
	});

	it("ignores a partial refund", async () => {
		// `charge.refunded` fires for partials too, with `refunded` still false. A
		// partial must not revoke access — the buyer still paid for part of it.
		const purchase = await completedPurchase();

		await sendWebhook(
			stripeEvent(
				"charge.refunded",
				charge({ intent: purchase.stripePaymentIntentId, refunded: false }),
			),
		);

		expect((await reload(purchase.id)).status).toBe("completed");
		expect(await ledgerFor(purchase.id)).toHaveLength(0);
	});

	it("is a no-op for the refund our own route just made", async () => {
		const purchase = await completedPurchase({ downloadedAt: new Date() });
		await refundAs(buyerCookie, purchase.id);

		// Stripe fires this for every refund, including ours. If it weren't latched on
		// `completed` it would rewrite the initiator to `platform` and hand the buyer
		// their allowance back — and double-book the shortfall.
		await sendWebhook(
			stripeEvent(
				"charge.refunded",
				charge({ intent: purchase.stripePaymentIntentId, refunded: true }),
			),
		);

		const row = await reload(purchase.id);
		expect(row.refundInitiator).toBe("buyer");
		expect(await ledgerFor(purchase.id)).toHaveLength(1);
		expect(await refundsAfterDownloadInWindow(buyerId)).toBe(1);
	});
});

describe("markPurchaseDownloaded", () => {
	it("stamps the buyer's completed purchase, once", async () => {
		const workId = await makeWork(`Download stamp ${uid()}`);
		const purchase = await completedPurchase({ workId });

		await markPurchaseDownloaded(buyerId, workId);
		const first = (await reload(purchase.id)).downloadedAt;
		expect(first).not.toBeNull();

		// The column answers "has this been delivered at all", not "how often" — a
		// second download must not move the clock, or the cap window would slide.
		await markPurchaseDownloaded(buyerId, workId, new Date(Date.now() + 60_000));
		expect((await reload(purchase.id)).downloadedAt?.getTime()).toBe(first?.getTime());
	});

	it("stamps nobody else's purchase", async () => {
		const workId = await makeWork(`Download stamp other ${uid()}`);
		const mine = await completedPurchase({ workId });
		const theirs = await completedPurchase({ workId, buyer: otherId });

		await markPurchaseDownloaded(otherId, workId);
		expect((await reload(mine.id)).downloadedAt).toBeNull();
		expect((await reload(theirs.id)).downloadedAt).not.toBeNull();
	});
});

/** The Work row, for building the public URLs the ownership endpoint takes. */
async function workRow(id: number) {
	const { works } = await import("@anthers/db/schema");
	const [row] = await db.select().from(works).where(eq(works.id, id)).limit(1);
	return row;
}
