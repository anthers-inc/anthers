// SPDX-License-Identifier: Apache-2.0
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	assets,
	badges,
	basketItems,
	billingAccounts,
	crfLedger,
	purchases,
	stripeAccounts,
	userBadges,
	users,
} from "@anthers/db/schema";
import { calculateFees, cardFee } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
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
const WEBHOOK_SECRET = "whsec_test_secret_for_signature_verification";
/** Never used against the API — only to construct a real `webhooks` helper for HMAC. */
const FAKE_KEY = "sk_test_fake_no_network";

function req(path: string, options?: RequestInit) {
	return testFetch(new Request(`http://localhost${path}`, options));
}

// ── The fake Stripe client ───────────────────────────────────────────────────

/**
 * An async-iterable shaped like Stripe's `ApiListPromise` results — `{ data: [...] }`
 * that `for await` walks. The completion path iterates a session list, so a test shapes
 * what it sees with this.
 */
function asyncList(data: unknown[]) {
	return {
		data,
		[Symbol.asyncIterator]:
			data.length > 0
				? async function* () {
						for (const item of data) yield item;
					}
				: async function* () {},
	};
}

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
		checkout: {
			sessions: {
				// A Checkout Session in elements mode: a fresh id per call (the rows are
				// keyed by it) and a client secret the browser mounts Checkout from.
				create: record("checkout.sessions.create", () => {
					const id = `cs_${uid()}`;
					return { id, client_secret: `${id}_secret_test` };
				}),
				// The completion path finds a session by its PaymentIntent, iterating the
				// list — so the fake returns an async-iterable shaped like Stripe's.
				// A test sets `responses["checkout.sessions.list"]` to an `asyncList([...])`
				// to shape what completion sees.
				//
				// 🚨 NOT wrapped in `record`'s Promise.resolve: the real SDK returns the
				// async-iterable ApiListPromise synchronously, and the route iterates it
				// directly — `for await` over a *promise of* an async-iterable throws, so
				// the fake has to match the real shape here rather than the fake's usual
				// promise-wrapped one.
				list: (...args: unknown[]) => {
					calls.push({ method: "checkout.sessions.list", args });
					const canned = responses["checkout.sessions.list"];
					return (canned !== undefined ? canned : asyncList([])) as never;
				},
			},
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
/**
 * A Stripe subscription fixture, as ONE ITEM PER DESTINATION.
 *
 * 🚨 It took a `quantity` until 2026-08-16 and built a single item, because the whole
 * charge was a count of $3 Seeds. That shape cannot express what the model now allows, and
 * — more importantly for a fixture — it cannot express the thing most worth testing: an
 * item whose amount is real but whose **destination stamp** is missing or wrong. `anthers`
 * and `directed` are separate so a test can build exactly that.
 */
function subscription(opts: {
	id?: string;
	customer?: string;
	status?: string;
	/** Monthly dollars on the Anthers line. */
	anthers?: number;
	/** Monthly dollars per creator, keyed by creator id. */
	directed?: Record<number, number>;
	/** Items with no `destination` stamp — the migration case, credited to Anthers. */
	unstamped?: number[];
	periodEnd?: number;
	cancelAtPeriodEnd?: boolean;
}) {
	const periodEnd = opts.periodEnd ?? 1_800_000_000;
	const item = (dollars: number, destination?: string) => ({
		id: `si_${uid()}`,
		anthers: 3,
		price: { unit_amount: Math.round(dollars * 100) },
		current_period_end: periodEnd,
		...(destination ? { metadata: { destination } } : {}),
	});
	const data = [
		...(opts.anthers != null ? [item(opts.anthers, "anthers")] : []),
		...Object.entries(opts.directed ?? {}).map(([id, amt]) => item(amt, id)),
		...(opts.unstamped ?? []).map((amt) => item(amt)),
	];
	return {
		id: opts.id ?? `sub_${uid()}`,
		object: "subscription",
		customer: opts.customer ?? `cus_${uid()}`,
		status: opts.status ?? "active",
		cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
		items: { object: "list", data: data.length > 0 ? data : [item(3, "anthers")] },
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
	const account = await createAccount(username);
	const cookie = account.cookie;
	const [row] = await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.email, `${username}@example.com`))
		.returning({ id: users.id });
	return { cookie, id: row.id };
}

