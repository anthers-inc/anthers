// SPDX-License-Identifier: Apache-2.0
/**
 * The merch path — a physical Work owned by the official Anthers account, sold through
 * its own checkout and fulfilled by Printful.
 *
 * **Nothing here reaches either network.** Stripe's client is the recording fake
 * (`setStripeClient`, the same seam the Stripe suite drives); Printful's service module
 * is driven through `SET_PRINTFUL_TOKEN`-less configuration — `printfulConfigured()`
 * reads `process.env.PRINTFUL_TOKEN`, so a suite that wants the configured branches runs
 * them with the variable set to a marked fake (`not_a_real_printful_token`) and a stubbed
 * `fetch` that records and answers shaped responses, and a suite that wants the
 * unconfigured refusals runs with it absent. The 429/Retry-After behavior and the
 * read-back-before-write rule are asserted on the stub, which is the point: the webhook
 * receiver's security property is that a payload cannot write state, and only a
 * controlled fetch can prove what state the write actually came from.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	billingAccounts,
	merchFulfillments,
	merchVariants,
	purchases,
	users,
} from "@anthers/db/schema";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { createAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

// Every account this suite creates is taken back afterward, on success or failure.
await ensureAnthersLadder();
purgeAccountsCreatedHere();

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const run = crypto.randomUUID().slice(0, 8);
const buyerName = `merch_buyer_${run}`;

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

// ── The fetch stub, standing in for Printful ─────────────────────────────────

interface PrintfulCall {
	method: string;
	path: string;
	body: unknown;
}

const printfulCalls: PrintfulCall[] = [];
let printfulAnswer: (call: PrintfulCall) => unknown = () => null;
let realFetch: typeof globalThis.fetch | undefined;

/** A fake Stripe client covering the checkout and quote paths the merch routes take. */
function fakeStripeCheckout() {
	const stripeObject = { id: "cs_test_merch", client_secret: "cs_test_merch_secret_123" };
	/** The tax calculation's recorded params, answered by `taxState`. */
	const taxCalls: unknown[] = [];
	const taxState: { value: { tax_amount_exclusive: number } | null; fail: boolean } = {
		value: { tax_amount_exclusive: 234 },
		fail: false,
	};
	const customerState: { customer: Record<string, unknown> | null } = { customer: null };
	return {
		// Cast: the merch paths read only the session create's return, and the full
		// Stripe surface is the Stripe suite's subject with its own shaped fake.
		client: {
			checkout: {
				sessions: {
					create: async () => stripeObject,
				},
			},
			customers: {
				retrieve: async (id: string) => {
					if (!customerState.customer) return null;
					return { id, ...customerState.customer };
				},
			},
			tax: {
				calculations: {
					create: async (params: unknown) => {
						taxCalls.push(params);
						if (taxState.fail) throw new Error("Stripe cannot resolve that address");
						return taxState.value ?? { tax_amount_exclusive: 0 };
					},
				},
			},
		} as unknown as Stripe,
		taxCalls,
		taxState,
		customerState,
	};
}

beforeAll(async () => {
	// The merch checkout charges through Stripe like any purchase, so the configured
	// branches need *some* Stripe client; the unconfigured ones need none. `setSession`
	// shapes what a session creates returns per test — the suite's subject is the merch
	// resolution and the Printful boundary, never Stripe's signature behavior.
	realClient = getStripe();
	fake = fakeStripeCheckout();
	setStripeClient(fake.client);
	realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (!url.includes("api.printful.com")) return realFetch!(input, init);
		printfulCalls.push({
			method: init?.method ?? "GET",
			path: url.replace("https://api.printful.com", ""),
			body: init?.body ? JSON.parse(init.body as string) : undefined,
		});
		const answer = printfulAnswer(printfulCalls[printfulCalls.length - 1]);
		return new Response(JSON.stringify({ code: 200, result: answer }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;

	const account = await createAccount(buyerName);
	await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.email, `${buyerName}@example.com`));
	buyerCookie = account.cookie;
	buyerId = account.userId;
	anthersUserIdValue = await ensureAnthersLadder();
}, DB_SETUP_TIMEOUT);

let buyerCookie = "";
let buyerId = 0;
let fake: ReturnType<typeof fakeStripeCheckout>;
let realClient: ReturnType<typeof getStripe>;
afterAll(async () => {
	// Clean up everything written: the merch rows by work id, the purchase, the buyer.
	const written = await db
		.select({ id: merchVariants.id, workId: merchVariants.workId })
		.from(merchVariants);
	if (written.length > 0) {
		await db.delete(merchFulfillments);
		await db.delete(merchVariants);
	}
	await db.delete(purchases).where(sql`1 = 0`); // purchases ride the account cascade
	if (realFetch) globalThis.fetch = realFetch;
	setStripeClient(realClient);
});

