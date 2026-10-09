// SPDX-License-Identifier: Apache-2.0
/**
 * The storage top-up — the charging surface, and the ruled shape it must charge inside.
 *
 * 🚨 **The assertions are about what is SENT TO STRIPE and what is READ from the meter**,
 * not about what a function returns: the money is real, the eligibility rule is a ruling,
 * and every failure mode worth guarding is a figure that could be charged wrongly — a
 * free account charged, a doubled line on a redelivered webhook, an overflow priced from
 * the wrong month, an at-cost rate that grew a mark-up.
 *
 * The Stripe client is a recording fake (`setStripeClient`, the seam `renewal-cycle`
 * established) carrying a REAL `webhooks` member, so the webhook-delivered half runs
 * genuine HMAC verification — the same arrangement `refunds.test.ts` uses. The meter's
 * rows are real inserts this suite writes and takes back by cascade.
 *
 * Verified by sabotage before being committed: the predicted failures are named at each
 * describe.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badges, billingAccounts, storageUsage, userBadges, users } from "@anthers/db/schema";
import { currentCycleKey, previousCycleKey } from "@anthers/shared/billing-cycle";
import { STORAGE_LADDER_GIB, STORAGE_PER_GIB_MONTH } from "@anthers/shared/constants";
import { and, eq } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { addTopUpToInvoice, TOPUP_STAMP, topUpFromSnapshot } from "../services/storage-topup";
import { createAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

const ANTHERS_ID = await ensureAnthersLadder();
purgeAccountsCreatedHere();

const _ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const CUSTOMER = `cus_topup_${run}`;
const FAKE_KEY = "sk_test_topup_suite_not_a_real_key";
const WEBHOOK_SECRET = "whsec_test_secret_for_topup_signatures";

let realClient: Stripe | null;
let previousWebhookSecret: string | undefined;
let userId = 0;

/** The recording fake, covering only what the top-up window reaches for. */
function fakeStripe(opts: { existingItems?: { metadata?: Record<string, string> }[] } = {}) {
	const added: Stripe.InvoiceItemCreateParams[] = [];
	const real = new Stripe(FAKE_KEY);
	const client = {
		webhooks: real.webhooks,
		products: {
			list: () => ({
				async *[Symbol.asyncIterator]() {
					yield { id: "prod_platform", metadata: { anthers: "platform" } };
				},
			}),
		},
		invoiceItems: {
			create: (params: Stripe.InvoiceItemCreateParams) => {
				added.push(params);
				return Promise.resolve({ id: `ii_${uid()}`, ...params });
			},
			list: () => Promise.resolve({ data: opts.existingItems ?? [], has_more: false }),
		},
	} as unknown as Stripe;
	return {
		client,
		count: () => added.length,
		lastAdd: () => added.at(-1),
	};
}

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

interface DraftInvoiceOpts {
	/** The month the invoice pays FOR — its lines say so. */
	paysFor?: Date;
	/** Whether a top-up line already sits on the draft (the redelivery case). */
	alreadyStamped?: boolean;
}

/**
 * A draft renewal invoice in the shape Stripe delivers `invoice.created` with.
 *
 * 🚨 The lines' `period.start` is the month PAID FOR — the read `cycleInvoicePaysFor`
 * runs. The invoice-level `period_start` is deliberately a different month, because that
 * is what Stripe sets there on a renewal and the whole reason the lines are the read.
 */
function draftRenewal(opts: DraftInvoiceOpts = {}) {
	const paysFor = opts.paysFor ?? cycleStartFor(currentCycleKey());
	const before = new Date(paysFor.getTime() - 30 * 86400 * 1000);
	return {
		id: `in_${uid()}`,
		object: "invoice",
		status: "draft",
		billing_reason: "subscription_cycle",
		customer: CUSTOMER,
		period_start: Math.floor(before.getTime() / 1000),
		period_end: Math.floor(paysFor.getTime() / 1000),
		created: Math.floor(paysFor.getTime() / 1000),
		lines: {
			data: [
				{
					id: "il_anthers",
					amount: 300,
					period: {
						start: Math.floor(paysFor.getTime() / 1000),
						end: Math.floor(paysFor.getTime() / 1000) + 30 * 86400,
					},
					parent: {
						type: "subscription_item_details",
						subscription_item_details: { subscription_item: "si_anthers", proration: false },
					},
				},
			],
			has_more: false,
		},
	} as unknown as Stripe.Invoice;
}