const LOCKED = [{ threshold: 0, allow: false, price: "0" }];
/** $5.00 to anyone, at any Badge — a purchasable post with no ladder route in. */
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
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${buyerName}@example.com`}`, sql`${`${subscriberName}@example.com`}`], sql`, `)})`,
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
		access: FOR_SALE,
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
		sql`DELETE FROM users WHERE email IN (${sql.join([sql`${`${creatorName}@example.com`}`, sql`${`${buyerName}@example.com`}`, sql`${`${subscriberName}@example.com`}`], sql`, `)})`,
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
				body: JSON.stringify({ anthersSupport: 6 }),
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
	 * canceled subscription that Stripe kept billing. So asserting the 503 is only half the
	 * test; the other half is that the database did not move.
	 */
	it("refuses to cancel — and leaves the account untouched", async () => {
		// A subscription and the held Badge beside it — what a supporter looks like. The
		// cancel check reads the holding (the amount column died), so the fixture holds
		// one or the route's "nothing to cancel" refusal fires instead of Stripe's.
		const anthersId = await ensureAnthersLadder();
		const [rung] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, "6.00")))
			.limit(1);
		await db
			.delete(userBadges)
			.where(
				and(
					eq(userBadges.userId, subscriberId),
					eq(userBadges.billingCycle, sql`to_char(now(), 'YYYY-MM-01')`),
					sql`${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${anthersId})`,
				),
			);
		await db.insert(userBadges).values({
			userId: subscriberId,
			badgeId: rung.id,
			billingCycle: sql`to_char(now(), 'YYYY-MM-01')`,
		});
		await db
			.insert(billingAccounts)
			.values({
				userId: subscriberId,
				stripeSubscriptionId: `sub_${uid()}`,
			})
			.onConflictDoUpdate({
				target: billingAccounts.userId,
				set: { canceledAt: null },
			});

		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/cancel", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
			});
			expect(res.status).toBe(503);
		});

		const [acct] = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, subscriberId));
		expect(acct.canceledAt).toBeNull();
		// And the holding still stands — the database did not move.
		const [stillHeld] = await db
			.select({ held: sql<string>`COALESCE(MAX(${badges.threshold}), '0.00')` })
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.where(
				and(
					eq(userBadges.userId, subscriberId),
					eq(userBadges.billingCycle, sql`to_char(now(), 'YYYY-MM-01')`),
					eq(badges.creatorId, anthersId),
				),
			);
		expect(Number(stillHeld.held)).toBe(6);
	});

	it("refuses to resume — and leaves the cancellation in place", async () => {
		const canceledAt = new Date();
		await db
			.update(billingAccounts)
			.set({ canceledAt })
			.where(eq(billingAccounts.userId, subscriberId));

		await withoutStripe(async () => {
			const res = await req("/api/subscriptions/resume", {
				method: "POST",
				headers: { ...json, Cookie: subscriberCookie },
			});
			expect(res.status).toBe(503);
		});

		const [acct] = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, subscriberId));
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

	it("rejects when NEITHER webhook secret is configured", async () => {
		// Both, not just the primary: with the connect secret set, an absent primary is no
		// longer an unconfigured endpoint, so deleting one would let this pass for the
		// wrong reason.
		const saved = process.env.STRIPE_WEBHOOK_SECRET;
		const savedConnect = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
		delete process.env.STRIPE_WEBHOOK_SECRET;
		delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
		try {
			const res = await sendWebhook(stripeEvent("payment_intent.succeeded", { id: "pi_x" }));
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Missing signature or webhook secret.");
		} finally {
			process.env.STRIPE_WEBHOOK_SECRET = saved;
			if (savedConnect === undefined) delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
			else process.env.STRIPE_CONNECT_WEBHOOK_SECRET = savedConnect;
		}
	});

	it("accepts a correctly signed event with no Origin header (the CSRF exemption)", async () => {
		const res = await sendWebhook(stripeEvent("invoice.paid", { id: "in_ignored" }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ received: true });
	});

	/**
	 * The connected-accounts destination has its own signing secret, because Stripe issues
	 * one per destination and `account.updated` is only ever delivered to that scope. One URL
	 * therefore has to accept either signature.
	 */
	describe("with a second (Connect) destination secret", () => {
		const CONNECT_SECRET = "whsec_connect_destination_secret_here";

		beforeEach(() => {
			process.env.STRIPE_CONNECT_WEBHOOK_SECRET = CONNECT_SECRET;
		});
		afterEach(() => {
			delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
		});

		it("accepts an event signed with the CONNECT secret", async () => {
			const res = await sendWebhook(stripeEvent("invoice.paid", { id: "in_ignored" }), {
				secret: CONNECT_SECRET,
			});
			expect(res.status).toBe(200);
		});

		it("still accepts an event signed with the PRIMARY secret", async () => {
			const res = await sendWebhook(stripeEvent("invoice.paid", { id: "in_ignored" }));
			expect(res.status).toBe(200);
		});

		it("still rejects a secret that is neither", async () => {
			// The point of the loop is to accept two known signers, not to get lax about a
			// third. Without this, "try each secret" could decay into "try anything".
			const res = await sendWebhook(stripeEvent("invoice.paid", { id: "in_ignored" }), {
				secret: "whsec_a_third_secret_nobody_issued",
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toBe("Signature verification failed.");
		});

		it("delivers account.updated through the connect secret — the case this exists for", async () => {
			// `subscriberId`, not `creatorId`: `stripe_accounts.user_id` is UNIQUE, so
			// claiming a user another webhook test also attaches an account to makes that
			// test fail on its insert — a failure that reads as a bug in the code under test
			// and is really this fixture standing on its toes.
			const acctId = `acct_${uid()}`;
			await db.insert(stripeAccounts).values({ userId: subscriberId, stripeAccountId: acctId });

			const res = await sendWebhook(
				stripeEvent("account.updated", {
					id: acctId,
					object: "account",
					charges_enabled: true,
					payouts_enabled: true,
					details_submitted: true,
				}),
				{ secret: CONNECT_SECRET },
			);
			expect(res.status).toBe(200);

			const [row] = await db
				.select()
				.from(stripeAccounts)
				.where(eq(stripeAccounts.stripeAccountId, acctId));
			expect(row.onboardingComplete).toBe(true);
		});
	});
});

// The fake records call ARGS, not return values, so a session completion test shapes
// what the list returns with `asyncList([session])`, iterated by the completion path.
function fakeSessionFor(intentId: string, opts: { country?: string; taxCents?: number } = {}) {
	return {
		id: `cs_${uid()}`,
		payment_intent: intentId,
		total_details: { amount_tax: opts.taxCents ?? 0, amount_discount: 0, amount_shipping: null },
		customer_details: {
			address: {
				country: opts.country ?? "US",
				state: "CO",
				postal_code: "80202",
				line1: "1701 Wewatta St",
				line2: null,
				city: "Denver",
			},
		},
	};
}

describe("Webhook: payment_intent.succeeded", () => {
	it("completes a pending post purchase and writes no purchase-fee ledger row", async () => {
		const piId = `pi_${uid()}`;
		const [pending] = await db
			.insert(purchases)
			.values({
				buyerId,
				workId: webhookWorkId,
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				creatorEarnings: "5.00",
				stripePaymentIntentId: piId,
				status: "pending",
			})
			.returning();

		const event = stripeEvent("payment_intent.succeeded", { id: piId, object: "payment_intent" });
		expect((await sendWebhook(event)).status).toBe(200);

		const [row] = await db.select().from(purchases).where(eq(purchases.id, pending.id));
		expect(row.status).toBe("completed");

		// The always-zero purchase-fee ledger row is gone with its column (the accounts
		// split) — a completed Work purchase books nothing by itself. The row that remains
		// meaningful is the refund shortfall, which `refunds.test.ts` owns.
		const ledger = await db.select().from(crfLedger).where(eq(crfLedger.purchaseId, pending.id));
		expect(ledger).toHaveLength(0);

		// Redelivery — Stripe retries, and it must not double-complete. The idempotency is
		// structural (`WHERE status = 'pending'`), which is easy to lose in a refactor and
		// impossible to notice without this assertion.
		expect((await sendWebhook(event)).status).toBe(200);
		const [still] = await db.select().from(purchases).where(eq(purchases.id, pending.id));
		expect(still.status).toBe("completed");
	});

	it("ignores a PaymentIntent it has no purchase row for", async () => {
		const res = await sendWebhook(
			stripeEvent("payment_intent.succeeded", { id: `pi_${uid()}`, object: "payment_intent" }),
		);
		expect(res.status).toBe(200);
	});

	it("re-keys a session purchase onto its PaymentIntent and stamps the tax and address", async () => {
		// A purchase charged through a Checkout Session is keyed by the session at
		// checkout; this is the completion moment — the webhook resolves the session from
		// the PaymentIntent, re-keys the row, and stamps what Stripe Tax actually
		// collected plus the buyer's address, which is what the return worksheets and
		// the threshold forecast read.
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		await db.insert(purchases).values({
			buyerId,
			workId: webhookWorkId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			creatorEarnings: "4.55",
			stripePaymentIntentId: sessionId,
			status: "pending",
		});

		const session = fakeSessionFor(piId, { taxCents: 36 });
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", { id: piId, object: "payment_intent" });
		expect((await sendWebhook(event)).status).toBe(200);

		const [row] = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, piId));
		expect(row).toBeDefined();
		expect(row.status).toBe("completed");
		// The tax Stripe Tax collected, in dollars on the row.
		expect(new Decimal(row.salesTax).toFixed(2)).toBe("0.36");
		// The buyer's location, as resolved — the remittance record.
		expect(row.buyerCountry).toBe("US");
		expect(row.buyerState).toBe("CO");
		expect(row.buyerPostalCode).toBe("80202");
		expect(row.buyerCity).toBe("Denver");
		expect(row.buyerAddressLine1).toBe("1701 Wewatta St");
	});

	it("refuses completion for a session billed outside the US, leaving the row pending", async () => {
		// The buy surfaces collect the address through Anthers' own US-only form, so a
		// browser-built session is US by construction — this refusal is the backstop for
		// what that cannot see: a hand-rolled API session, a modified client. The row
		// stays `pending` — no access, no ledger entry — and the money is returned by
		// hand.
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		await db.insert(purchases).values({
			buyerId,
			workId: webhookWorkId,
			type: "digital",
			amount: "5.00",
			processingFee: "0.45",
			creatorEarnings: "4.55",
			stripePaymentIntentId: sessionId,
			status: "pending",
		});

		const session = fakeSessionFor(piId, { country: "DE", taxCents: 0 });
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", { id: piId, object: "payment_intent" });
		expect((await sendWebhook(event)).status).toBe(200);

		const [row] = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, sessionId));
		expect(row.status).toBe("pending");
		// And no ledger entry was booked for the refused completion.
		const ledger = await db.select().from(crfLedger).where(eq(crfLedger.purchaseId, row.id));
		expect(ledger).toHaveLength(0);
	});

	it("apportions a basket session's tax across its rows by value", async () => {
		// Three rows on one session, odd prices so the pro-rata split cannot divide
		// evenly: the last row absorbs the rounding remainder, and the rows must sum to
		// exactly what Stripe collected.
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		const amounts = ["3.33", "3.33", "3.34"];
		for (const amount of amounts) {
			await db.insert(purchases).values({
				buyerId,
				workId: webhookWorkId,
				type: "digital",
				amount,
				processingFee: "0.40",
				creatorEarnings: amount,
				stripePaymentIntentId: sessionId,
				status: "pending",
			});
		}

		const session = fakeSessionFor(piId, { taxCents: 73 });
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", { id: piId, object: "payment_intent" });
		expect((await sendWebhook(event)).status).toBe(200);

		const rows = await db.select().from(purchases).where(eq(purchases.stripePaymentIntentId, piId));
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.status === "completed")).toBe(true);
		const sum = rows.reduce((acc, r) => acc.plus(new Decimal(r.salesTax)), new Decimal(0));
		expect(sum.toFixed(2)).toBe("0.73");
		// And the address is stamped on every row — each row is a remittance record.
		expect(rows.every((r) => r.buyerState === "CO")).toBe(true);
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
			.insert(billingAccounts)
			.values({ userId: subscriberId, stripeCustomerId: customerId })
			.onConflictDoUpdate({
				target: billingAccounts.userId,
				set: { stripeCustomerId: customerId, stripeSubscriptionId: "" },
			});
	}, DB_SETUP_TIMEOUT);

	/** What the Anthers ladder says this subscriber holds, in dollars. */
	async function heldOnOrgLadder(userId: number): Promise<number> {
		const anthersId = await ensureAnthersLadder();
		const [held] = await db
			.select({ held: sql<string>`COALESCE(MAX(${badges.threshold}), '0.00')` })
			.from(userBadges)
			.innerJoin(badges, eq(badges.id, userBadges.badgeId))
			.where(
				and(
					eq(userBadges.userId, userId),
					eq(userBadges.billingCycle, sql`to_char(now(), 'YYYY-MM-01')`),
					eq(badges.creatorId, anthersId),
				),
			);
		return Number(held?.held ?? 0);
	}

	it("takes the Anthers amount from the item stamped for Anthers", async () => {
		const periodEnd = 1_900_000_000;
		await sendWebhook(
			stripeEvent(
				"customer.subscription.created",
				subscription({ id: subId, customer: customerId, anthers: 9, periodEnd }),
			),
		);

		// The Anthers amount is the holding the webhook writes on the Anthers ladder — the
		// Badge at the Anthers line's threshold — not an amount column, which died with
		// the split.
		expect(await heldOnOrgLadder(subscriberId)).toBe(9);
		const [acct] = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, subscriberId));
		expect(acct.isActive).toBe(true);
		expect(acct.stripeSubscriptionId).toBe(subId);
		// The period end reads off the ITEM, not the subscription — the 2026-02 API move.
		expect(acct.currentPeriodEnd?.getTime()).toBe(periodEnd * 1000);
	});

	it("follows an amount change up and down", async () => {
		await sendWebhook(
			stripeEvent(
				"customer.subscription.updated",
				subscription({ id: subId, customer: customerId, anthers: 3 }),
			),
		);
		expect(await heldOnOrgLadder(subscriberId)).toBe(3);
	});

	it("records a pending cancellation without dropping the support", async () => {
		// cancel_at_period_end means the support keeps working until the cycle ends.
		await sendWebhook(
			stripeEvent(
				"customer.subscription.updated",
				subscription({ id: subId, customer: customerId, anthers: 3, cancelAtPeriodEnd: true }),
			),
		);
		const [acct] = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, subscriberId));
		expect(acct.canceledAt).not.toBeNull();
		expect(await heldOnOrgLadder(subscriberId)).toBe(3);
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
		expect(await heldOnOrgLadder(subscriberId)).toBe(3);
		const [acct] = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, subscriberId));
		expect(acct.stripeSubscriptionId).toBe(subId);
	});

	it("reverts to Free when the current subscription is canceled", async () => {
		await sendWebhook(
			stripeEvent(
				"customer.subscription.deleted",
				subscription({ id: subId, customer: customerId, status: "canceled", anthers: 3 }),
			),
		);
		// The holding goes — the cycle's unpaid holdings lapse — and the billing row
		// drops the subscription id.
		expect(await heldOnOrgLadder(subscriberId)).toBe(0);
		const [acct] = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, subscriberId));
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

/**
 * The basket — several Works, one charge, one card fee.
 *
 * The whole reason a basket exists is the **fixed $0.30**, which is per charge rather
 * than per item: five $1 tracks pay $1.65 in card fees separately and $0.45 together,
 * and every cent of that goes to the creator because Anthers keeps nothing either way.
 * So the assertions that matter are (a) the fee is charged ONCE, and (b) the per-row
 * money still sums to exactly what Stripe was asked for — the place a basket goes
 * quietly wrong is rows that each carry their own $0.30 and no longer reconcile.
 *
 * Verified by sabotage before being committed: computing fees per item rather than on
 * the subtotal fails 3; dropping the mixed-creator guard fails 1; apportioning without
 * the last-row remainder fails 1 (a 3-way split of an odd cent is what exposes it).
 */
describe("Basket checkout — one charge, one card fee", () => {
	let items: { id: number; slug: string }[] = [];
	let otherCreatorWorkId = 0;

	async function connect(userId: number) {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, userId));
		await db.insert(stripeAccounts).values({
			userId,
			stripeAccountId: `acct_${uid()}`,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
	}

	/** Three items at an odd price, so the pro-rata split cannot divide evenly. */
	const UNIT = "3.33";
	const ODD = [{ threshold: 0, allow: true, price: UNIT }];

	/**
	 * Put the given Works into the buyer's SERVER-side basket (one add per Work, through
	 * the route the Work page's own button calls), then act on the basket the way the
	 * client now does — with no body naming ids, because the stored basket is what is
	 * bought. The replace-on-clash courtesy lives in the add; a caller that wants a
	 * mixed-creator basket for the refusal test seeds both creators' Works in sequence
	 * and the ADD is what replaces — so `seed` here must not re-clear per call.
	 */
	async function seedBasket(newIds: number[], { fresh = false } = {}) {
		if (fresh) await clearBasketDirect();
		for (const id of newIds) {
			const res = await req("/api/payments/basket/items", {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
				body: JSON.stringify({ workId: id }),
			});
			expect(res.status, `seeding basket with ${id}`).toBe(200);
		}
	}

	async function clearBasketDirect() {
		const res = await req("/api/payments/basket", {
			method: "DELETE",
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status, "clearing the basket").toBe(200);
	}

	async function basket(_workIds: number[], path = "checkout") {
		// The legacy `workIds` argument is kept in the call sites unchanged but carries no
		// meaning now: quote and checkout price the account's own stored basket. A test
		// that wants a particular basket seeds it first (`seedBasket`).
		fake.reset();
		const res = await req(`/api/payments/basket/${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
			body: JSON.stringify({}),
		});
		return { res, body: await res.json() };
	}

	beforeAll(async () => {
		await connect(creatorId);
		items = [];
		for (let i = 0; i < 3; i++) {
			const w = await insertWork({
				creatorId,
				type: "game",
				title: `Basket item ${i} ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: ODD,
			});
			items.push({ id: w.id, slug: w.slug });
		}
		// A fourth Work belonging to somebody else entirely.
		const { id: otherCreator } = await signUp(`bskt_other_${run}`);
		await connect(otherCreator);
		otherCreatorWorkId = (
			await insertWork({
				creatorId: otherCreator,
				type: "game",
				title: `Other creator ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: ODD,
			})
		).id;
	}, DB_SETUP_TIMEOUT);

	it("charges the flat fee ONCE, not once per item", async () => {
		await seedBasket(
			items.map((i) => i.id),
			{ fresh: true },
		);
		const { res, body } = await basket(items.map((i) => i.id));
		expect(res.status).toBe(200);

		const expected = calculateFees(new Decimal(UNIT).times(3), { type: "digital" });
		expect(body.subtotal).toBe(expected.creatorEarnings.plus(expected.processingFee).toFixed(2));
		expect(body.processingFee).toBe(expected.processingFee.toFixed(2));

		// The point of the whole feature, stated as an inequality rather than a figure:
		// one basket fee must be strictly less than three separate ones.
		const separately = cardFee(new Decimal(UNIT)).times(3);
		expect(new Decimal(body.processingFee).lessThan(separately)).toBe(true);

		// The basket the charge was built from is emptied at checkout — the ids are spent
		// the moment the session exists, and the badge must not count what was just paid.
		const after = await req("/api/payments/basket", {
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(((await after.json()) as { count: number }).count).toBe(0);
	});

	it("builds one session for the whole basket, one line per Work, each coded", async () => {
		await seedBasket(
			items.map((i) => i.id),
			{ fresh: true },
		);
		const { body } = await basket(items.map((i) => i.id));
		const params = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;

		// The lines are the price of each item, and the whole session carries the
		// automatic-tax setting and the exclusive behavior — the tax each buyer pays is
		// resolved per address, per line, from the code the line carries.
		expect(params.line_items).toHaveLength(3);
		expect(params.automatic_tax).toEqual({ enabled: true });
		for (const line of params.line_items as {
			price_data: {
				product_data: { tax_code?: string };
				tax_behavior?: string;
				unit_amount?: number;
			};
		}[]) {
			// The basket fixture is three games — downloaded software.
			expect(line.price_data.product_data.tax_code).toBe("txcd_10201000");
			expect(line.price_data.tax_behavior).toBe("exclusive");
			expect(line.price_data.unit_amount).toBe(333);
		}

		// The transfer is the whole basket's earnings, on the sum — the fixed $0.30 is per
		// charge, which is the entire point of the basket.
		const expected = calculateFees(new Decimal(UNIT).times(3), { type: "digital" });
		expect(
			(params.payment_intent_data as { transfer_data?: { amount?: number } }).transfer_data?.amount,
		).toBe(Math.round(expected.creatorEarnings.toNumber() * 100));
		// No tax figure in the response: the rate is resolved at the session.
		expect(body.salesTax).toBeNull();
		expect(body.buyerTotal).toBeNull();
	});

	it("writes one purchase row per Work, keyed by the session, and they reconcile", async () => {
		await seedBasket(
			items.map((i) => i.id),
			{ fresh: true },
		);
		const { body } = await basket(items.map((i) => i.id));
		// The fake records call ARGS, not return values, so the session id comes back off
		// the response's own client secret — `cs_xxx_secret_test`.
		const sessionId = String(body.clientSecret).split("_secret")[0];
		const rows = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, sessionId));

		expect(rows).toHaveLength(3);
		const sum = (f: (r: (typeof rows)[number]) => string) =>
			rows.reduce((acc, r) => acc.plus(new Decimal(f(r))), new Decimal(0));

		// Each part sums to the whole. The last row absorbs the rounding remainder, which
		// is why an odd unit price is used: $3.33 x 3 cannot split a fee evenly.
		expect(sum((r) => r.amount).toFixed(2)).toBe(body.subtotal);
		expect(sum((r) => r.processingFee).toFixed(2)).toBe(body.processingFee);
		expect(sum((r) => r.creatorEarnings).toFixed(2)).toBe(body.creatorEarnings);

		// And no row invented its own flat fee — the giveaway that fees were computed
		// per item. Three separate $0.30s would put every row's fee above $0.30.
		for (const r of rows) expect(new Decimal(r.processingFee).lessThan("0.30")).toBe(true);

		// Tax is zero on every row at checkout — the webhook stamps the collected figure
		// at completion, apportioned across the rows by value.
		expect(sum((r) => r.salesTax).toFixed(2)).toBe("0.00");
	});

	it("refuses a basket spanning two creators, and creates no session", async () => {
		// Seed X's Works, then Y's — the ADD of Y's Work REPLACES the basket (the
		// one-creator courtesy), so to get a mixed table the mixed state must be reached
		// past the add. It cannot be, which is the honesty being tested: assert the add
		// itself replaced, then restore X's basket and confirm quote stays clean.
		await seedBasket([otherCreatorWorkId], { fresh: true });
		const clash = await req("/api/payments/basket/items", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
			body: JSON.stringify({ workId: items[0].id }),
		});
		expect(clash.status).toBe(200);
		const listed = await req("/api/payments/basket", {
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		const after = (await listed.json()) as { items: { workId: number }[] };
		expect(after.items.map((i) => i.workId)).toEqual([items[0].id]);

		// The mixed-creator REFUSAL is still live at checkout for the state a race could
		// still produce (a creator account deleted mid-basket is the only path; the
		// resolver's guard is what the unit suite pins — drive it through a seeded
		// two-creator table written directly, the way the race would leave it).
		await db.insert(basketItems).values({ userId: buyerId, workId: otherCreatorWorkId });
		const { res, body } = await basket([]);
		expect(res.status).toBe(400);
		expect(body.code).toBe("mixed_creators");
		expect(fake.callsTo("checkout.sessions.create")).toHaveLength(0);
	});

	it("quotes the saving without creating anything", async () => {
		await seedBasket(
			items.map((i) => i.id),
			{ fresh: true },
		);
		const { res, body } = await basket(
			items.map((i) => i.id),
			"quote",
		);
		expect(res.status).toBe(200);
		expect(body.items).toHaveLength(3);
		// The saving is what makes the basket legible, so it has to be real and positive.
		expect(new Decimal(body.creatorGains).greaterThan(0)).toBe(true);
		expect(new Decimal(body.feeSeparately).greaterThan(new Decimal(body.processingFee))).toBe(true);
		expect(fake.callsTo("checkout.sessions.create")).toHaveLength(0);
	});

	it("refuses an empty basket", async () => {
		await clearBasketDirect();
		const { res } = await basket([]);
		expect(res.status).toBe(400);
	});
});