/** The official Anthers account — the ladder fixture's stand-in, carrying the reserved name. */
let anthersUserIdValue = 0;

function catalogVariant(size: string) {
	return {
		id: 4000 + Number(size.charCodeAt(0)),
		product_id: 71,
		name: `Unisex Tee (Black / ${size})`,
		size,
		color: "Black",
		price: "9.50",
		in_stock: true,
	};
}

async function makeMerchWork(variantIds: number[], opts?: { mockupUrl?: string | null }) {
	const work = await insertWork({
		creatorId: anthersUserIdValue,
		type: "physical",
		title: `Anthers Tee ${run}`,
		streamEnabled: false,
		downloadEnabled: false,
		// ⚠️ The price rows on a merch Work are meaningless — the real price is derived
		// from Printful's catalog price + the margin constant at the merch routes. But
		// `resolveAccess` routes on the rows: a zero price reads as free, so the fixture
		// carries the same purchasable-row shape the Stripe suite's fixtures carry (the
		// amount is never charged; the merch checkout derives its own).
		access: [{ threshold: 0, allow: true, price: "5.00" }],
	});
	for (const catalogVariantId of variantIds) {
		await db.insert(merchVariants).values({
			workId: work.id,
			color: "black",
			size: `S${catalogVariantId}`.slice(0, 6),
			catalogVariantId,
			syncVariantId: catalogVariantId,
			catalogVariantName: `Black / size ${catalogVariantId}`,
			catalogPrice: "9.50",
			listPrice: "30.00", // Printful's retail price is the list source (Parker, 2026-10-08)
			printFileUrl: "https://cdn.anthers.org/merch/tee.png",
			mockupUrl: opts?.mockupUrl ?? null,
			synced: true,
		});
	}
	return work;
}