/** The 1st of the named cycle, UTC — the inverse of `currentCycleKey`. */
function cycleStartFor(key: string): Date {
	const [y, m] = key.split("-").map(Number);
	return new Date(Date.UTC(y, m - 1, 1));
}

/** One `storage_usage` row holding `gib` GiB, for the named cycle. */
async function meterBytes(gib: number, cycle: string) {
	const bytes = Math.round(gib * 1024 ** 3);
	await db
		.insert(storageUsage)
		.values({ userId, billingCycle: cycle, bytes, purposes: { catalog: bytes } })
		.onConflictDoUpdate({
			target: [storageUsage.userId, storageUsage.billingCycle],
			set: { bytes, purposes: { catalog: bytes } },
		});
}

/** Hold the named Anthers rung this cycle — Root is $3. */
async function holdRoot() {
	const [root] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, ANTHERS_ID), eq(badges.threshold, "3")))
		.limit(1);
	if (!root) throw new Error("the Anthers ladder fixture does not carry a $3 rung");
	await db
		.insert(userBadges)
		.values({ userId, badgeId: root.id, billingCycle: currentCycleKey() })
		.onConflictDoNothing();
}

async function unhold() {
	await db.delete(userBadges).where(eq(userBadges.userId, userId));
}

/** POST a webhook with a real signature, as `refunds.test.ts` does. */
async function sendWebhook(payload: object) {
	const signer = new Stripe(FAKE_KEY);
	const body = JSON.stringify(payload);
	const signature = await signer.webhooks.generateTestHeaderStringAsync({
		payload: body,
		secret: WEBHOOK_SECRET,
	});
	return app.fetch(
		new Request("http://localhost/api/payments/stripe/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json", "stripe-signature": signature },
			body,
		}),
	);
}

beforeAll(async () => {
	realClient = getStripe();
	previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
	process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
	const acct = await createAccount(`topup_${run}`, { emailVerified: true });
	userId = acct.userId;
	// ⚠️ Fixture accounts carry NO billing row — an update here would silently match
	// nothing and every customer-id lookup would miss (found by probe). Inserted, the
	// way `renewal-cycle.test.ts`'s `withSubscription` does it.
	await db
		.insert(billingAccounts)
		.values({ userId, stripeCustomerId: CUSTOMER })
		.onConflictDoUpdate({
			target: billingAccounts.userId,
			set: { stripeCustomerId: CUSTOMER },
		});
}, DB_SETUP_TIMEOUT);

afterAll(async () => {
	setStripeClient(realClient);
	process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
});

describe("topUpFromSnapshot — the ruled arithmetic, pure", () => {
	it("charges nothing at Free however much is held", () => {
		const r = topUpFromSnapshot({ snapshot: { bytes: 900 * 1024 ** 3 }, anthersDollars: 0 });
		expect(r.eligible).toBe(false);
		expect(r.dollars.toNumber()).toBe(0);
		expect(r.overflowGiB.toNumber()).toBe(0);
	});

	it("prices the overflow at the provider's rate from Root", () => {
		const r = topUpFromSnapshot({ snapshot: { bytes: 60 * 1024 ** 3 }, anthersDollars: 3 });
		expect(r.eligible).toBe(true);
		expect(r.allowanceGiB).toBe(STORAGE_LADDER_GIB.root);
		// 60 held, 50 allowed: 10 GiB past, at the ruled rate, no mark-up.
		expect(r.overflowGiB.toNumber()).toBeCloseTo(10, 4);
		expect(r.dollars.toNumber()).toBeCloseTo(10 * STORAGE_PER_GIB_MONTH, 4);
	});

	it("answers zero overflow when the account sits within its allowance", () => {
		const r = topUpFromSnapshot({ snapshot: { bytes: 50 * 1024 ** 3 }, anthersDollars: 3 });
		expect(r.overflowGiB.toNumber()).toBe(0);
		expect(r.dollars.toNumber()).toBe(0);
	});
});

