// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Stripe money path — the code that carries the economics into Stripe and back.
 *
 * `economics.test.ts` pins the numbers themselves; nothing pinned the code that *spends*
 * them. This file covers the things that had no test at all: the "payments are not
 * configured" guards, webhook signature verification, webhook idempotency, the
 * destination-charge construction (which creator gets the money, and how much of the
 * buyer's total is the application fee), and — at the far end of the same path — the
 * clamp that stops a negative remainder reaching the ledger at settlement.
 *
 * **Nothing here reaches the network.** `setStripeClient` swaps in a recording fake, which
 * is the whole reason `lib/stripe.ts` stopped exporting a `const` — see the note there. The
 * one part deliberately NOT faked is `webhooks`, which is delegated to a real `Stripe`
 * instance so signature verification runs the real HMAC: a fake that returns whatever it is
 * handed would assert nothing, since accepting a forged event is precisely the failure mode.
 *
 * The webhook requests below send **no `Origin` header** on purpose. Stripe doesn't send one,
 * so `/api/payments/stripe/webhook` is in `CSRF_EXEMPT_PATHS`; if that exemption is ever lost
 * the whole webhook path dies in production while every other test stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	accountCycles,
	accounts,
	assets,
	attentionEvents,
	crfLedger,
	purchases,
	stripeAccounts,
	users,
} from "@anthers/db/schema";
import { seedCost } from "@anthers/shared/constants";
import { calculateFees, cardFee } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { settleCycle } from "../jobs/settle-cycle";
import { getStripe, setStripeClient } from "../lib/stripe";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";
import { insertWork } from "./work-fixtures.js";

const testFetch = app.fetch;
const ORIGIN = "http://localhost:3000";
const WEBHOOK_SECRET = "whsec_test_secret_for_signature_verification";
/** Never used against the API — only to construct a real `webhooks` helper for HMAC. */
const FAKE_KEY = "sk_test_fake_no_network";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

// ── The fake Stripe client ───────────────────────────────────────────────────

interface Call {
	method: string;
	args: unknown[];
}

/**
 * A recording stand-in for the SDK, covering exactly the surface the app touches.
 * `responses` is mutable so a test can decide what a call returns; every call is
 * recorded so a test can assert on the *parameters we sent Stripe*, which for the
 * destination charge is the only thing that matters and the only thing we control.
 */
function fakeStripe() {
	const calls: Call[] = [];
	const responses: Record<string, unknown> = {};
	const real = new Stripe(FAKE_KEY);

	const record =
		(method: string, fallback: (...args: never[]) => unknown) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			const canned = responses[method];
			return Promise.resolve(
				canned !== undefined ? canned : (fallback as (...a: unknown[]) => unknown)(...args),
			);
		};

	const client = {
		// Real crypto, on purpose — see the file header.
		webhooks: real.webhooks,
		accounts: {
			create: record("accounts.create", () => ({ id: `acct_${uid()}` })),
		},
		accountLinks: {
			create: record("accountLinks.create", () => ({ url: "https://connect.stripe.test/onboard" })),
		},
		customers: {
			create: record("customers.create", () => ({ id: `cus_${uid()}` })),
		},
		paymentMethods: {
			list: record("paymentMethods.list", () => ({ data: [] })),
		},
		paymentIntents: {
			// A fresh id per call: `purchases.stripe_payment_intent_id` is UNIQUE, so a
			// constant would make the second checkout in a test fail on the insert.
			create: record("paymentIntents.create", () => {
				const id = `pi_${uid()}`;
				return { id, client_secret: `${id}_secret_test` };
			}),
		},
		subscriptions: {
			create: record("subscriptions.create", () => ({
				id: `sub_${uid()}`,
				latest_invoice: { confirmation_secret: { client_secret: "pi_test_secret" } },
			})),
			retrieve: record("subscriptions.retrieve", (id: string) => subscription({ id })),
			update: record("subscriptions.update", (id: string) => subscription({ id })),
		},
		invoices: {
			createPreview: record("invoices.createPreview", () => ({ amount_due: 300 })),
		},
		billingPortal: {
			sessions: {
				create: record("billingPortal.sessions.create", () => ({
					url: "https://billing.stripe.test/session",
				})),
			},
		},
	} as unknown as Stripe;

	return {
		client,
		calls,
		responses,
		callsTo: (method: string) => calls.filter((c) => c.method === method),
		lastCall: (method: string) => calls.filter((c) => c.method === method).at(-1),
		reset: () => {
			calls.length = 0;
		},
	};
}

type Fake = ReturnType<typeof fakeStripe>;

// ── Stripe object fixtures ───────────────────────────────────────────────────

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/**
 * A subscription shaped the way `syncSubscriptionToAccount` reads it. Note that the
 * period end hangs off the **line item**, not the subscription — that moved in the
 * 2026-02 API version and is the kind of thing a hand-rolled fixture gets wrong once
 * and then asserts forever.
 */