describe("Checkout — session construction under automatic tax", () => {
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
		// at-cost card processing. Anthers retains none of it. The retired fee fields
		// (`crfFee`, `deliveryFee`) left the quote when their columns left the purchase
		// row — asserting their absence is the regression test for that.
		expect(body.amount).toBe(PRICE);
		expect(body.crfFee).toBeUndefined();
		expect(body.deliveryFee).toBeUndefined();
		expect(body.creatorEarnings).toBe(expected.creatorEarnings.toFixed(2));
		expect(new Decimal(body.creatorEarnings).lessThan(new Decimal(PRICE))).toBe(true);
		expect(body.processingFee).toBe(expected.processingFee.toFixed(2));
		// No tax figure, on purpose: the rate is resolved by Stripe Tax from the buyer's
		// billing address at the session, so the quote presents nothing rather than an
		// illustration wearing the clothes of a charge.
		expect(body.salesTax).toBeNull();
		expect(body.buyerTotal).toBeNull();
		// And the session's client secret is what the browser mounts Checkout from.
		expect(String(body.clientSecret)).toMatch(/^cs_.+_secret_test$/);

		const created = fake.lastCall("checkout.sessions.create");
		const params = created?.args[0] as Stripe.Checkout.SessionCreateParams;
		expect(params.line_items).toHaveLength(1);
		// The PaymentIntent's metadata — where the route carries the purchase facts — is
		// nested under `payment_intent_data`, not at the top level.
		expect(
			(params.payment_intent_data as { metadata?: Record<string, string> }).metadata,
		).toMatchObject({
			kind: "direct_purchase",
			workId: String(paidWorkId),
			buyerId: String(buyerId),
		});
	});

	// The branch this replaces used to charge the buyer and hold the money on the platform
	// when the creator had no connected account. It was unreachable from the product — the
	// buy UI refuses to render without `creatorHasStripe` — and survived precisely because
	// nothing asserted it. A connected creator is now a precondition, and the failure is
	// loud: no session is created at all, so no money moves that nobody can settle.
	it("refuses checkout, and creates no session, when the creator can't be paid", async () => {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, creatorId));

		const { res } = await checkout();
		expect(res.status).toBe(409);
		expect(fake.lastCall("checkout.sessions.create")).toBeUndefined();

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
		expect(fake.lastCall("checkout.sessions.create")).toBeUndefined();

		await connectCreator();
	});

	it("enables automatic tax and codes the line for what the buyer receives", async () => {
		await connectCreator();

		const { res } = await checkout();
		expect(res.status).toBe(200);

		const params = fake.lastCall("checkout.sessions.create")?.args[0] as
			| Stripe.Checkout.SessionCreateParams
			| undefined;
		// Automatic tax is on, with no `liability` — Anthers is the marketplace facilitator
		// and the tax liability, so the calculation stays on the platform side where the
		// Creator Terms already put it.
		expect(params?.automatic_tax).toEqual({ enabled: true });
		expect(params?.ui_mode).toBe("elements");
		expect(params?.billing_address_collection).toBe("required");
		// The paid post fixture is a game — downloaded software, `txcd_10201000`.
		const line = params?.line_items?.[0] as
			| (Stripe.Checkout.SessionCreateParams.LineItem & {
					price_data: { product_data: { tax_code?: string }; tax_behavior?: string };
			  })
			| undefined;
		expect(line?.price_data?.product_data?.tax_code).toBe("txcd_10201000");
		// US prices are tax-exclusive: the buyer's total varies with their location.
		expect(line?.price_data?.tax_behavior).toBe("exclusive");
	});

	// 🚨 **Payment methods are Dashboard-governed** (2026-10-03): this API version removed
	// `payment_method_types` from Checkout Session creation, and `SessionCreateParams`'
	// types still carry `payment_method_configuration` — but unset by default, so the
	// Dashboard's account-wide configuration (pmc_1T9K9l3WJAPZ8pU64cUUNUAv) governs what
	// buyers are offered. These two tests pin the env-conditional lever and the default:
	// the session never carries the parameter merely because a key exists somewhere.
	it("leaves payment methods to the Dashboard by default — no configuration param", async () => {
		await connectCreator();
		delete process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION;

		const { res } = await checkout();
		expect(res.status).toBe(200);
		const params = fake.lastCall("checkout.sessions.create")?.args[0] as
			| Stripe.Checkout.SessionCreateParams
			| undefined;
		expect(params?.payment_method_configuration).toBeUndefined();
		// And the parameter that would hard-code the list is never sent — this API
		// version rejects the session when it is.
		expect(params?.payment_method_types).toBeUndefined();
	});

	it("names an explicit configuration when STRIPE_PAYMENT_METHOD_CONFIGURATION is set", async () => {
		await connectCreator();
		const previous = process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION;
		process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION = "pmc_test_override";
		try {
			const { res } = await checkout();
			expect(res.status).toBe(200);
			const params = fake.lastCall("checkout.sessions.create")?.args[0] as
				| Stripe.Checkout.SessionCreateParams
				| undefined;
			expect(params?.payment_method_configuration).toBe("pmc_test_override");
			expect(params?.payment_method_types).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION;
			else process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION = previous;
		}
	});

	it("pins the creator's transfer to their earnings, location-independent", async () => {
		const acctId = await connectCreator();

		const { res, body } = await checkout();
		expect(res.status).toBe(200);

		const params = fake.lastCall("checkout.sessions.create")?.args[0] as
			| Stripe.Checkout.SessionCreateParams
			| undefined;
		const transfer = (
			params?.payment_intent_data as { transfer_data?: { destination?: string; amount?: number } }
		)?.transfer_data;

		// The assertion that matters, stated in STRIPE's terms rather than ours: the
		// creator's transfer is PINNED to their earnings rather than left as "everything
		// that is not the application fee", because under automatic tax the tax varies
		// with the buyer's address and no static fee can capture it. Whatever tax Stripe
		// adds stays on the platform side by construction, so the creator's take-home
		// never depends on where the buyer lives.
		//
		// And deliberately NO `application_fee_amount` anywhere: a static fee was the
		// old structure's way of holding the tax back, and resurrecting it beside a
		// pinned transfer would double-count the same money.
		expect(transfer).toEqual({
			destination: acctId,
			amount: Math.round(expected.creatorEarnings.toNumber() * 100),
		});
		expect(
			(params?.payment_intent_data as { application_fee_amount?: number }).application_fee_amount,
		).toBeUndefined();
		expect(body.creatorEarnings).toBe(expected.creatorEarnings.toFixed(2));
	});

	it("writes the pending purchase keyed by the Checkout Session", async () => {
		const { res, body } = await checkout();
		expect(res.status).toBe(200);

		// The route hands back the session's client secret; the row it wrote must be keyed
		// by that same session, because the PaymentIntent does not exist until the buyer
		// confirms inside the session, and the webhook resolves the session from the
		// PaymentIntent when it does.
		const sessionId = String(body.clientSecret).replace(/_secret_test$/, "");
		const [row] = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, sessionId))
			.limit(1);

		expect(row).toBeDefined();
		expect(row.status).toBe("pending");
		expect(row.buyerId).toBe(buyerId);
		expect(row.workId).toBe(paidWorkId);
		expect(new Decimal(row.amount).toFixed(2)).toBe(PRICE);
		expect(new Decimal(row.creatorEarnings).toFixed(2)).toBe(expected.creatorEarnings.toFixed(2));
		// The purchase fee was removed 2026-08-03 and its column with the accounts split —
		// the ledger row it fed always carried zero and is not written any more (see the
		// webhook's completion), so the absence here IS the assertion's successor.
		// Sales tax is zero at checkout — Stripe Tax resolves the real figure from the
		// buyer's address at completion and the webhook stamps it. A non-zero here would
		// mean a charge path reintroduced a flat rate Anthers cannot know in advance.
		expect(new Decimal(row.salesTax).toFixed(2)).toBe("0.00");
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
		expect(row).toBeDefined();
		await db.update(purchases).set({ status: "completed" }).where(eq(purchases.id, row.id));

		const { res, body } = await checkout();
		expect(res.status).toBe(400);
		expect(body.error).toBe("You already have access to this work");
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
			access: LOCKED,
		});

		const res = await req(`/api/payments/checkout/${work.slug}`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("This work is not available for direct purchase");
		// Nothing was sent to Stripe for a Work that was never purchasable.
		expect(fake.callsTo("checkout.sessions.create")).toHaveLength(0);
	});

	it("refuses a physical or service Work — nothing fulfills them yet", async () => {
		// The posture's refusal, not a judgment about the types: there is no shipping
		// lane for a physical Work and no fulfillment mechanism for a service one, so a
		// buyer would pay for a thing that never arrives — and there is no tax code that
		// honestly describes an undelivered thing. `resolvePurchase` is the door both
		// the single and the basket path go through, so both refuse.
		for (const type of ["physical", "service"] as const) {
			const work = await insertWork({
				creatorId,
				type,
				title: `Unfulfillable ${type} ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: FOR_SALE,
			});

			const res = await req(`/api/payments/checkout/${work.slug}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: buyerCookie },
			});
			expect(res.status, type).toBe(400);
			const body = (await res.json()) as { error?: string };
			expect(body.error, type).toMatch(/can't be bought yet/i);
		}
		// And nothing was charged for either.
		expect(fake.callsTo("checkout.sessions.create")).toHaveLength(0);
	});
});