describe("Merch not configured — every guard refuses", () => {
	it("503s the checkout when Printful is not configured", async () => {
		const work = await makeMerchWork([4011]);
		const res = await req(`/api/payments/merch/checkout/${work.slug}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
			body: JSON.stringify({ color: "black", size: "S4011" }),
		});
		expect(res.status).toBe(503);
		// Nothing reached Printful and nothing was bought.
		expect(printfulCalls).toHaveLength(0);
		expect((await db.select().from(purchases).where(eq(purchases.workId, work.id))).length).toBe(0);
	});

	it("503s the variants listing when Printful is not configured, but the rows still answer", async () => {
		const work = await makeMerchWork([4022]);
		const res = await req(`/api/payments/merch/${work.slug}/variants`, {
			method: "GET",
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { merchConfigured: boolean };
		expect(body.merchConfigured).toBe(false);
	});
});

describe("The merch quote — the store panel's live estimate", () => {
	/**
	 * The quote route answers, for one (color, size) pick against the buyer's account:
	 * the discounted goods figure, Printful's live shipping rate, and — when the buyer
	 * HAS a saved billing address — the Stripe Tax figure and the tax-inclusive total.
	 * Nothing is charged and no purchase row exists after any of these.
	 */

	/** The two-rate answer the 2026-10-09 probe found — the offset choice preferred by id. */
	const twoRates = [
		{
			id: "STANDARD",
			name: "Standard",
			rate: "5.99",
			currency: "USD",
			minDeliveryDays: 4,
			maxDeliveryDays: 7,
		},
		{
			id: "STANDARD_CARBON_OFFSET",
			name: "Standard (CO2 offset)",
			rate: "6.49",
			currency: "USD",
			minDeliveryDays: 4,
			maxDeliveryDays: 7,
		},
	];

	async function saveQuoteAddress() {
		// The saved address lives on the buyer's Stripe Customer (PR #465); the fake's
		// customer state holds it, and the billing row is the only thing Anthers keeps.
		// California, deliberately: a rate call quoting THIS state (not the checkout's
		// representative CO) is the proof that the quote prices from the buyer's own
		// saved address.
		fake.customerState.customer = {
			name: "Parker Davis",
			deleted: false,
			address: {
				line1: "123 Main St",
				city: "San Francisco",
				state: "CA",
				postal_code: "94103",
				country: "US",
			},
		};
		await db
			.insert(billingAccounts)
			.values({ userId: buyerId, stripeCustomerId: `cus_quote_${run}` });
	}

	it("401s a buyer with no account", async () => {
		const work = await makeMerchWork([4061]);
		const res = await req(`/api/payments/merch/quote/${work.slug}?color=black&size=S4061`, {
			headers: { Origin: ORIGIN }, // no cookie
		});
		expect(res.status).toBe(401);
	});

	it("503s when Printful is not configured, like the checkout", async () => {
		const work = await makeMerchWork([4062]);
		const res = await req(`/api/payments/merch/quote/${work.slug}?color=black&size=S4062`, {
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(503);
	});

	it("refuses a pick with no row, with the checkout's own sentence", async () => {
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4063]);
			printfulAnswer = (call) => {
				if (call.path.startsWith("/shipping")) return twoRates;
				return null;
			};
			const res = await req(`/api/payments/merch/quote/${work.slug}?color=black&size=NOSUCH`, {
				headers: { Origin: ORIGIN, Cookie: buyerCookie },
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toBe("Choose a color and size first.");
		} finally {
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
		}
	});

	it("quotes goods and shipping live, with no saved address answering tax null", async () => {
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4064]);
			printfulAnswer = (call) => {
				if (call.path.startsWith("/shipping")) return twoRates;
				return null;
			};
			const res = await req(`/api/payments/merch/quote/${work.slug}?color=black&size=S4064`, {
				headers: { Origin: ORIGIN, Cookie: buyerCookie },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				listPrice: string;
				goodsPrice: string;
				discount: unknown;
				shipping: string;
				shippingName: string;
				tax: string | null;
				buyerTotal: string | null;
				addressSaved: boolean;
				quotedTo: unknown;
			};
			expect(body.listPrice).toBe("30.00");
			expect(body.goodsPrice).toBe("30.00"); // no Badge — the undiscounted list
			expect(body.discount).toBeNull();
			// The offset rate is the standing choice, carried by id.
			expect(body.shipping).toBe("6.49");
			expect(body.shippingName).toBe("Standard (CO2 offset)");
			// No saved billing address: the tax is honest about where it resolves, and
			// there is no total to show.
			expect(body.tax).toBeNull();
			expect(body.buyerTotal).toBeNull();
			expect(body.addressSaved).toBe(false);
			expect(body.quotedTo).toBeNull();
			// The estimate is Stripe Tax's — no tax call happened without an address.
			expect(fake.taxCalls).toHaveLength(0);
			// The rate was asked live, one item, one shirt — the saved address being
			// absent, the representative state is what the call priced from.
			const rates = printfulCalls.find((c) => c.path.startsWith("/shipping"));
			expect(rates).toBeTruthy();
			expect(rates?.body).toMatchObject({
				recipient: { country_code: "US", state_code: "CO" },
				items: [{ variant_id: expect.any(Number), quantity: 1 }],
			});
		} finally {
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
		}
	});

	it("quotes tax from the saved billing address, and the total adds it", async () => {
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4065]);
			printfulAnswer = (call) => {
				if (call.path.startsWith("/shipping")) return twoRates;
				return null;
			};
			fake.taxCalls.length = 0;
			await saveQuoteAddress();
			const res = await req(`/api/payments/merch/quote/${work.slug}?color=black&size=S4065`, {
				headers: { Origin: ORIGIN, Cookie: buyerCookie },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				shipping: string;
				tax: string | null;
				buyerTotal: string | null;
				addressSaved: boolean;
				quotedTo: { city: string; state: string; postalCode: string } | null;
			};
			// 30.00 goods + 6.49 shipping + 2.34 tax.
			expect(body.tax).toBe("2.34");
			expect(body.buyerTotal).toBe("38.83");
			expect(body.addressSaved).toBe(true);
			expect(body.quotedTo).toMatchObject({
				city: "San Francisco",
				state: "CA",
				postalCode: "94103",
			});

			// The calculation's lines are the session's lines — goods at the clothing
			// code and the shipping line at the delivery code, both exclusive.
			expect(fake.taxCalls).toHaveLength(1);
			const [params] = fake.taxCalls as Array<{
				line_items: Array<{ amount: number; tax_code: string; tax_behavior: string }>;
				shipping_cost: { amount: number; tax_code: string };
				customer_details: {
					address: Record<string, string>;
					address_source: string;
				};
			}>;
			expect(params.line_items[0]).toMatchObject({
				amount: 3000,
				tax_code: "txcd_30011000",
				tax_behavior: "exclusive",
			});
			expect(params.shipping_cost).toMatchObject({
				amount: 649,
				tax_code: "txcd_92010001",
			});
			expect(params.customer_details.address).toMatchObject({
				postal_code: "94103",
				country: "US",
			});
			expect(params.customer_details.address_source).toBe("shipping");

			// The rate call priced from the buyer's own saved state, not the checkout's
			// representative one.
			const [rateCall] = printfulCalls.filter((c) => c.path.startsWith("/shipping"));
			expect(rateCall?.body).toMatchObject({
				recipient: { country_code: "US", state_code: "CA" },
			});
		} finally {
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
			fake.customerState.customer = null;
			await db.delete(billingAccounts).where(eq(billingAccounts.userId, buyerId));
		}
	});

	it("degrades a failed tax estimate to null, not a refusal — the box is a convenience", async () => {
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4066]);
			printfulAnswer = (call) => {
				if (call.path.startsWith("/shipping")) return twoRates;
				return null;
			};
			fake.taxState.fail = true;
			await saveQuoteAddress();
			const res = await req(`/api/payments/merch/quote/${work.slug}?color=black&size=S4066`, {
				headers: { Origin: ORIGIN, Cookie: buyerCookie },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { tax: string | null; addressSaved: boolean };
			expect(body.tax).toBeNull();
			expect(body.addressSaved).toBe(true);
		} finally {
			fake.taxState.fail = false;
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
			await db.delete(billingAccounts).where(eq(billingAccounts.userId, buyerId));
		}
	});
});

describe("The merch resolution — whose physical Work is buyable", () => {
	it("refuses a physical Work that is not the official account's", async () => {
		const work = await insertWork({
			creatorId: buyerId,
			type: "physical",
			title: `Stranger's shirt ${run}`,
			streamEnabled: false,
			downloadEnabled: false,
			access: [{ threshold: 0, allow: true, price: "5.00" }],
		});
		const res = await req(`/api/payments/merch/${work.slug}/variants`, {
			method: "GET",
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(400);
	});

	it("refuses a merch Work whose body names a color+size with no row", async () => {
		printfulCalls.length = 0;
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4033]);
			// Catalog answers a variant, so the only refusal can be the size's.
			printfulAnswer = (call) => {
				if (call.path.startsWith("/products/4033")) return { variants: [catalogVariant("S")] };
				if (call.path.startsWith("/shipping"))
					return [
						{
							id: "STANDARD",
							name: "Standard",
							rate: "4.99",
							currency: "USD",
							minDeliveryDays: 3,
							maxDeliveryDays: 6,
						},
					];
				return null;
			};
			const res = await req(`/api/payments/merch/checkout/${work.slug}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
				body: JSON.stringify({ color: "black", size: "NOSUCH" }),
			});
			expect(res.status).toBe(400);
		} finally {
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
		}
	});
});

describe("The goods-works rule — the picker reads without an account, owning is not a gate", () => {
	/**
	 * Parker, 2026-10-09: a physical Work's deliverable is the goods themselves, so the
	 * Public Access postures (sign-in walls, free-commons reading, purchase-forever)
	 * never apply. What that means at these routes: the picker answers a signed-out
	 * visitor with the undiscounted list (the Badge discount needs an account by
	 * construction, but seeing the price does not), the work's owner may read their own
	 * store where the old "already have access" verdict used to refuse them, and a past
	 * buyer may buy again — a shirt is a shipment, not an unlock.
	 */
	it("answers a signed-out visitor's picker with the undiscounted list", async () => {
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4044], {
				// The color's mockup, stamped by the setup script and read like any price.
				mockupUrl: "https://files.cdn.printful.com/merch/tee-black-preview.png",
			});
			const res = await req(`/api/payments/merch/${work.slug}/variants`, {
				method: "GET",
				headers: { Origin: ORIGIN }, // no cookie — a visitor with no account
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				colors: {
					mockupUrl: string | null;
					sizes: { amount: string; discount: string | null }[];
				}[];
			};
			expect(body.colors[0].sizes.length).toBeGreaterThan(0);
			expect(body.colors[0].mockupUrl).toBe(
				"https://files.cdn.printful.com/merch/tee-black-preview.png",
			);
			expect(body.colors[0].sizes[0].discount).toBeNull();
			expect(body.colors[0].sizes[0].amount).toBe("30.00");
		} finally {
			delete process.env.PRINTFUL_TOKEN;
		}
	});

	it("lets a past buyer buy again", async () => {
		printfulCalls.length = 0;
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4055]);
			printfulAnswer = (call) => {
				if (call.path.startsWith("/shipping"))
					return [
						{
							id: "STANDARD",
							name: "Standard",
							rate: "4.99",
							currency: "USD",
							minDeliveryDays: 3,
							maxDeliveryDays: 6,
						},
					];
				return null;
			};
			// The completed physical purchase the resolver used to read as forever-open.
			await db.insert(purchases).values({
				buyerId,
				workId: work.id,
				type: "physical" as const,
				amount: "30.00",
				processingFee: "1.17",
				salesTax: "0.00",
				creatorEarnings: "0.00",
				stripePaymentIntentId: `pi_merch_repeat_${run}`,
				status: "completed" as const,
			});
			const res = await req(`/api/payments/merch/checkout/${work.slug}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
				body: JSON.stringify({ color: "black", size: "S4055" }),
			});
			// Not 400 "You already have access" — the shirt's deliverable granted nothing.
			expect(res.status).toBe(200);
			const body = (await res.json()) as { clientSecret?: string };
			expect(body.clientSecret).toBeTruthy();
		} finally {
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
		}
	});
});