function subscription(opts: {
	id?: string;
	customer?: string;
	status?: string;
	quantity?: number;
	periodEnd?: number;
	cancelAtPeriodEnd?: boolean;
}) {
	return {
		id: opts.id ?? `sub_${uid()}`,
		object: "subscription",
		customer: opts.customer ?? `cus_${uid()}`,
		status: opts.status ?? "active",
		cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
		items: {
			object: "list",
			data: [
				{
					id: `si_${uid()}`,
					quantity: opts.quantity ?? 1,
					current_period_end: opts.periodEnd ?? 1_800_000_000,
				},
			],
		},
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

/**
 * Sign a payload the way Stripe signs it. The **async** helper is required: under Bun the
 * SDK selects its SubtleCrypto provider, and the synchronous `generateTestHeaderString`
 * throws outright there.
 */
function sign(body: string, secret = WEBHOOK_SECRET): Promise<string> {
	return signer.webhooks.generateTestHeaderStringAsync({ payload: body, secret });
}

/** POST a webhook with a real signature, and deliberately no Origin header. */
async function sendWebhook(
	payload: object,
	opts: { secret?: string; signature?: string; omitSignature?: boolean } = {},
) {
	const body = JSON.stringify(payload);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (!opts.omitSignature) {
		headers["stripe-signature"] = opts.signature ?? (await sign(body, opts.secret));
	}
	return req("/api/payments/stripe/webhook", { method: "POST", headers, body });
}

// ── Account / user fixtures ──────────────────────────────────────────────────

const signer = new Stripe(FAKE_KEY);
const run = crypto.randomUUID().slice(0, 8);
const creatorName = `pay_creator_${run}`;
const buyerName = `pay_buyer_${run}`;
const subscriberName = `pay_sub_${run}`;

let fake: Fake;
let realClient: Stripe | null;
let previousWebhookSecret: string | undefined;

let creatorCookie: string;
let buyerCookie: string;
let subscriberCookie: string;
let creatorId: number;
let buyerId: number;
let subscriberId: number;
let paidSlug: string;
let paidWorkId: number;
/**
 * A second priced post, used by the webhook tests only. They insert *completed* purchase
 * rows, and a completed purchase is permanent access — pointed at the checkout post it
 * would make every later checkout 400 with "you already have access", which is a fixture
 * accident rather than a finding.
 */
let webhookWorkId: number;

/** Sign up and mark the address verified — `requireVerified` gates checkout and billing. */
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
	const cookie = res.headers.get("Set-Cookie")!.split(";")[0];
	const [row] = await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.username, username))
		.returning({ id: users.id });
	return { cookie, id: row.id };
}

const LOCKED = [{ threshold: 0, allow: false, price: "0" }];
/** $5.00 to anyone, at any Anthers-Seed count — a purchasable post with no ladder route in. */
const PRICE = "5.00";
const FOR_SALE = [{ threshold: 0, allow: true, price: PRICE }];
/**
 * 2 GiB of downloadable asset. It used to make the delivery deduction non-zero; that
 * deduction was retired 2026-08-12, and the size is kept so the fixture is still a
 * realistic Work rather than an empty one.
 */
const ASSET_BYTES = 2 * 1024 * 1024 * 1024;

