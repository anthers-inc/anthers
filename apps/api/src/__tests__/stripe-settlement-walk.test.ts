// SPDX-License-Identifier: Apache-2.0
/**
 * Support, from signup through settlement, against test-mode Stripe itself.
 *
 * 🚨 **What only Stripe can answer, and a hand-built invoice cannot.** Every other suite here
 * feeds the recorder and the reduction applier invoices written by hand, and a hand-built invoice
 * agrees with whatever its author believed about Stripe. Two of those beliefs were wrong at once
 * — an invoice's own `period_start` names the month before a renewal, and a line's `amount` is
 * before its discount — and every suite passed while real renewals went undiscounted and were
 * credited to the wrong month. This walk is what caught it, so it is kept.
 *
 * It starts support through the real `POST /account` on a customer attached to a Stripe test
 * clock, pays the first invoice, advances the clock to the 1st, spends the day-exact reduction on
 * the draft renewal, lets Stripe charge it, records both invoices as `invoice.paid` would, and
 * settles both months, then compares every credit with what the model says the collected money
 * should pay.
 *
 * ⚠️ **Opt-in, and never part of `verify` or CI.** It reaches the network, it needs the Anthers
 * Dev test key, and the objects it makes live in the Stripe account production also runs in test
 * mode — so their webhooks reach production, which ignores customers it does not know. Run it
 * with `make stripe-walk`, which reads the key and refuses a live one; it takes a few minutes,
 * most of them waiting on the test clock. It deletes the clock, which takes the customer, the
 * subscription and the invoices with it, and archives the products it made.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accounts,
	creatorCredits,
	crfLedger,
	invoiceLines,
	invoices,
	users,
} from "@anthers/db/schema";
import { timePoolFor } from "@anthers/shared/constants";
import { paymentsSplit } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { eq, like } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { settleCycle } from "../jobs/settle-cycle";
import { getStripe, setStripeClient } from "../lib/stripe";
import { syncSubscriptionToAccount } from "../services/billing";
import { recordPaidInvoice } from "../services/invoices";
import { applyReductionsToInvoice } from "../services/support-reductions";
import { createAccount } from "./account-fixture";
import { insertAttentionRange } from "./attention-fixture.js";
import { purgeAccountsCreatedHere } from "./cleanup";

purgeAccountsCreatedHere();

const REQUESTED = process.env.RUN_STRIPE_WALK === "1";
const KEY = process.env.STRIPE_WALK_KEY ?? "";

describe.skipIf(!REQUESTED)("support against test-mode Stripe, from signup to settlement", () => {
	let stripe: Stripe;
	let realClient: Stripe | null;
	const startedAt = Math.floor(Date.now() / 1000) - 60;
	let clockId: string | null = null;
	const creatorNames: string[] = [];

	beforeAll(() => {
		// A live key would make real charges on a real card network. Refused here as well as in
		// the script, so running this file by hand cannot get past it either.
		if (!/^(sk|rk)_test_/.test(KEY)) throw new Error("the Stripe walk needs a test-mode key");
		stripe = new Stripe(KEY);
		realClient = getStripe();
		setStripeClient(stripe);
	});

	afterAll(async () => {
		setStripeClient(realClient);
		if (!stripe) return;
		if (clockId) await stripe.testHelpers.testClocks.del(clockId).catch(() => {});
		// Products carry prices and cannot be deleted, so the ones this run made are archived.
		const made = await stripe.products.list({ limit: 100, created: { gte: startedAt } });
		for (const product of made.data) {
			const ours =
				product.metadata?.anthers === "platform" ||
				creatorNames.some((name) => product.name.includes(name));
			if (ours) await stripe.products.update(product.id, { active: false }).catch(() => {});
		}
		const coupons = await stripe.coupons.list({ limit: 100, created: { gte: startedAt } });
		for (const coupon of coupons.data) {
			if (coupon.metadata?.anthers === "support_reduction") {
				await stripe.coupons.del(coupon.id).catch(() => {});
			}
		}
	});

	async function advance(to: Date) {
		await stripe.testHelpers.testClocks.advance(clockId as string, {
			frozen_time: Math.floor(to.getTime() / 1000),
		});
		for (let i = 0; i < 150; i++) {
			if ((await stripe.testHelpers.testClocks.retrieve(clockId as string)).status === "ready")
				return;
			await Bun.sleep(2000);
		}
		throw new Error("the test clock never finished advancing");
	}

	/** Record an invoice as the `invoice.paid` webhook delivers it, and read back what was kept. */
	async function record(invoiceId: string) {
		const mismatches: string[] = [];
		const error = console.error;
		console.error = (...args: unknown[]) => {
			mismatches.push(args.map(String).join(" "));
			error(...args);
		};
		try {
			await recordPaidInvoice(await stripe.invoices.retrieve(invoiceId));
		} finally {
			console.error = error;
		}
		const [row] = await db.select().from(invoices).where(eq(invoices.stripeInvoiceId, invoiceId));
		const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, row.id));
		const anthers = new Decimal(lines.find((l) => l.creatorId == null)?.amount ?? 0);
		const directed = new Decimal(lines.find((l) => l.creatorId != null)?.amount ?? 0);
		return { row, anthers, directed, mismatches };
	}

	it("charges, discounts, records and settles two months exactly as the model says", async () => {
		const now = new Date();
		const supporter = await createAccount(`walk_sup_${crypto.randomUUID().slice(0, 6)}`);
		const creator = await createAccount(`walk_cre_${crypto.randomUUID().slice(0, 6)}`);
		creatorNames.push(creator.name);
		await db.update(users).set({ emailVerified: true }).where(eq(users.id, supporter.userId));

		const clock = await stripe.testHelpers.testClocks.create({
			frozen_time: Math.floor(now.getTime() / 1000),
			name: "Anthers settlement walk",
		});
		clockId = clock.id;
		const customer = await stripe.customers.create({
			email: "walk@example.com",
			name: "EXAMPLE settlement walk",
			test_clock: clock.id,
		});
		const card = await stripe.paymentMethods.attach("pm_card_visa", { customer: customer.id });
		await stripe.customers.update(customer.id, {
			invoice_settings: { default_payment_method: card.id },
		});
		await db
			.insert(accounts)
			.values({ userId: supporter.userId, stripeCustomerId: customer.id })
			.onConflictDoUpdate({ target: accounts.userId, set: { stripeCustomerId: customer.id } });

		// ── The first month, started mid-month through the real route ──
		const res = await app.fetch(
			new Request("http://localhost/api/subscriptions/account", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: "http://localhost:3000",
					Cookie: supporter.cookie,
				},
				body: JSON.stringify({
					anthersSupport: 6,
					directed: [{ creatorId: creator.userId, amount: 4 }],
				}),
			}),
		);
		expect(res.status).toBe(200);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporter.userId));
		const subId = acct.stripeSubscriptionId as string;
		let sub = await stripe.subscriptions.retrieve(subId);
		const firstId =
			typeof sub.latest_invoice === "string" ? sub.latest_invoice : sub.latest_invoice?.id;
		await stripe.invoices.pay(firstId as string, { payment_method: card.id });
		sub = await stripe.subscriptions.retrieve(subId);
		expect(sub.status).toBe("active");
		await syncSubscriptionToAccount(sub);

		const first = await record(firstId as string);
		expect(first.mismatches).toEqual([]);
		expect(first.row.stripePaymentIntentId).toBeTruthy();
		expect(Number(first.row.processingFee)).toBeGreaterThan(0);
		expect(first.anthers.plus(first.directed).toFixed(2)).toBe(first.row.subtotal);

		// ── The renewal on the 1st, discounted while it is a draft ──
		const nextFirst = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 10));
		await advance(nextFirst);
		const listed = await stripe.invoices.list({ subscription: subId, limit: 10 });
		const draft = listed.data.find((i) => i.billing_reason === "subscription_cycle");
		expect(draft?.status).toBe("draft");
		// Somebody who started on the 1st is owed nothing, so a walk run on the 1st spends nothing.
		const owesReduction = now.getUTCDate() > 1;
		expect(await applyReductionsToInvoice(draft as Stripe.Invoice)).toBe(owesReduction ? 2 : 0);

		await advance(new Date(nextFirst.getTime() + 3 * 3600_000));
		expect((await stripe.invoices.retrieve(draft?.id as string)).status).toBe("paid");
		const renewal = await record(draft?.id as string);
		expect(renewal.mismatches).toEqual([]);
		expect(renewal.row.billingCycle).not.toBe(first.row.billingCycle);
		expect(renewal.anthers.plus(renewal.directed).toFixed(2)).toBe(renewal.row.subtotal);
		if (owesReduction) {
			expect(Number(renewal.row.subtotal)).toBeLessThan(10);
			expect(Number(renewal.row.discount)).toBeGreaterThan(0);
		}

		// ── Both months settled ──
		for (const month of [first.row.billingCycle, renewal.row.billingCycle]) {
			await insertAttentionRange({
				userId: supporter.userId,
				creatorId: creator.userId,
				eventType: "watch",
				seconds: 1800,
				publicAccess: true,
				endsAt: new Date(`${month.slice(0, 8)}10T12:00:00Z`),
			});
		}
		await settleCycle({
			userId: supporter.userId,
			now: new Date(Date.UTC(nextFirst.getUTCFullYear(), nextFirst.getUTCMonth() + 1, 2, 2)),
		});

		const credits = await db
			.select()
			.from(creatorCredits)
			.where(eq(creatorCredits.subscriberId, supporter.userId));
		for (const month of [first, renewal]) {
			const split = paymentsSplit(month.anthers.toNumber(), month.directed.toNumber());
			const credited = (kind: string) =>
				credits
					.filter((c) => c.billingCycle === month.row.billingCycle && c.kind === kind)
					.reduce((sum, c) => sum.plus(c.amount), new Decimal(0))
					.toFixed(2);
			expect(credited("support")).toBe(month.directed.minus(split.creator).toFixed(2));
			expect(credited("time_pool")).toBe(
				new Decimal(timePoolFor(month.anthers.toNumber())).toFixed(2),
			);

			const [booked] = await db
				.select({ amount: crfLedger.amount })
				.from(crfLedger)
				.where(
					like(crfLedger.description, `[settle u${supporter.userId} ${month.row.billingCycle}]%`),
				);
			const expected = month.anthers
				.minus(timePoolFor(month.anthers.toNumber()))
				.minus(new Decimal(month.row.processingFee).minus(split.creator));
			expect(new Decimal(booked?.amount ?? 0).toFixed(2)).toBe(expected.toFixed(2));
		}

		await db.delete(crfLedger).where(like(crfLedger.description, `[settle u${supporter.userId} %`));
	}, 900_000);
});
