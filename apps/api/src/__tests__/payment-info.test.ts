// SPDX-License-Identifier: Apache-2.0
/**
 * The one saved payment method — a card and its full billing address, the subscription
 * that keeps it from being removed, and the proof the Adult control reads.
 *
 * The Stripe client is a shaped fake: every assertion is about what Anthers sent, which is
 * the same discipline the saved-address suite follows.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { stripeConnectAccounts, stripeCustomers } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { setStripeClient } from "../lib/stripe";
import { deleteBillingCustomer } from "../services/billing.js";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const name = `pay_${run}`;
const ADDRESS = {
	name: "Parker Davis",
	line1: "123 Main St",
	line2: "",
	city: "Denver",
	state: "CO",
	postalCode: "80202",
};

interface FakeCard {
	id: string;
	card: { brand: string; last4: string; funding: string };
}

function fakeStripe() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const state = {
		customer: null as Record<string, unknown> | null,
		cards: [] as FakeCard[],
		subscription: null as { id: string; default_payment_method: string | null } | null,
		failCustomerDelete: false,
		setupIntent: {
			id: "seti_1",
			customer: "cus_1",
			status: "succeeded",
			payment_method: "pm_new",
		} as Record<string, unknown>,
		// What the Address Element attached to the SetupIntent at confirmation — the saved
		// address is read off the method now, not posted by the browser beforehand.
		paymentMethod: {
			id: "pm_new",
			card: { brand: "visa", last4: "4242", funding: "credit" },
			billing_details: {
				name: ADDRESS.name,
				address: {
					line1: ADDRESS.line1,
					line2: null,
					city: ADDRESS.city,
					state: ADDRESS.state,
					postal_code: ADDRESS.postalCode,
					country: "US",
				},
			},
		} as Record<string, unknown>,
	};
	const client = {
		customers: {
			create: () => {
				calls.push({ method: "customers.create", args: [] });
				return Promise.resolve({ id: "cus_1" });
			},
			del: (id: string) => {
				calls.push({ method: "customers.del", args: [id] });
				if (state.failCustomerDelete) return Promise.reject(new Error("stripe down"));
				state.customer = { id, deleted: true };
				return Promise.resolve({ id, deleted: true });
			},
			retrieve: (id: string) => {
				calls.push({ method: "customers.retrieve", args: [id] });
				return Promise.resolve(state.customer);
			},
			update: (id: string, params: Record<string, unknown>) => {
				calls.push({ method: "customers.update", args: [id, params] });
				state.customer = { ...(state.customer ?? { id, deleted: false }), ...params };
				return Promise.resolve(state.customer);
			},
		},
		setupIntents: {
			create: (params: Record<string, unknown>) => {
				calls.push({ method: "setupIntents.create", args: [params] });
				return Promise.resolve({ id: "seti_1", client_secret: "seti_secret" });
			},
			retrieve: (id: string) => {
				calls.push({ method: "setupIntents.retrieve", args: [id] });
				return Promise.resolve(state.setupIntent);
			},
		},
		paymentMethods: {
			retrieve: (id: string) => {
				calls.push({ method: "paymentMethods.retrieve", args: [id] });
				return Promise.resolve(state.paymentMethod);
			},
			list: (params: Record<string, unknown>) => {
				calls.push({ method: "paymentMethods.list", args: [params] });
				return Promise.resolve({ data: state.cards });
			},
			detach: (id: string) => {
				calls.push({ method: "paymentMethods.detach", args: [id] });
				state.cards = state.cards.filter((card) => card.id !== id);
				return Promise.resolve({ id });
			},
		},
		subscriptions: {
			retrieve: (id: string) => {
				calls.push({ method: "subscriptions.retrieve", args: [id] });
				return Promise.resolve(state.subscription);
			},
			update: (id: string, params: Record<string, unknown>) => {
				calls.push({ method: "subscriptions.update", args: [id, params] });
				if (state.subscription) {
					Object.assign(state.subscription, params);
				}
				return Promise.resolve(state.subscription);
			},
		},
	} as unknown as Stripe;
	return { client, state, calls, callsTo: (m: string) => calls.filter((c) => c.method === m) };
}

let realClient: Stripe | null;
let cookie: string;
let userId: number;
let fake: ReturnType<typeof fakeStripe>;

beforeAll(async () => {
	const account = await createAccount(name);
	cookie = account.cookie;
	userId = account.userId;
	realClient = setStripeClient(null);
	fake = fakeStripe();
	setStripeClient(fake.client);
}, DB_SETUP_TIMEOUT);

afterAll(() => {
	setStripeClient(realClient);
});

function me(pathOrOptions?: string | RequestInit, maybeOptions?: RequestInit) {
	const path = typeof pathOrOptions === "string" ? pathOrOptions : "/api/accounts/me/payment-info";
	const init = typeof pathOrOptions === "object" ? pathOrOptions : maybeOptions;
	return req(path, {
		...init,
		headers: { ...init?.headers, Cookie: cookie, Origin: ORIGIN },
	});
}

it(
	"answers an empty payment method before anything is saved",
	async () => {
		const res = await me();
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			address: unknown;
			card: unknown;
			subscriptionAttached: boolean;
		};
		expect(body.address).toBeNull();
		expect(body.card).toBeNull();
		expect(body.subscriptionAttached).toBe(false);
	},
	DB_SETUP_TIMEOUT,
);

it("saves a card with the address and makes it the default", async () => {
	const setup = await me("/api/accounts/me/payment-info/setup", { method: "POST" });
	expect(setup.status).toBe(200);
	expect((await setup.json()) as { clientSecret: string }).toEqual({
		clientSecret: "seti_secret",
	});
	const created = fake.callsTo("setupIntents.create");
	expect(created.length).toBe(1);
	const [params] = created[0].args as [Record<string, unknown>];
	expect(params.customer).toBe("cus_1");
	expect((params.metadata as Record<string, string>).purpose).toBe("save_payment_method");
	// The Payment Element reads the offer from the intent, and this API version derives it
	// from the account's card-only configuration rather than from `payment_method_types`.
	expect(params.automatic_payment_methods).toEqual({ enabled: true, allow_redirects: "never" });

	fake.state.cards = [
		{ id: "pm_old", card: { brand: "visa", last4: "1111", funding: "credit" } },
		{ id: "pm_new", card: { brand: "visa", last4: "4242", funding: "credit" } },
	];
	fake.state.subscription = { id: "sub_1", default_payment_method: "pm_old" };
	await db
		.update(stripeCustomers)
		.set({ stripeSubscriptionId: "sub_1" })
		.where(eq(stripeCustomers.userId, userId));

	const finalized = await me("/api/accounts/me/payment-info/finalize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ setupIntentId: "seti_1" }),
	});
	expect(finalized.status).toBe(200);
	const info = (await finalized.json()) as {
		card: { id: string; funding: string };
		subscriptionAttached: boolean;
	};
	expect(info.card.id).toBe("pm_new");
	expect(info.card.funding).toBe("credit");
	expect(info.subscriptionAttached).toBe(true);

	const customerUpdate = fake.callsTo("customers.update").at(-1);
	const [, customerParams] = customerUpdate?.args as [string, Record<string, unknown>];
	expect((customerParams.invoice_settings as Record<string, string>).default_payment_method).toBe(
		"pm_new",
	);
	// The address rode the SetupIntent and is written from the confirmed payment method.
	expect(customerParams.name).toBe(ADDRESS.name);
	expect(customerParams.address).toEqual({
		line1: ADDRESS.line1,
		city: ADDRESS.city,
		state: ADDRESS.state,
		postal_code: ADDRESS.postalCode,
		country: "US",
	});
	// ...and reads back off the Customer, which is the only place it is stored.
	const saved = await me();
	const savedBody = (await saved.json()) as {
		address: { line1: string; postalCode: string };
	};
	expect(savedBody.address).toMatchObject({
		line1: ADDRESS.line1,
		postalCode: ADDRESS.postalCode,
	});
	const subscriptionUpdate = fake.callsTo("subscriptions.update").at(-1);
	const [, subscriptionParams] = subscriptionUpdate?.args as [string, Record<string, unknown>];
	expect(subscriptionParams.default_payment_method).toBe("pm_new");
	expect(fake.callsTo("paymentMethods.detach").map((c) => c.args[0])).toEqual(["pm_old"]);
});

it("refuses a card whose billing address did not arrive, and drops the card", async () => {
	fake.state.paymentMethod = {
		id: "pm_orphan",
		card: { brand: "visa", last4: "9999", funding: "credit" },
		billing_details: { name: ADDRESS.name, address: null },
	};
	fake.state.setupIntent = {
		id: "seti_2",
		customer: "cus_1",
		status: "succeeded",
		payment_method: "pm_orphan",
	};

	const res = await me("/api/accounts/me/payment-info/finalize", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ setupIntentId: "seti_2" }),
	});
	expect(res.status).toBe(409);
	expect((await res.json()) as { error: string }).toMatchObject({
		error: expect.stringContaining("billing address"),
	});
	// Half an object is not saved: the card goes, and the address already on the Customer stays.
	expect(fake.callsTo("paymentMethods.detach").map((c) => c.args[0])).toContain("pm_orphan");
	const after = await me();
	expect(((await after.json()) as { address: { line1: string } }).address.line1).toBe(
		ADDRESS.line1,
	);
});

it("refuses to remove the card a live subscription renews on", async () => {
	const res = await me("/api/accounts/me/payment-info", { method: "DELETE" });
	expect(res.status).toBe(409);
	const body = (await res.json()) as { code?: string };
	expect(body.code).toBe("subscription_attached");
});

it("counts the card as the Adult proof only while it is a credit card", async () => {
	fake.state.cards = [{ id: "pm_new", card: { brand: "visa", last4: "4242", funding: "credit" } }];
	const credit = await me("/api/accounts/me/adult-access");
	expect(credit.status).toBe(200);
	const creditBody = (await credit.json()) as {
		paymentProof: { savedCard: boolean; cardIsCredit: boolean; canVerify: boolean };
	};
	expect(creditBody.paymentProof).toMatchObject({
		savedCard: true,
		cardIsCredit: true,
		canVerify: true,
	});

	fake.state.cards = [{ id: "pm_new", card: { brand: "visa", last4: "4242", funding: "debit" } }];
	const debit = await me("/api/accounts/me/adult-access");
	const debitBody = (await debit.json()) as {
		paymentProof: { cardIsCredit: boolean; canVerify: boolean };
	};
	expect(debitBody.paymentProof).toMatchObject({ cardIsCredit: false, canVerify: false });
});

it("accepts a ready creator payout standing as the proof instead", async () => {
	await db
		.insert(stripeConnectAccounts)
		.values({
			userId,
			stripeAccountId: `acct_pay_${run}`,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		})
		.onConflictDoUpdate({
			target: stripeConnectAccounts.userId,
			set: { chargesEnabled: true, payoutsEnabled: true, onboardingComplete: true },
		});
	const res = await me("/api/accounts/me/adult-access");
	const body = (await res.json()) as {
		paymentProof: { payoutReady: boolean; canVerify: boolean };
	};
	expect(body.paymentProof).toMatchObject({ payoutReady: true, canVerify: true });
});

it("removes the card once nothing renews on it", async () => {
	await db
		.update(stripeCustomers)
		.set({ stripeSubscriptionId: null })
		.where(eq(stripeCustomers.userId, userId));
	fake.state.subscription = null;

	const res = await me("/api/accounts/me/payment-info", { method: "DELETE" });
	expect(res.status).toBe(200);
	expect((await res.json()) as { status: string }).toEqual({ status: "cleared" });
	expect(fake.callsTo("paymentMethods.detach").map((c) => c.args[0])).toContain("pm_new");

	const after = await me();
	const body = (await after.json()) as { card: unknown };
	expect(body.card).toBeNull();
});

it("deletes the Customer on account deletion and defers on a Stripe refusal", async () => {
	// The account-deletion path's write: deleting the Customer removes the address and the
	// card details with it. A refusal is the caller's deferral signal, never a partial
	// success.
	fake.state.failCustomerDelete = false;
	expect(await deleteBillingCustomer(userId)).toBe("deleted");
	expect(fake.callsTo("customers.del").map((c) => c.args[0])).toContain("cus_1");

	fake.state.failCustomerDelete = true;
	expect(await deleteBillingCustomer(userId)).toBe("failed");
	fake.state.failCustomerDelete = false;
});