beforeAll(async () => {
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${subscriberName})`,
	);

	realClient = getStripe();
	fake = fakeStripe();
	setStripeClient(fake.client);
	previousWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
	process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

	({ cookie: creatorCookie, id: creatorId } = await signUp(creatorName));
	({ cookie: buyerCookie, id: buyerId } = await signUp(buyerName));
	({ cookie: subscriberCookie, id: subscriberId } = await signUp(subscriberName));

	const paid = await makePaidPost(`Paid post ${run}`);
	paidSlug = paid.slug;
	paidWorkId = paid.id;
	webhookWorkId = (await makePaidPost(`Webhook work ${run}`)).id;
}, DB_SETUP_TIMEOUT);

/**
 * A released, download-only Work that is for sale. Checkout names a WORK now — that is
 * where the gate lives, and what a permanent unlock has to be permanent about.
 */
async function makePaidPost(title: string): Promise<{ slug: string; id: number }> {
	const work = await insertWork({
		creatorId,
		type: "game",
		title,
		streamEnabled: false,
		downloadEnabled: true,
		anthersAccess: FOR_SALE,
		seedAccess: LOCKED,
	});
	await db.insert(assets).values({
		workId: work.id,
		file: `creators/${creatorId}/builds/${uid()}.zip`,
		filename: `${uid()}.zip`,
		fileSize: ASSET_BYTES,
	});
	return { slug: work.slug, id: work.id };
}

afterAll(async () => {
	setStripeClient(realClient);
	if (previousWebhookSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
	else process.env.STRIPE_WEBHOOK_SECRET = previousWebhookSecret;
	await db.execute(
		sql`DELETE FROM users WHERE username IN (${creatorName}, ${buyerName}, ${subscriberName})`,
	);
});

/** Run a block with payments unconfigured, restoring the fake afterwards. */
async function withoutStripe(fn: () => Promise<void>) {
	setStripeClient(null);
	try {
		await fn();
	} finally {
		setStripeClient(fake.client);
	}
}

// ─────────────────────────────────────────────────────────────────────────────

describe("Payments not configured — every guarded route refuses", () => {
	/**
	 * Each of these used to be untestable: `stripe` was a module const, so whether the
	 * branch was reachable depended on whether the machine running the suite had a
	 * `.env`. Locally they were all unreachable; in CI they were all that ran.
	 */
	const json = { "Content-Type": "application/json", Origin: ORIGIN };

	it("refuses Connect onboarding", async () => {
		await withoutStripe(async () => {
			const res = await req("/api/payments/stripe/onboard", {
				method: "POST",
				headers: { ...json, Cookie: creatorCookie },
			});
			expect(res.status).toBe(503);
			expect((await res.json()).error).toBe("Payments are not configured.");
		});
	});

	it("refuses checkout", async () => {
		await withoutStripe(async () => {
			const res = await req(`/api/payments/checkout/${paidSlug}`, {
				method: "POST",
				headers: { ...json, Cookie: buyerCookie },
			});
			expect(res.status).toBe(503);
		});
	});

	it("refuses the webhook", async () => {
		await withoutStripe(async () => {
			const res = await sendWebhook(stripeEvent("payment_intent.succeeded", { id: "pi_nope" }));
			expect(res.status).toBe(503);
		});
	});

	it("refuses the Anthers-Seed preview", async () => {
		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/preview/1", {
				headers: { Cookie: subscriberCookie },
			});
			expect(res.status).toBe(503);
		});
	});

	it("refuses setting the Anthers-Seed count", async () => {
		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/account", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
				body: JSON.stringify({ anthersSeeds: 2 }),
			});
			expect(res.status).toBe(503);
		});
	});

	it("refuses buying directed Seeds", async () => {
		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/seeds/buy", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
				body: JSON.stringify({ quantity: 2 }),
			});
			expect(res.status).toBe(503);
		});
	});

	it("refuses the billing portal", async () => {
		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/billing-portal", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
			});
			expect(res.status).toBe(503);
		});
	});

	/**
	 * The two that matter most, and the reason PR #142 exists. These read `if (stripe && …)`
	 * before that PR, which SKIPPED Stripe and mutated the row anyway — the UI showed a
	 * cancelled subscription that Stripe kept billing. So asserting the 503 is only half the
	 * test; the other half is that the database did not move.
	 */
	it("refuses to cancel — and leaves the account untouched", async () => {
		await db
			.insert(accounts)
			.values({ userId: subscriberId, anthersSeeds: 2, stripeSubscriptionId: `sub_${uid()}` })
			.onConflictDoUpdate({
				target: accounts.userId,
				set: { anthersSeeds: 2, canceledAt: null },
			});

		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/cancel", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
			});
			expect(res.status).toBe(503);
		});

		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(acct.canceledAt).toBeNull();
		expect(acct.anthersSeeds).toBe(2);
	});

	it("refuses to resume — and leaves the cancellation in place", async () => {
		const canceledAt = new Date();
		await db.update(accounts).set({ canceledAt }).where(eq(accounts.userId, subscriberId));

		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/resume", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
			});
			expect(res.status).toBe(503);
		});

		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(acct.canceledAt).not.toBeNull();
	});
});

describe("Webhook signature verification", () => {
	it("rejects a request with no signature header", async () => {
		const res = await sendWebhook(stripeEvent("payment_intent.succeeded", { id: "pi_x" }), {
			omitSignature: true,
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Missing signature or webhook secret.");
	});

	it("rejects a signature computed with the wrong secret", async () => {
		const res = await sendWebhook(stripeEvent("payment_intent.succeeded", { id: "pi_x" }), {
			secret: "whsec_a_different_secret_entirely",
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("Signature verification failed.");
	});

	it("rejects a made-up signature header", async () => {
		const res = await sendWebhook(stripeEvent("payment_intent.succeeded", { id: "pi_x" }), {
			signature: "t=1,v1=deadbeef",
		});
		expect(res.status).toBe(400);
	});

	it("rejects a valid signature over a DIFFERENT body", async () => {
		// The signature is the HMAC of the bytes; swapping the payload after signing is
		// exactly what an attacker would try, and what verifying the raw body prevents.
		const signed = JSON.stringify(stripeEvent("payment_intent.succeeded", { id: "pi_original" }));
		const signature = await sign(signed);
		const res = await req("/api/payments/stripe/webhook", {
			method: "POST",
			headers: { "Content-Type": "application/json", "stripe-signature": signature },
			body: JSON.stringify(stripeEvent("payment_intent.succeeded", { id: "pi_swapped" })),
		});
		expect(res.status).toBe(400);
	});

	it("rejects when no webhook secret is configured", async () => {
		const saved = process.env.STRIPE_WEBHOOK_SECRET;
		delete process.env.STRIPE_WEBHOOK_SECRET;
		try {
			const res = await sendWebhook(stripeEvent("payment_intent.succeeded", { id: "pi_x" }));
			expect(res.status).toBe(400);
		} finally {
			process.env.STRIPE_WEBHOOK_SECRET = saved;
		}
	});

	it("accepts a correctly signed event with no Origin header (the CSRF exemption)", async () => {
		const res = await sendWebhook(stripeEvent("invoice.paid", { id: "in_ignored" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
	});
});

describe("Webhook: payment_intent.succeeded", () => {
	it("completes a pending post purchase and books the ledger row once", async () => {
		const piId = `pi_${uid()}`;
		const [pending] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId: webhookWorkId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				deliveryFee: "0.02",
				crfFee: "0.01",
				creatorEarnings: "5.00",
				stripePaymentIntentId: piId,
				status: "pending",
			})
			.returning();

		const event = stripeEvent("payment_intent.succeeded", { id: piId, object: "payment_intent" });
		expect((await sendWebhook(event)).status).toBe(200);

		const [row] = await db.select().from(purchases).where(eq(purchases.id, pending.id));
		expect(row.status).toBe("completed");

		const ledger = await db.select().from(crfLedger).where(eq(crfLedger.purchaseId, pending.id));
		expect(ledger).toHaveLength(1);
		expect(new Decimal(ledger[0].amount).toFixed(2)).toBe("0.01");

		// Redelivery — Stripe retries, and it must not book the fee a second time. The
		// idempotency is structural (`WHERE status = 'pending'`), which is easy to lose in
		// a refactor and impossible to notice without this assertion.
		expect((await sendWebhook(event)).status).toBe(200);
		const after = await db.select().from(crfLedger).where(eq(crfLedger.purchaseId, pending.id));
		expect(after).toHaveLength(1);
	});

	it("credits a Seed buy to the account exactly once", async () => {
		await db
			.insert(accounts)
			.values({ userId: buyerId, creatorSeedTotal: "0.00" })
			.onConflictDoUpdate({ target: accounts.userId, set: { creatorSeedTotal: "0.00" } });

		const piId = `pi_${uid()}`;
		const [pending] = await db
			.insert(purchases)
			.values({
				buyerId,
				// A Seed buy unlocks nothing, so it names no Work.
				workId: null,
				type: "seeds",
				amount: "9.00",
				processingFee: "0.56",
				crfFee: "0.00",
				creatorEarnings: "0.00",
				stripePaymentIntentId: piId,
				status: "pending",
			})
			.returning();

		const event = stripeEvent("payment_intent.succeeded", { id: piId, object: "payment_intent" });
		expect((await sendWebhook(event)).status).toBe(200);

		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, buyerId));
		expect(new Decimal(acct.creatorSeedTotal).toFixed(2)).toBe("9.00");

		// A Seed buy is not a post purchase — it must not touch the charitable ledger.
		const ledger = await db.select().from(crfLedger).where(eq(crfLedger.purchaseId, pending.id));
		expect(ledger).toHaveLength(0);

		// …and the cycle snapshot exists, which is what the account page reads back.
		const cycles = await db.select().from(accountCycles).where(eq(accountCycles.userId, buyerId));
		expect(cycles.length).toBeGreaterThan(0);

		// Redelivery must not double-credit: $9 stays $9, it does not become $18.
		expect((await sendWebhook(event)).status).toBe(200);
		const [again] = await db.select().from(accounts).where(eq(accounts.userId, buyerId));
		expect(new Decimal(again.creatorSeedTotal).toFixed(2)).toBe("9.00");
	});

	it("ignores a PaymentIntent it has no purchase row for", async () => {
		const res = await sendWebhook(
			stripeEvent("payment_intent.succeeded", { id: `pi_${uid()}`, object: "payment_intent" }),
		);
		expect(res.status).toBe(200);
	});
});

describe("Webhook: payment_intent.payment_failed", () => {
	it("marks a pending purchase failed", async () => {
		const piId = `pi_${uid()}`;
		const [pending] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId: webhookWorkId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				crfFee: "0.01",
				creatorEarnings: "5.00",
				stripePaymentIntentId: piId,
				status: "pending",
			})
			.returning();

		expect(
			(await sendWebhook(stripeEvent("payment_intent.payment_failed", { id: piId }))).status,
		).toBe(200);
		const [row] = await db.select().from(purchases).where(eq(purchases.id, pending.id));
		expect(row.status).toBe("failed");
	});

	it("never reverts an already-completed purchase", async () => {
		// A late-arriving failure for a PaymentIntent that already succeeded must not
		// revoke access the buyer has already paid for.
		const piId = `pi_${uid()}`;
		const [row] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId: webhookWorkId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				crfFee: "0.01",
				creatorEarnings: "5.00",
				stripePaymentIntentId: piId,
				status: "completed",
			})
			.returning();

		await sendWebhook(stripeEvent("payment_intent.payment_failed", { id: piId }));
		const [after] = await db.select().from(purchases).where(eq(purchases.id, row.id));
		expect(after.status).toBe("completed");
	});
});

describe("Webhook: account.updated", () => {
	it("syncs the connected account's capabilities", async () => {
		const acctId = `acct_${uid()}`;
		await db.insert(stripeAccounts).values({ userId: creatorId, stripeAccountId: acctId });

		await sendWebhook(
			stripeEvent("account.updated", {
				id: acctId,
				object: "account",
				charges_enabled: true,
				payouts_enabled: true,
				details_submitted: true,
			}),
		);

		const [row] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.stripeAccountId, acctId));
		expect(row.chargesEnabled).toBe(true);
		expect(row.payoutsEnabled).toBe(true);
		expect(row.onboardingComplete).toBe(true);
	});

	it("holds onboarding incomplete until charges are actually enabled", async () => {
		// `details_submitted && charges_enabled` — submitting the form is not the same as
		// Stripe having approved the account, and treating it as such would route a
		// destination charge at an account that cannot receive it.
		const acctId = `acct_${uid()}`;
		await db.insert(stripeAccounts).values({ userId: buyerId, stripeAccountId: acctId });

		await sendWebhook(
			stripeEvent("account.updated", {
				id: acctId,
				object: "account",
				charges_enabled: false,
				payouts_enabled: false,
				details_submitted: true,
			}),
		);

		const [row] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.stripeAccountId, acctId));
		expect(row.onboardingComplete).toBe(false);
	});
});

describe("Webhook: customer.subscription.*", () => {
	const customerId = `cus_sub_${crypto.randomUUID().slice(0, 8)}`;
	let subId: string;

	beforeAll(async () => {
		subId = `sub_${uid()}`;
		await db
			.insert(accounts)
			.values({ userId: subscriberId, stripeCustomerId: customerId, anthersSeeds: 0 })
			.onConflictDoUpdate({
				target: accounts.userId,
				set: { stripeCustomerId: customerId, anthersSeeds: 0, stripeSubscriptionId: "" },
			});
	}, DB_SETUP_TIMEOUT);

	it("takes the Anthers-Seed count from the line item quantity", async () => {
		const periodEnd = 1_900_000_000;
		await sendWebhook(
			stripeEvent(
				"customer.subscription.created",
				subscription({ id: subId, customer: customerId, quantity: 3, periodEnd }),
			),
		);

		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(acct.anthersSeeds).toBe(3);
		expect(acct.isActive).toBe(true);
		expect(acct.stripeSubscriptionId).toBe(subId);
		// The period end reads off the ITEM, not the subscription — the 2026-02 API move.
		expect(acct.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
	});

	it("follows a quantity change up and down", async () => {
		await sendWebhook(
			stripeEvent(
				"customer.subscription.updated",
				subscription({ id: subId, customer: customerId, quantity: 1 }),
			),
		);
		const [down] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(down.anthersSeeds).toBe(1);
	});

	it("records a pending cancellation without dropping the Seeds", async () => {
		// cancel_at_period_end means the Seeds keep working until the cycle ends.
		await sendWebhook(
			stripeEvent(
				"customer.subscription.updated",
				subscription({ id: subId, customer: customerId, quantity: 1, cancelAtPeriodEnd: true }),
			),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(acct.canceledAt).not.toBeNull();
		expect(acct.anthersSeeds).toBe(1);
	});

	it("ignores a canceled subscription that isn't the account's current one", async () => {
		// A stale event for an old subscription must not revert an account that has since
		// resubscribed under a new one.
		await sendWebhook(
			stripeEvent(
				"customer.subscription.deleted",
				subscription({ id: `sub_${uid()}`, customer: customerId, status: "canceled" }),
			),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(acct.anthersSeeds).toBe(1);
		expect(acct.stripeSubscriptionId).toBe(subId);
	});

	it("reverts to Free when the current subscription is canceled", async () => {
		await sendWebhook(
			stripeEvent(
				"customer.subscription.deleted",
				subscription({ id: subId, customer: customerId, status: "canceled", quantity: 1 }),
			),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, subscriberId));
		expect(acct.anthersSeeds).toBe(0);
		expect(acct.stripeSubscriptionId).toBe("");
		expect(acct.canceledAt).toBeNull();
	});

	it("is a no-op for a customer we have no account for", async () => {
		const res = await sendWebhook(
			stripeEvent("customer.subscription.updated", subscription({ customer: `cus_${uid()}` })),
		);
		expect(res.status).toBe(200);
	});
});

describe("Checkout — destination charge construction", () => {
	/** The fee breakdown the route should be quoting, computed independently here. */
	const expected = calculateFees(new Decimal(PRICE), { type: "digital" });

	async function checkout() {
		fake.reset();
		const res = await req(`/api/payments/checkout/${paidSlug}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
		});
		return { res, body: await res.json() };
	}

	/** A creator who can actually be paid — now a precondition of checkout, not a mode. */
	async function connectCreator(acctId = `acct_${uid()}`) {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, creatorId));
		await db.insert(stripeAccounts).values({
			userId: creatorId,
			stripeAccountId: acctId,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
		return acctId;
	}

	beforeAll(async () => {
		await connectCreator();
	}, DB_SETUP_TIMEOUT);

	it("quotes the all-in breakdown and records a pending purchase", async () => {
		const { res, body } = await checkout();
		expect(res.status).toBe(200);

		// The list price is what the buyer was shown; the creator receives it less the
		// at-cost card processing and the first download. Anthers retains none of it.
		expect(body.amount).toBe(PRICE);
		expect(body.crfFee).toBe("0.00");
		expect(body.creatorEarnings).toBe(expected.creatorEarnings.toFixed(2));
		expect(new Decimal(body.creatorEarnings).lessThan(new Decimal(PRICE))).toBe(true);
		expect(body.deliveryFee).toBe(expected.deliveryFee.toFixed(2));
		expect(body.crfFee).toBe(expected.crfFee.toFixed(2));
		expect(body.processingFee).toBe(expected.processingFee.toFixed(2));
		expect(body.salesTax).toBe(expected.salesTax.toFixed(2));
		expect(body.buyerTotal).toBe(expected.buyerTotal.toFixed(2));

		const created = fake.lastCall("paymentIntents.create");
		const params = created?.args[0] as Stripe.PaymentIntentCreateParams;
		expect(params.amount).toBe(Math.round(expected.buyerTotal.toNumber() * 100));
		expect(params.currency).toBe("usd");
		expect(params.metadata).toMatchObject({
			kind: "direct_purchase",
			workId: String(paidWorkId),
			buyerId: String(buyerId),
		});
	});

	// The branch this replaces used to charge the buyer and hold the money on the platform
	// when the creator had no connected account. It was unreachable from the product — the
	// buy UI refuses to render without `creatorHasStripe` — and survived precisely because
	// nothing asserted it. A connected creator is now a precondition, and the failure is
	// loud: no charge is created at all, so no money moves that nobody can settle.
	it("refuses checkout, and creates no PaymentIntent, when the creator can't be paid", async () => {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, creatorId));

		const { res } = await checkout();
		expect(res.status).toBe(409);
		expect(fake.lastCall("paymentIntents.create")).toBeUndefined();

		await connectCreator();
	});

	it("refuses when onboarding started but payouts are not enabled", async () => {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, creatorId));
		await db.insert(stripeAccounts).values({
			userId: creatorId,
			stripeAccountId: `acct_${uid()}`,
			chargesEnabled: true,
			payoutsEnabled: false,
			onboardingComplete: true,
		});

		const { res } = await checkout();
		expect(res.status).toBe(409);
		expect(fake.lastCall("paymentIntents.create")).toBeUndefined();

		await connectCreator();
	});

	it("routes the creator their earnings and retains no platform cut", async () => {
		const acctId = await connectCreator();

		const { res, body } = await checkout();
		expect(res.status).toBe(200);

		const params = fake.lastCall("paymentIntents.create")?.args[0] as
			| Stripe.PaymentIntentCreateParams
			| undefined;
		expect(params?.transfer_data).toEqual({ destination: acctId });

		const totalCents = Math.round(expected.buyerTotal.toNumber() * 100);
		expect(params?.amount).toBe(totalCents);

		// The assertion that matters, stated in STRIPE's terms rather than ours: on a
		// destination charge the connected account receives `amount −
		// application_fee_amount`, so that difference has to BE the creator's earnings.
		// Anything else and the transfer disagrees with the `creator_earnings` we
		// record, which is how money goes missing without an error.
		//
		// This is deliberately not written as `total − fee − processing === earnings`.
		// That was the old assertion, and it passed for two months against a fee that
		// was short by exactly the card processing — because it restated the route's own
		// formula instead of Stripe's semantics, so it could only ever agree with the
		// code. Stripe debits its processing from the PLATFORM, never from the transfer.
		const feeCents = params?.application_fee_amount ?? 0;
		expect(totalCents - feeCents).toBe(Math.round(expected.creatorEarnings.toNumber() * 100));

		// And what the platform is left holding, once Stripe has taken its cut, is sales
		// tax owed to the state and NOTHING else — no platform cut, and since 2026-08-12
		// no delivery either, so this is now an exact equality with the tax.
		const processingCents = Math.round(expected.processingFee.toNumber() * 100);
		expect(feeCents - processingCents).toBe(Math.round(expected.salesTax.toNumber() * 100));
		expect(body.creatorEarnings).toBe(expected.creatorEarnings.toFixed(2));
	});

	it("writes the pending purchase keyed by the PaymentIntent", async () => {
		const { res, body } = await checkout();
		expect(res.status).toBe(200);

		// The route hands back the PaymentIntent's client secret; the row it wrote must be
		// keyed by that same intent, because the webhook has nothing else to match on.
		const intentId = String(body.clientSecret).replace(/_secret_test$/, "");
		const [row] = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, intentId))
			.limit(1);

		expect(row).toBeDefined();
		expect(row.status).toBe("pending");
		expect(row.buyerId).toBe(buyerId);
		expect(row.workId).toBe(paidWorkId);
		expect(new Decimal(row.amount).toFixed(2)).toBe(PRICE);
		expect(new Decimal(row.creatorEarnings).toFixed(2)).toBe(expected.creatorEarnings.toFixed(2));
		// The purchase fee was removed 2026-08-03; the NOT NULL column stays and
		// is always zero, so a row that ever carries a non-zero value is a regression.
		expect(new Decimal(row.crfFee).toFixed(2)).toBe("0.00");
		// Sales tax is charged inside `buyerTotal` and owed onward, so the row has to record
		// it — the amount collected is otherwise unrecoverable from the purchase, which is a
		// remittance-reporting gap rather than a display bug.
		expect(new Decimal(row.salesTax).toFixed(2)).toBe(expected.salesTax.toFixed(2));
		expect(new Decimal(row.salesTax).greaterThan(0)).toBe(true);
	});

	it("refuses to sell a Work the buyer can already access", async () => {
		// Mark the newest pending purchase completed → resolveAccess now says "purchased",
		// and a second checkout must be rejected rather than charging twice.
		const [row] = await db
			.select()
			.from(purchases)
			.where(and(eq(purchases.buyerId, buyerId), eq(purchases.workId, paidWorkId)))
			.orderBy(sql`${purchases.id} DESC`)
			.limit(1);
		await db.update(purchases).set({ status: "completed" }).where(eq(purchases.id, row.id));

		const { res, body } = await checkout();
		expect(res.status).toBe(400);
		expect(body.error).toBe("You already have access to this work");
	});
});

