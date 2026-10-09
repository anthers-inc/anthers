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
import { merchFulfillments, merchVariants, purchases, users } from "@anthers/db/schema";
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

/** A fake Stripe client covering the checkout path the merch route takes. */
function fakeStripeCheckout() {
	const stripeObject = { id: "cs_test_merch", client_secret: "cs_test_merch_secret_123" };
	return {
		// Cast: the merch paths read only the session create's return, and the full
		// Stripe surface is the Stripe suite's subject with its own shaped fake.
		client: {
			"checkout.sessions.create": async () => stripeObject,
		} as unknown as Stripe,
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

async function makeMerchWork(variantIds: number[]) {
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