describe("addTopUpToInvoice — the draft-renewal window", () => {
	it("adds an at-cost line, priced from the metered month, stamped for idempotence", async () => {
		const fake = fakeStripe();
		setStripeClient(fake.client);

		// Hold Root, meter 400 GiB held last month — 350 past the 50-GiB allowance, at the
		// ruled rate $5.6350. A plausible heavy keeper: an at-cost overflow only ever
		// reaches an invoice when it clears Stripe's own $0.50 minimum, which at this rate
		// is 32 GiB, so the light fixtures in this suite's brothers assert refusals.
		await holdRoot();
		const meteredCycle = previousCycleKey(currentCycleKey());
		await meterBytes(400, meteredCycle);

		const added = await addTopUpToInvoice(draftRenewal());
		expect(added).toBeCloseTo(350 * STORAGE_PER_GIB_MONTH, 2);
		expect(fake.count()).toBe(1);

		const sent = fake.lastAdd()!;
		// The line is bound to the invoice, not to the subscription — the top-up is a
		// per-cycle fact, not a standing item.
		expect(sent.invoice).toMatch(/^in_/);
		// The stamp, the account and the metered month are the audit. (Narrowed to
		// `Record<string, string>` — Stripe's `MetadataParam` union carries `""`.)
		const meta = (sent.metadata ?? {}) as Record<string, string>;
		expect(meta.anthers).toBe(TOPUP_STAMP);
		expect(meta.meteredCycle).toBe(meteredCycle);
		// At cost: cents = GiB × rate × 100.
		expect(sent.amount).toBe(Math.round(350 * STORAGE_PER_GIB_MONTH * 100));

		await unhold();
	});

	// SABOTAGE PREDICTED: stubbing the suspended check fails exactly the first case;
	// stubbing the stamp lookup fails exactly the second — each named before it ran.
	it("never charges a suspended supporter, and never doubles on a redelivery", async () => {
		let fake = fakeStripe();
		setStripeClient(fake.client);
		await holdRoot();
		const meteredCycle = previousCycleKey(currentCycleKey());
		await meterBytes(400, meteredCycle);

		// 🚨 Suspension lives on `users`, not on billing_accounts — the schema has no
		// suspendedAt on the billing row, and the service reads users directly.
		await db.update(users).set({ suspendedAt: new Date() }).where(eq(users.id, userId));
		expect(await addTopUpToInvoice(draftRenewal())).toBe(0);
		expect(fake.count()).toBe(0);

		// Lift the suspension; now the redelivery posture: the draft already carries a
		// stamped line, so a second delivery must find it and add nothing.
		await db.update(users).set({ suspendedAt: null }).where(eq(users.id, userId));
		fake = fakeStripe({ existingItems: [{ metadata: { anthers: TOPUP_STAMP } }] });
		setStripeClient(fake.client);
		expect(await addTopUpToInvoice(draftRenewal())).toBe(0);
		expect(fake.count()).toBe(0);

		await unhold();
	});

	it("prices from the PREVIOUS cycle's snapshot, not the cycle being paid for", async () => {
		const fake = fakeStripe();
		setStripeClient(fake.client);
		await holdRoot();
		// Bytes in BOTH months: the paid-for month is heavy, the metered one is light —
		// charging the wrong one would price the decoy.
		await meterBytes(40, previousCycleKey(currentCycleKey())); // nothing past 50
		await meterBytes(120, currentCycleKey()); // the decoy

		const added = await addTopUpToInvoice(draftRenewal());
		expect(added).toBe(0);
		expect(fake.count()).toBe(0);

		await unhold();
	});

	it("adds nothing for an invoice that is not a draft renewal", async () => {
		const fake = fakeStripe();
		setStripeClient(fake.client);
		await holdRoot();
		await meterBytes(400, previousCycleKey(currentCycleKey()));

		const paid = { ...draftRenewal(), status: "paid" } as unknown as Stripe.Invoice;
		expect(await addTopUpToInvoice(paid)).toBe(0);
		expect(fake.count()).toBe(0);

		await unhold();
	});
});

describe("the webhook carries the top-up", () => {
	// SABOTAGE PREDICTED: removing the addTopUpToInvoice call from the webhook fails
	// exactly this case — the wiring is the thing under test, not the service again.
	it("an invoice.created delivery with overflow adds one line", async () => {
		const fake = fakeStripe();
		setStripeClient(fake.client);
		await holdRoot();
		await meterBytes(400, previousCycleKey(currentCycleKey()));

		const inv = draftRenewal();
		const res = await sendWebhook({
			id: `evt_${uid()}`,
			object: "event",
			api_version: "2025-01-01",
			created: Math.floor(Date.now() / 1000),
			livemode: false,
			pending_webhooks: 0,
			request: { id: null, idempotency_key: null },
			type: "invoice.created",
			data: { object: inv },
		});
		// The route acknowledges rather than 402s: the item's presence is the assertion.
		expect(res.status).toBe(200);
		expect(fake.count()).toBe(1);

		await unhold();
	});
});