/**
 * The Seed buy was the one charge the 2026-08-03 revamp missed: it still added the card
 * fee **on top** (`base + processing`) after every other path moved it inside the price.
 * Nothing in the UI calls the route, so no buyer was overcharged — which is exactly why
 * it survived, and why it needs a test rather than a second reading of the code.
 */
describe("Seed buy — the price is all-in", () => {
	const QUANTITY = 2;
	const base = new Decimal(seedCost(QUANTITY));

	async function buySeeds() {
		fake.reset();
		const res = await req("/api/subscriptions/seeds/buy", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: subscriberCookie },
			body: JSON.stringify({ quantity: QUANTITY }),
		});
		return { res, body: await res.json() };
	}

	it("charges quantity × $3 exactly, with processing taken out of it", async () => {
		const { res, body } = await buySeeds();
		expect(res.status).toBe(200);

		// A Seed is a flat $3. The buyer pays the Seed value and nothing more — the at-cost
		// card fee is a deduction from that charge, never an addition to it.
		expect(body.buyerTotal).toBe(base.toFixed(2));
		expect(body.processingFee).toBe(cardFee(base).toFixed(2));
		expect(new Decimal(body.processingFee).greaterThan(0)).toBe(true);

		// The assertion that would have caught the old behaviour: the amount actually sent
		// to Stripe, not the number in the response body.
		const params = fake.lastCall("paymentIntents.create")?.args[0] as
			| Stripe.PaymentIntentCreateParams
			| undefined;
		expect(params?.amount).toBe(Math.round(base.toNumber() * 100));
	});

	it("records the pending purchase with the fee inside the price", async () => {
		const { res, body } = await buySeeds();
		expect(res.status).toBe(200);

		const intentId = String(body.clientSecret).replace(/_secret_test$/, "");
		const [row] = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, intentId))
			.limit(1);

		expect(row).toBeDefined();
		expect(row.type).toBe("seeds");
		// `amount` is what gets credited to the creator-Seed balance, so it must stay the
		// Seed value — the fee coming out of the charge must not shrink what the user bought.
		expect(new Decimal(row.amount).toFixed(2)).toBe(base.toFixed(2));
		expect(new Decimal(row.processingFee).toFixed(2)).toBe(cardFee(base).toFixed(2));
		// A Seed buy collects no sales tax; recorded as zero rather than left unset.
		expect(new Decimal(row.salesTax).toFixed(2)).toBe("0.00");
	});
});

