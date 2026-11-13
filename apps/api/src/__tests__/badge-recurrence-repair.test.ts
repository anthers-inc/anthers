// SPDX-License-Identifier: Apache-2.0
/**
 * The repair path for a Badge recurrence a partial checkout left behind.
 *
 * The live failure was a customerless checkout: the card was never attached, the Customer
 * had no address, and the completion latch left the charge and holding without a
 * subscription. This suite proves the repair uses the charge's own date for the reduction
 * (not the day it is run), attaches the card, creates the trialing subscription, and is
 * idempotent on a second run.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badgeCharges, badges, billingReductions, stripeCustomers } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { setStripeClient } from "../lib/stripe";
import { repairMissingBadgeRecurrences } from "../services/badge-recurrence-repair";
import { createAccount } from "./account-fixture";
import { createBadgeRung } from "./badge-fixtures";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
const handleName = `badge_repair_${run}`;
let account: Awaited<ReturnType<typeof createAccount>>;
let realClient: Stripe | null;

function fakeStripe() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const record =
		(method: string, fallback: (...args: never[]) => unknown) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return Promise.resolve((fallback as (...a: unknown[]) => unknown)(...args));
		};
	const pm = {
		id: "pm_repair",
		object: "payment_method",
		customer: null,
		type: "card",
		card: { brand: "visa", funding: "credit" },
		billing_details: {
			name: "Repair Tester",
			address: {
				line1: "123 Main St",
				line2: null,
				city: "Denver",
				state: "CO",
				postal_code: "80202",
				country: "US",
			},
		},
	};
	const client = {
		paymentIntents: {
			retrieve: record("paymentIntents.retrieve", () => ({
				id: "pi_repair",
				payment_method: "pm_repair",
				customer: null,
			})),
		},
		paymentMethods: {
			retrieve: record("paymentMethods.retrieve", () => pm),
			attach: record("paymentMethods.attach", () => ({ ...pm, customer: "cus_repair" })),
		},
		customers: {
			retrieve: record("customers.retrieve", () => ({
				id: "cus_repair",
				deleted: false,
				address: null,
				invoice_settings: { default_payment_method: null },
			})),
			update: record("customers.update", (id: string) => ({ id, deleted: false })),
		},
		subscriptions: {
			list: record("subscriptions.list", () => ({ data: [] })),
			create: record("subscriptions.create", () => ({
				id: "sub_repair",
				object: "subscription",
				status: "trialing",
				trial_end: Math.floor(new Date("2026-12-01T00:00:00Z").getTime() / 1000),
			})),
		},
	} as unknown as Stripe;
	return {
		client,
		calls,
		callsTo: (method: string) => calls.filter((c) => c.method === method),
		lastCall: (method: string) => calls.filter((c) => c.method === method).at(-1),
	};
}

let fake: ReturnType<typeof fakeStripe>;
let badgeId: number;

beforeAll(async () => {
	account = await createAccount(handleName);
	badgeId = await createBadgeRung(account.cookie, "3.00", "Repair rung");
	await db.update(badges).set({ stripeProductId: "prod_repair" }).where(eq(badges.id, badgeId));
	await db.insert(stripeCustomers).values({
		userId: account.userId,
		stripeCustomerId: "cus_repair",
	});
	await db.insert(badgeCharges).values({
		buyerId: account.userId,
		badgeId,
		creatorId: account.userId,
		badgeLabel: "Repair rung",
		threshold: "3.00",
		chargedAmount: "3.00",
		processingFee: "0.39",
		salesTax: "0.00",
		billingCycle: "2026-11-01",
		stripePaymentIntentId: "pi_repair",
		status: "completed",
		createdAt: new Date("2026-11-06T22:55:50Z"),
	});
	fake = fakeStripe();
	realClient = setStripeClient(fake.client);
}, DB_SETUP_TIMEOUT);

afterAll(() => {
	setStripeClient(realClient);
});

it("attaches the card, creates the trial, and records the reduction from the charge date", async () => {
	const summary = await repairMissingBadgeRecurrences({
		handles: [account.handle],
		apply: true,
	});
	expect(summary).toHaveLength(1);
	expect(summary[0]).toMatchObject({
		handle: account.handle,
		subscription: "sub_repair",
		status: "trialing",
		applied: true,
	});
	expect(summary[0]?.reductions).toEqual([
		{ cycle: "2026-12-01", destination: String(account.userId), amount: "0.50", line: "3.00" },
	]);

	expect(fake.callsTo("paymentMethods.attach").map((c) => c.args[0])).toEqual(["pm_repair"]);
	expect(fake.callsTo("paymentMethods.attach")[0]?.args[1]).toEqual({ customer: "cus_repair" });

	const created = fake.lastCall("subscriptions.create")?.args[0] as
		| Stripe.SubscriptionCreateParams
		| undefined;
	expect(created?.default_payment_method).toBe("pm_repair");
	expect(created?.trial_end).toBe(Math.floor(new Date("2026-12-01T00:00:00Z").getTime() / 1000));
	expect(created?.items?.[0]?.price_data?.unit_amount).toBe(300);
	expect(created?.items?.[0]?.metadata?.destination).toBe(String(account.userId));

	const [row] = await db
		.select({ subscription: stripeCustomers.stripeSubscriptionId })
		.from(stripeCustomers)
		.where(eq(stripeCustomers.userId, account.userId));
	expect(row?.subscription).toBe("sub_repair");

	const [reduction] = await db
		.select({ cycle: billingReductions.billingCycle, amount: billingReductions.amount })
		.from(billingReductions)
		.where(eq(billingReductions.userId, account.userId));
	expect(reduction).toMatchObject({ cycle: "2026-12-01", amount: "0.50" });
});

it("changes nothing on a second run", async () => {
	const before = fake.callsTo("subscriptions.create").length;
	const summary = await repairMissingBadgeRecurrences({
		handles: [account.handle],
		apply: true,
	});
	expect(summary[0]?.skipped).toBe("already has a subscription");
	expect(fake.callsTo("subscriptions.create")).toHaveLength(before);
});
