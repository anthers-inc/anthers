// SPDX-License-Identifier: Apache-2.0
/**
 * The saved billing address — the one opt-in address, and the guarantees the 2026-10-11
 * decision rests on.
 *
 * 🚨 **The assertions that matter most are about WHERE the address is and WHOSE write it
 * is.** The address must never land in a column (nothing Anthers keeps survives these
 * routes but the `billing_accounts` customer id the feature already carries for
 * subscriptions), checkout's prefill must be a read, and the clear must reach Stripe's
 * customer — which is recorded here on the *parameters we sent Stripe*, the only thing
 * we control, the same place every other Stripe assertion in this app is made.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { billingAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { setStripeClient } from "../lib/stripe";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

// Every account this suite creates is taken back afterward, on success or failure.
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

const run = crypto.randomUUID().slice(0, 8);
const buyerName = `addr_${run}`;

/** Two of these differ from the fourth: see the validation test. */
const ADDRESS = {
	name: "Parker Davis",
	line1: "123 Main St",
	line2: "",
	city: "Denver",
	state: "CO",
	postalCode: "80202",
};

/**
 * A Stripe whose customer record the suite shapes. Everything the routes touch is
 * recorded so the assertions are about what Anthers sent, not what came back.
 */
function fakeStripe() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const state = { customer: null as Record<string, unknown> | null };
	const client = {
		customers: {
			create: () => {
				calls.push({ method: "customers.create", args: [] });
				return Promise.resolve({ id: `cus_${crypto.randomUUID().slice(0, 12)}` });
			},
			retrieve: (id: string) => {
				calls.push({ method: "customers.retrieve", args: [id] });
				return Promise.resolve(state.customer);
			},
			update: (id: string, params: Record<string, unknown>) => {
				calls.push({ method: "customers.update", args: [id, params] });
				state.customer = { id, name: params.name ?? null, address: params.address };
				return Promise.resolve(state.customer);
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
	const account = await createAccount(buyerName);
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
	const path =
		typeof pathOrOptions === "string" ? pathOrOptions : "/api/accounts/me/billing-address";
	const init = typeof pathOrOptions === "object" ? pathOrOptions : maybeOptions;
	return req(path, {
		...init,
		headers: { ...init?.headers, Cookie: cookie, Origin: ORIGIN },
	});
}

it(
	"answers 401 signed out — the address is one account's, even read",
	async () => {
		const res = await req("/api/accounts/me/billing-address", { headers: { Origin: ORIGIN } });
		expect(res.status).toBe(401);
	},
	DB_SETUP_TIMEOUT,
);

it(
	"answers nothing-saved for a buyer with no billing row at all",
	async () => {
		const res = await me();
		expect(res.status).toBe(200);
		expect(((await res.json()) as { address: unknown }).address).toBeNull();
	},
	DB_SETUP_TIMEOUT,
);

it("saves to the Stripe Customer, never into a column", async () => {
	const res = await me({
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(ADDRESS),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { address: typeof ADDRESS };

	// The shape comes back as sent, line2 normalized to a real null by emptying.
	expect(body.address.name).toBe(ADDRESS.name);
	expect(body.address.line1).toBe(ADDRESS.line1);
	expect(body.address.city).toBe(ADDRESS.city);
	expect(body.address.state).toBe("CO");
	expect(body.address.postalCode).toBe("80202");

	// The Customer was created on first save, the address written onto it — and the
	// recorded params are the whole of what Anthers persisted.
	const [row] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId));
	expect(row?.stripeCustomerId).toMatch(/^cus_/);
	if (!row?.stripeCustomerId) throw new Error("unreachable");
	const updates = fake.callsTo("customers.update");
	expect(updates.length).toBe(1);
	const [updateId, updateParams] = updates[0].args as [string, Record<string, unknown>];
	expect(updateId).toBe(row.stripeCustomerId);
	expect(updateParams.name).toBe(ADDRESS.name);
	expect(updateParams.address).toEqual({
		line1: "123 Main St",
		city: "Denver",
		state: "CO",
		postal_code: "80202",
		country: "US",
	});
});

it("prefills from what Stripe holds, and from nothing else", async () => {
	const [row] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId));
	fake.state.customer = {
		id: row?.stripeCustomerId ?? "",
		name: ADDRESS.name,
		address: {
			city: "Denver",
			country: "US",
			line1: "123 Main St",
			line2: null,
			postal_code: "80202",
			state: "CO",
		},
	};
	const res = await me();
	expect(res.status).toBe(200);
	const body = (await res.json()) as { address: { name: string; line1: string } | null };
	expect(body.address?.name).toBe(ADDRESS.name);
	expect(body.address?.line1).toBe("123 Main St");

	// A Customer deleted at Stripe is nothing to show, exactly as no Customer is.
	fake.state.customer = {
		id: row?.stripeCustomerId ?? "",
		deleted: true,
	};
	const deleted = await me();
	expect(((await deleted.json()) as { address: unknown }).address).toBeNull();
});

it("refuses to prefill an address for a non-US country", async () => {
	const [row] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId));
	fake.state.customer = {
		id: row?.stripeCustomerId ?? "",
		name: null,
		address: {
			city: "Berlin",
			country: "DE",
			line1: "A Strasse",
			line2: null,
			postal_code: "10115",
			state: null,
		},
	};
	const res = await me();
	expect(((await res.json()) as { address: unknown }).address).toBeNull();
});

it("refuses a save whose ZIP or state is not a US shape", async () => {
	const res = await me({
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...ADDRESS, postalCode: "AB123" }),
	});
	expect(res.status).toBe(400);
	const badState = await me({
		method: "PUT",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...ADDRESS, state: "ZZ" }),
	});
	expect(badState.status).toBe(400);
});

it("clears by unsetting the field pair at Stripe", async () => {
	const res = await me({ method: "DELETE" });
	expect(res.status).toBe(200);
	expect(((await res.json()) as { address: unknown }).address).toBeNull();

	// The clear reaches the customer: both the address and the name it travels with.
	const updates = fake.callsTo("customers.update");
	expect(updates.length).toBe(2);
	const [afterId, afterParams] = updates[1].args as [string, Record<string, unknown>];
	const [row] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId));
	if (!row?.stripeCustomerId) throw new Error("unreachable");
	expect(afterId).toBe(row.stripeCustomerId);
	expect(afterParams).toEqual({ name: "", address: "" });
});

it("answers a clear with success even when there was never anything saved", async () => {
	// No billing row: no customer exists, no Stripe call is made, and the refusal shape
	// a 404 would be is exactly wrong here — the settings card shows an empty state.
	const updatesBefore = fake.callsTo("customers.update").length;
	const stranger = await createAccount(`addr_clean_${crypto.randomUUID().slice(0, 8)}`);
	const res = await req("/api/accounts/me/billing-address", {
		method: "DELETE",
		headers: { Cookie: stranger.cookie, Origin: ORIGIN },
	});
	expect(res.status).toBe(200);
	expect(((await res.json()) as { address: unknown }).address).toBeNull();
	expect(fake.callsTo("customers.update").length).toBe(updatesBefore);
});