describe("remainder — a heavy streamer costs the mission nothing", () => {
	/**
	 * This block used to pin the *clamp*: bandwidth was a term in the Seed
	 * decomposition, so ~120 hours of watch-time drove the remainder to −$0.54 and
	 * `settle-cycle.ts`'s `Decimal.max(0, …)` was what kept a negative amount out of a
	 * ledger whose amounts mean "what the remainder received".
	 *
	 * **Retiring the per-GiB charge on 2026-08-12 made that unreachable**, and the
	 * honest replacement is the inverse claim rather than a contrived input: the same
	 * heavy account now books its *full* remainder, because nothing a user watches
	 * enters settlement any more. The clamp stays as documented-defensive code (its
	 * no-floor contract is still pinned in `economics.test.ts`), but this is the
	 * behaviour worth guarding — a future cost term added back here would fail it
	 * first, which is exactly when someone should be made to think about it.
	 *
	 * The 120 hours of attention are deliberately kept in the fixture. They are what
	 * makes the assertion mean "watch-time does not move this" rather than
	 * "watch-time was absent".
	 */
	const heavyName = `pay_heavy_${run}`;
	let heavyId: number;
	let heavyAccountId: number;
	let cycle: string;

	beforeAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${heavyName}`);
		({ id: heavyId } = await signUp(heavyName));

		const [acct] = await db
			.insert(accounts)
			.values({ userId: heavyId, anthersSeeds: 1, isActive: true })
			.returning();
		heavyAccountId = acct.id;

		await db.insert(attentionEvents).values({
			userId: heavyId,
			creatorId,
			workId: paidWorkId,
			eventType: "watch",
			durationSeconds: 120 * 3600,
		});

		const now = new Date();
		cycle = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		await db.execute(sql`DELETE FROM users WHERE username = ${heavyName}`);
	});

	it("books the FULL remainder for a 120-hour month — watch-time does not enter settlement", async () => {
		// Hand-computed: $3.00 charge − $1.50 Time Pool − $0.39 card fee = $1.11, and the
		// 204 GiB this account streamed changes none of the three.
		expect(await settleCycle({ accountId: heavyAccountId, cycle })).toBe(1);

		const [ledger] = await db
			.select()
			.from(crfLedger)
			.where(sql`${crfLedger.description} LIKE ${`[settle u${heavyId} ${cycle}]%`}`)
			.limit(1);
		expect(ledger).toBeDefined();
		expect(new Decimal(ledger.amount).toFixed(2)).toBe("1.11");
		// And the description says nothing about an allowance or an overage any more.
		expect(ledger.description).not.toMatch(/bandwidth|allowance/i);

		const [snapshot] = await db
			.select()
			.from(accountCycles)
			.where(and(eq(accountCycles.userId, heavyId), eq(accountCycles.billingCycle, cycle)));
		expect(new Decimal(snapshot.foundation).toFixed(2)).toBe("1.11");
		// The creators this user watched are paid the same as anyone's: the Time Pool is a
		// fixed target per Seed.
		expect(new Decimal(snapshot.timePool).toFixed(2)).toBe("1.50");
	});

	it("settles a cycle only once", async () => {
		// The marker row in the ledger is the whole idempotency mechanism; a second run
		// double-booking the charitable ledger would be silent and permanent.
		expect(await settleCycle({ accountId: heavyAccountId, cycle })).toBe(0);
		const rows = await db
			.select()
			.from(crfLedger)
			.where(sql`${crfLedger.description} LIKE ${`[settle u${heavyId} ${cycle}]%`}`);
		expect(rows).toHaveLength(1);
	});
});

describe("Checkout — what isn't for sale", () => {
	it("404s an unknown slug", async () => {
		const res = await req(`/api/payments/checkout/no-such-post-${run}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(404);
	});

	it("refuses a hard-gated Work with no price path", async () => {
		fake.reset();
		// Every row present, none allowed, no price anywhere — reaching a threshold would
		// still not open it, so there is nothing to sell.
		const work = await insertWork({
			creatorId,
			type: "game",
			title: `Locked ${run}`,
			streamEnabled: false,
			downloadEnabled: true,
			anthersAccess: LOCKED,
			seedAccess: LOCKED,
		});

		const res = await req(`/api/payments/checkout/${work.slug}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("This work is not available for direct purchase");
		// Nothing was sent to Stripe for a Work that was never purchasable.
		expect(fake.callsTo("paymentIntents.create")).toHaveLength(0);
	});
});