describe("The webhook receiver — the payload is a hint, the API is the truth", () => {
	it("writes state only from the API's answer, never from the payload", async () => {
		process.env.PRINTFUL_TOKEN = "not_a_real_printful_token";
		try {
			const work = await makeMerchWork([4044]);
			// The purchase + fulfillment that the event is about.
			const [purchase] = await db
				.insert(purchases)
				.values({
					buyerId,
					workId: work.id,
					type: "physical",
					amount: "14.49",
					processingFee: "0.75",
					creatorEarnings: "4.99",
					stripePaymentIntentId: `pi_merch_${run}`,
					status: "completed",
					merchSize: "S4044",
				})
				.returning();
			const [fulfillment] = await db
				.insert(merchFulfillments)
				.values({
					purchaseId: purchase.id,
					printfulOrderId: 777,
					printfulStatus: "inprocess",
					placedAt: new Date(),
				})
				.returning();

			// The API's answer says "fulfilled" — regardless of what the payload claimed.
			printfulAnswer = () => ({
				id: 777,
				external_id: `purchase-${purchase.id}`,
				status: "fulfilled",
				costs: {
					currency: "USD",
					subtotal: "9.50",
					discount: "0",
					shipping: "4.99",
					tax: "0",
					vat: "0",
					total: "14.49",
				},
				retail_costs: null,
				shipments: [
					{
						id: 1,
						carrier: "FEDEX",
						service: "Ground",
						tracking_number: "123",
						tracking_url: "https://example.com/track/777",
						ship_date: "2026-10-08",
						shipped_at: null,
					},
				],
			});
			// No Origin header, on purpose: Printful's v1 webhooks are unsigned and send
			// none, so `/api/webhooks/printful` sits in `CSRF_EXEMPT_PATHS` with the
			// payload-is-a-hint design as its proof — if that exemption is ever lost, the
			// receiver 403s in production while this suite stays green. Same reasoning
			// the Stripe webhook test records; the hint-verification below is the
			// assertion that no state rides the payload.
			const res = await req("/api/webhooks/printful", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					type: "package_shipped",
					created: Math.floor(Date.now() / 1000),
					retries: 0,
					store: 1,
					data: { order: { id: 777, status: "draft" } }, // the payload lies
				}),
			});
			expect(res.status).toBe(200);
			// The read-back fetch happened — the receiver did not trust the payload.
			expect(printfulCalls.some((c) => c.path === `/orders/777`)).toBe(true);

			const [after] = await db
				.select()
				.from(merchFulfillments)
				.where(eq(merchFulfillments.id, fulfillment.id))
				.limit(1);
			// State came from the API's answer, not the payload's "draft".
			expect(after.printfulStatus).toBe("fulfilled");
			expect(after.trackingUrl).toBe("https://example.com/track/777");
			expect(after.events.some((e) => e.type === "webhook_package_shipped")).toBe(true);
		} finally {
			delete process.env.PRINTFUL_TOKEN;
			printfulCalls.length = 0;
		}
	});

	it("answers success on an order this store does not hold", async () => {
		const res = await req("/api/webhooks/printful", {
			method: "POST",
			headers: { "Content-Type": "application/json" }, // no Origin — see above
			body: JSON.stringify({
				type: "order_updated",
				created: Math.floor(Date.now() / 1000),
				retries: 0,
				store: 1,
				data: { order: { id: 999999 } },
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matched: number };
		expect(body.matched).toBe(0);
	});
});
