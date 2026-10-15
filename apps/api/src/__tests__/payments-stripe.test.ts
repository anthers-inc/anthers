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
	badgeCharges,
	badges,
	billingAccounts,
	crfLedger,
	purchases,
	stripeAccounts,
	supportReductions,
	userBadges,
	users,
} from "@anthers/db/schema";
import { cycleKeyFor, cycleStart, nextCycleKey } from "@anthers/shared/billing-cycle";
import { calculateFees, cardFee, reductionFor } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { anthersUserId } from "../services/anthers-badges";
import { retryFailedTransfers } from "../services/purchase-split.js";
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

	let lastCreateParams: { settings?: unknown } | null = null;
	const client = {
		// Real crypto, on purpose — see the file header.
		webhooks: real.webhooks,
		accounts: {
			create: record("accounts.create", (params: { settings?: unknown }) => {
				// The creation params are recorded so a test can assert on what Anthers asked
				// Stripe for — the payout schedule's manual interval among them.
				lastCreateParams = params;
				return { id: `acct_${uid()}` };
			}),
			// The reconcile-on-read path (GET /stripe/onboard) retrieves the connected
			// account live; a test sets `responses["accounts.retrieve"]` to shape what it
			// sees. The default is an onboarded account — the stranded-row case needs the
			// row to disagree with Stripe.
			retrieve: record("accounts.retrieve", (id: string) => ({
				id,
				object: "account",
				charges_enabled: true,
				payouts_enabled: true,
				details_submitted: true,
			})),
			// The Express Dashboard door (POST /stripe/dashboard-link).
			createLoginLink: record("accounts.createLoginLink", () => ({
				object: "login_link",
				url: "https://connect.stripe.test/dashboard",
				created: 1_800_000_000,
			})),
		},
		accountLinks: {
			create: record("accountLinks.create", () => ({ url: "https://connect.stripe.test/onboard" })),
		},
		customers: {
			create: record("customers.create", () => ({ id: `cus_${uid()}` })),
		},
		products: {
			// The badge rung's Product (`ensureBadgeProduct`): created on first use with the
			// rung's tax code, listed to find orphans, updated when the tax code changes.
			list: record("products.list", () => ({ data: [] })),
			create: record("products.create", (params: { name?: string; tax_code?: string }) => ({
				id: `prod_${uid()}`,
				name: params.name ?? "",
				tax_code: params.tax_code,
			})),
			update: record("products.update", (id: string) => ({ id })),
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
			// The purchase-split retry resolves an intent's charge live; the fake answers
			// with a charge id so a retried transfer can be funded by one.
			retrieve: record("paymentIntents.retrieve", (id: string) => ({
				id,
				object: "payment_intent",
				latest_charge: `ch_${uid()}`,
			})),
		},
		transfers: {
			// The purchase split — one transfer per distinct creator at completion
			// (`services/purchase-split.ts`). A fresh id per call, recorded so a test
			// asserts the amount, the funding charge and the destination.
			create: record("transfers.create", () => {
				const id = `tr_${uid()}`;
				return { id, object: "transfer", amount: 0, currency: "usd" };
			}),
			// The refund clawback — `reverseCreatorShare` reverses the row's earnings
			// off the transfer that carried them.
			createReversal: record("transfers.createReversal", (id: string) => ({
				id: `trr_${uid()}`,
				object: "transfer_reversal",
				transfer: id,
			})),
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
		balance: {
			// A connected account's balance read (`?detail=1`); a test sets
			// `responses["balance.retrieve"]` to shape what the tab sees.
			retrieve: record("balance.retrieve", () => ({
				object: "balance",
				available: [{ amount: 0, currency: "usd" }],
				pending: [{ amount: 0, currency: "usd" }],
				livemode: false,
			})),
		},
	} as unknown as Stripe;

	return {
		client,
		calls,
		responses,
		/** The params of the last `accounts.create`, for asserting what Anthers asked Stripe for. */
		lastAccountCreate: () => lastCreateParams,
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
/** Owns the reconcile-on-read tests' separate `stripe_accounts` row (UNIQUE user). */
const reconName = `pay_recon_${run}`;

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

/** Pre-clean stale fixture users (a previous failed run's leftovers); `afterAll` mirrors it. */
const userCleanup = () =>
	db.execute(
		sql`DELETE FROM users WHERE email IN (${sql.join(
			[creatorName, buyerName, subscriberName, reconName].map((n) => sql`${`${n}@example.com`}`),
			sql`, `,
		)})`,
	);

beforeAll(async () => {
	await userCleanup();

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
	await userCleanup();
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
function fakeSessionFor(
	intentId: string,
	opts: { country?: string; taxCents?: number; customer?: string | null } = {},
) {
	return {
		id: `cs_${uid()}`,
		payment_intent: intentId,
		total_details: { amount_tax: opts.taxCents ?? 0, amount_discount: 0, amount_shipping: null },
		customer: opts.customer ?? null,
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

	it("links the Customer a checkout created to the buyer's billing row", async () => {
		// The 2026-10-11 posture: a session without a saved customer carries one only
		// when Stripe created it (`if_required`). Linking it at completion is what makes
		// the buyer's NEXT purchase reuse that one instead of a second customer object
		// accumulating behind them.
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		const customerId = `cus_created_${uid()}`;
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
		await db.delete(billingAccounts).where(eq(billingAccounts.userId, buyerId));

		const session = fakeSessionFor(piId, { taxCents: 0, customer: customerId });
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", {
			id: piId,
			object: "payment_intent",
			metadata: { buyerId: String(buyerId) },
		});
		expect((await sendWebhook(event)).status).toBe(200);

		const [acct] = await db
			.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, buyerId));
		expect(acct?.stripeCustomerId).toBe(customerId);
	});

	it("links nothing when the session carries no customer", async () => {
		// The ordinary opted-out buyer: `if_required` created nothing. No billing row
		// may appear for them — a purchase writes rows and stamps nothing reusable.
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
		await db.delete(billingAccounts).where(eq(billingAccounts.userId, buyerId));

		const session = fakeSessionFor(piId, { taxCents: 0, customer: null });
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", {
			id: piId,
			object: "payment_intent",
			metadata: { buyerId: String(buyerId) },
		});
		expect((await sendWebhook(event)).status).toBe(200);

		const accts = await db
			.select()
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, buyerId));
		expect(accts).toHaveLength(0);
	});

	it("never overwrites the customer id the billing row already holds", async () => {
		// The subscription Customer is settled by Billing and the subscription hangs off
		// it; a checkout session carried a different one must not re-link over it.
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		const settledCustomerId = `cus_subscription_${uid()}`;
		const createdCustomerId = `cus_created_${uid()}`;
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
		await db
			.insert(billingAccounts)
			.values({ userId: buyerId, stripeCustomerId: settledCustomerId })
			.onConflictDoUpdate({
				target: billingAccounts.userId,
				set: { stripeCustomerId: settledCustomerId },
			});

		const session = fakeSessionFor(piId, { taxCents: 0, customer: createdCustomerId });
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", {
			id: piId,
			object: "payment_intent",
			metadata: { buyerId: String(buyerId) },
		});
		expect((await sendWebhook(event)).status).toBe(200);

		const [acct] = await db
			.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, buyerId));
		expect(acct?.stripeCustomerId).toBe(settledCustomerId);
	});
});

describe("Webhook: the per-creator split at completion", () => {
	// Two connected creators, one Work each — the minimum shape that exercises
	// grouping: one charge, two creators' shares to move, one transfer each. Both are
	// THIS describe's own users, deliberately not the shared `creatorId`: several other
	// describes insert `stripe_accounts` rows for it, and a describe-level connect here
	// would race theirs on the table's one-account-per-user shape.
	let firstCreatorId = 0;
	let firstWorkId = 0;
	let secondCreatorId = 0;
	let secondWorkId = 0;
	let firstAcctId = "";
	let secondAcctId = "";

	async function connect(userId: number, acctId: string) {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, userId));
		await db.insert(stripeAccounts).values({
			userId,
			stripeAccountId: acctId,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
	}

	beforeAll(async () => {
		const { id: a } = await signUp(`split_first_${run}`);
		firstCreatorId = a;
		firstAcctId = `acct_${uid()}`;
		await connect(firstCreatorId, firstAcctId);
		firstWorkId = (
			await insertWork({
				creatorId: firstCreatorId,
				type: "game",
				title: `Split first ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: FOR_SALE,
			})
		).id;

		const { id: b } = await signUp(`split_other_${run}`);
		secondCreatorId = b;
		secondAcctId = `acct_${uid()}`;
		await connect(secondCreatorId, secondAcctId);
		secondWorkId = (
			await insertWork({
				creatorId: secondCreatorId,
				type: "game",
				title: `Split other ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: FOR_SALE,
			})
		).id;
	}, DB_SETUP_TIMEOUT);

	/**
	 * One pending row per creator, keyed by the session id — exactly the state
	 * `/basket/checkout` leaves behind, with the per-item fee shares already
	 * apportioned by the route (the last row absorbing the rounding remainder, which
	 * is why the two earnings figures sum to one charge's worth less one fee).
	 */
	async function seedSplitBasket(sessionId: string) {
		await db.insert(purchases).values([
			{
				buyerId,
				workId: firstWorkId,
				creatorId: firstCreatorId,
				workTitle: "Split row A",
				workType: "game",
				type: "digital",
				amount: "5.00",
				processingFee: "0.45",
				creatorEarnings: "4.55",
				stripePaymentIntentId: sessionId,
				status: "pending",
			},
			{
				buyerId,
				workId: secondWorkId,
				creatorId: secondCreatorId,
				workTitle: "Split row B",
				workType: "game",
				type: "digital",
				amount: "5.00",
				processingFee: "0.44",
				creatorEarnings: "4.56",
				stripePaymentIntentId: sessionId,
				status: "pending",
			},
		]);
	}

	it("moves each creator's share out as one transfer, funded by the charge", async () => {
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		const chargeId = `ch_${uid()}`;
		await seedSplitBasket(sessionId);

		const session = fakeSessionFor(piId);
		session.id = sessionId;
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", {
			id: piId,
			object: "payment_intent",
			latest_charge: chargeId,
		});
		expect((await sendWebhook(event)).status).toBe(200);

		// One transfer per DISTINCT creator — two rows, two creators, two calls — each
		// for that creator's own summed earnings, funded by the charge the buyer paid
		// (`source_transaction`), keyed by (intent, creator) so a retry replays rather
		// than duplicates.
		const transfers = fake.callsTo("transfers.create");
		expect(transfers).toHaveLength(2);
		const keyOf = (i: number) =>
			(transfers[i].args[1] as { idempotencyKey?: string }).idempotencyKey;
		const byDest = new Map(
			transfers.map((c) => [
				(c.args[0] as Stripe.TransferCreateParams).destination,
				c.args[0] as Stripe.TransferCreateParams,
			]),
		);
		expect(byDest.get(firstAcctId)?.amount).toBe(455);
		expect(byDest.get(secondAcctId)?.amount).toBe(456);
		for (const c of byDest.values()) expect(c.source_transaction).toBe(chargeId);
		expect(new Set(transfers.map((_, i) => keyOf(i))).size).toBe(2);

		// The rows are stamped with their creator's transfer — the column refunds read
		// and the retry job owes its worklist to.
		const rows = await db.select().from(purchases).where(eq(purchases.stripePaymentIntentId, piId));
		expect(rows).toHaveLength(2);
		const stamped = new Map(rows.map((r) => [r.creatorId, r.stripeTransferId]));
		expect(stamped.get(firstCreatorId)).toMatch(/^tr_/);
		expect(stamped.get(secondCreatorId)).toMatch(/^tr_/);
		expect(stamped.get(firstCreatorId)).not.toBe(stamped.get(secondCreatorId));

		// Redelivery is a no-op for the split too: the pending predicate is the latch,
		// and the idempotency keys mean even a racing re-run replays the same transfers.
		expect((await sendWebhook(event)).status).toBe(200);
		expect(fake.callsTo("transfers.create")).toHaveLength(2);
	});

	it("a transfer that fails leaves the debt to the retry job, which pays it with the same key", async () => {
		// The fake answers with a transfer shaped object missing its id — the failure
		// `transferCreatorShare` treats as "Stripe returned nothing usable".
		fake.responses["transfers.create"] = {};
		try {
			const piId = `pi_${uid()}`;
			const sessionId = `cs_${uid()}`;
			await seedSplitBasket(sessionId);
			const session = fakeSessionFor(piId);
			session.id = sessionId;
			fake.responses["checkout.sessions.list"] = asyncList([session]);
			const event = stripeEvent("payment_intent.succeeded", {
				id: piId,
				object: "payment_intent",
				latest_charge: `ch_${uid()}`,
			});
			expect((await sendWebhook(event)).status).toBe(200);

			// Completed and unstamped — the debt the retry job exists to pay.
			const rows = await db
				.select()
				.from(purchases)
				.where(eq(purchases.stripePaymentIntentId, piId));
			expect(rows).toHaveLength(2);
			expect(rows.every((r) => r.stripeTransferId == null && r.status === "completed")).toBe(true);

			// Re-arm the fake to succeed, then run the retry exactly as the cron does.
			// The charge is resolved live (`paymentIntents.retrieve`, faked to answer
			// one), and the idempotency key is the SAME one the completion attempt
			// used — a crash between Stripe's call and the stamping is the case the key
			// exists for, and this is that case rebuilt. The scan is global over
			// untransferred shares (as it is in production), so the assertions pin
			// THIS intent's keys and stamps rather than global counts.
			fake.reset();
			delete fake.responses["transfers.create"];
			const attempted = await retryFailedTransfers();
			expect(attempted).toBeGreaterThanOrEqual(2);
			const keys = fake
				.callsTo("transfers.create")
				.map((c) => (c.args[1] as { idempotencyKey?: string }).idempotencyKey);
			expect(keys).toContain(`purchase_transfer_${piId}_${firstCreatorId}`);
			expect(keys).toContain(`purchase_transfer_${piId}_${secondCreatorId}`);
			for (const c of fake.callsTo("transfers.create")) {
				expect((c.args[0] as Stripe.TransferCreateParams).source_transaction).toMatch(/^ch_/);
			}

			const after = await db
				.select()
				.from(purchases)
				.where(eq(purchases.stripePaymentIntentId, piId));
			expect(after.every((r) => r.stripeTransferId != null)).toBe(true);
		} finally {
			delete fake.responses["transfers.create"];
		}
	});

	it("never transfers a refunded row's share — the retry skips the dead purchase", async () => {
		// The safety property of the retry's predicate: only `completed` rows match, so
		// a purchase that refunded in the window between the failed transfer and the
		// retry owes nobody anything — the buyer's money for that item is already gone
		// from the charge the transfer would draw from.
		fake.responses["transfers.create"] = {};
		try {
			const piId = `pi_${uid()}`;
			const sessionId = `cs_${uid()}`;
			await seedSplitBasket(sessionId);
			const session = fakeSessionFor(piId);
			session.id = sessionId;
			fake.responses["checkout.sessions.list"] = asyncList([session]);
			const event = stripeEvent("payment_intent.succeeded", {
				id: piId,
				object: "payment_intent",
				latest_charge: `ch_${uid()}`,
			});
			expect((await sendWebhook(event)).status).toBe(200);

			// Creator A's buyer refunds before the retry lands.
			await db
				.update(purchases)
				.set({ status: "refunded" })
				.where(
					and(eq(purchases.stripePaymentIntentId, piId), eq(purchases.creatorId, firstCreatorId)),
				);

			fake.reset();
			delete fake.responses["transfers.create"];
			const attempted = await retryFailedTransfers();
			expect(attempted).toBeGreaterThanOrEqual(1);
			// The refunded creator's key is ABSENT — the whole safety property — and
			// the surviving creator's share is paid.
			const keys = fake
				.callsTo("transfers.create")
				.map((c) => (c.args[1] as { idempotencyKey?: string }).idempotencyKey);
			expect(keys).not.toContain(`purchase_transfer_${piId}_${firstCreatorId}`);
			expect(keys).toContain(`purchase_transfer_${piId}_${secondCreatorId}`);

			// The refunded row stays unstamped forever — there is nothing left to move.
			const [refundedRow] = await db
				.select()
				.from(purchases)
				.where(
					and(eq(purchases.stripePaymentIntentId, piId), eq(purchases.creatorId, firstCreatorId)),
				);
			expect(refundedRow.stripeTransferId).toBeNull();
		} finally {
			delete fake.responses["transfers.create"];
		}
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

describe("GET /stripe/onboard — reconcile on read", () => {
	/**
	 * The missed-webhook self-heal. Two live onboardings were stranded with all-false
	 * rows when `account.updated` deliveries were missed; the GET route now asks Stripe
	 * when the row says incomplete and syncs it through the webhook's own derivation.
	 * These tests own a separate user so shared fixture rows are left untouched —
	 * `stripe_accounts.user_id` is UNIQUE and the suite's other sections rely on theirs.
	 */
	let reconCookie: string;
	let reconId: number;

	async function strandedRow() {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, reconId));
		const acctId = `acct_${uid()}`;
		await db.insert(stripeAccounts).values({ userId: reconId, stripeAccountId: acctId });
		return acctId;
	}

	/** A row already in agreement with Stripe — the case no reconcile is needed for. */
	async function knownGoodRow() {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, reconId));
		const acctId = `acct_${uid()}`;
		await db.insert(stripeAccounts).values({
			userId: reconId,
			stripeAccountId: acctId,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
		return acctId;
	}

	beforeAll(async () => {
		({ cookie: reconCookie, id: reconId } = await signUp(reconName));
	});

	it("asks Stripe for a manual payout schedule at account creation — the decided posture, not Stripe's daily default", async () => {
		// Creator-chosen payouts (2026-09-14) mean no schedule until the creator picks one;
		// Stripe's Express default is daily, and the first live onboarding came out of that
		// flow enrolled in it. The create call's `settings` is where the default is refused.
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, reconId));

		const res = await req("/api/payments/stripe/onboard", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: reconCookie },
		});
		expect(res.status).toBe(200);

		const schedule = (
			fake.lastAccountCreate() as {
				settings?: { payouts?: { schedule?: { interval?: string } } };
			} | null
		)?.settings?.payouts?.schedule;
		expect(schedule).toEqual({ interval: "manual" });
	});

	it("self-heals a row the webhook's delivery missed — the incident's exact shape", async () => {
		const acctId = await strandedRow();

		const res = await req("/api/payments/stripe/onboard", { headers: { Cookie: reconCookie } });
		expect(res.status).toBe(200);
		const body = await res.json();
		// Stripe's truth is what the creator is told, not the stale row's.
		expect(body.hasAccount).toBe(true);
		expect(body.onboardingComplete).toBe(true);
		expect(body.chargesEnabled).toBe(true);
		expect(body.payoutsEnabled).toBe(true);

		// The row was written too, so every other reader — the release gate, the
		// settings card — now agrees with Stripe without another live read.
		const [row] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.stripeAccountId, acctId));
		expect(row.onboardingComplete).toBe(true);
		expect(row.chargesEnabled).toBe(true);
		expect(row.payoutsEnabled).toBe(true);
		expect(fake.callsTo("accounts.retrieve")).toHaveLength(1);
	});

	it("keeps a genuinely incomplete account at false — reconcile copies Stripe, it never decides", async () => {
		const acctId = await strandedRow();
		fake.responses["accounts.retrieve"] = {
			id: acctId,
			object: "account",
			charges_enabled: false,
			payouts_enabled: false,
			details_submitted: true,
		};
		try {
			const res = await req("/api/payments/stripe/onboard", {
				headers: { Cookie: reconCookie },
			});
			const body = await res.json();
			expect(body.onboardingComplete).toBe(false);

			// The row still synced to Stripe's current (false) state — a later true
			// arrives by the same path. The gate's verdict is Stripe's own.
			const [row] = await db
				.select()
				.from(stripeAccounts)
				.where(eq(stripeAccounts.stripeAccountId, acctId));
			expect(row.onboardingComplete).toBe(false);
			expect(row.chargesEnabled).toBe(false);
		} finally {
			delete fake.responses["accounts.retrieve"];
		}
	});

	it("costs no Stripe read when the row already agrees with Stripe", async () => {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, reconId));
		await db.insert(stripeAccounts).values({
			userId: reconId,
			stripeAccountId: `acct_${uid()}`,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
		const before = fake.callsTo("accounts.retrieve").length;

		const res = await req("/api/payments/stripe/onboard", { headers: { Cookie: reconCookie } });
		const body = await res.json();
		expect(body.onboardingComplete).toBe(true);
		expect(fake.callsTo("accounts.retrieve")).toHaveLength(before);
	});

	/**
	 * The detail shape: Stripe's requirements, the payout schedule and bank, and the
	 * connected account's balance — the fuller view the Studio Payments tab renders.
	 */
	it("returns Stripe's requirements, schedule, bank and balance at ?detail=1", async () => {
		const acctId = await knownGoodRow();
		fake.responses["accounts.retrieve"] = {
			id: acctId,
			object: "account",
			charges_enabled: true,
			payouts_enabled: true,
			details_submitted: true,
			requirements: {
				currently_due: ["individual.address.line1"],
				past_due: [],
				pending_verification: ["individual.dob.year"],
				disabled_reason: null,
			},
			settings: { payouts: { schedule: { interval: "manual" } } },
			external_accounts: {
				object: "list",
				data: [{ object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789" }],
			},
		};
		fake.responses["balance.retrieve"] = {
			object: "balance",
			available: [{ amount: 1234, currency: "usd" }],
			pending: [{ amount: 500, currency: "usd" }],
			livemode: false,
		};
		try {
			const res = await req("/api/payments/stripe/onboard?detail=1", {
				headers: { Cookie: reconCookie },
			});
			const body = await res.json();
			expect(body.hasAccount).toBe(true);
			expect(body.chargesEnabled).toBe(true);
			expect(body.requirements.currentlyDue).toEqual(["individual.address.line1"]);
			expect(body.requirements.pendingVerification).toEqual(["individual.dob.year"]);
			expect(body.schedule).toEqual({ interval: "manual" });
			expect(body.externalAccount).toEqual({ bankName: "STRIPE TEST BANK", last4: "6789" });
			expect(body.balance.available[0]).toEqual({ amount: 1234, currency: "usd" });
			expect(body.balance.pending[0]).toEqual({ amount: 500, currency: "usd" });
			// The read that ran was FOR this account, at detail only.
			expect(fake.lastCall("accounts.retrieve")?.args[0]).toBe(acctId);
		} finally {
			delete fake.responses["accounts.retrieve"];
			delete fake.responses["balance.retrieve"];
		}
	});

	it("returns a pending account's requirements at detail, without deciding anything", async () => {
		// `details_submitted` true and everything else false: the waiting window, in
		// Stripe's own words — the shape that tells the tab to render "Waiting on Stripe"
		// rather than offering a link the creator has already used.
		const acctId = await strandedRow();
		fake.responses["accounts.retrieve"] = {
			id: acctId,
			object: "account",
			charges_enabled: false,
			payouts_enabled: false,
			details_submitted: true,
			requirements: {
				currently_due: ["external_account"],
				past_due: [],
				pending_verification: [],
				disabled_reason: null,
			},
		};
		try {
			const res = await req("/api/payments/stripe/onboard?detail=1", {
				headers: { Cookie: reconCookie },
			});
			const body = await res.json();
			expect(body.chargesEnabled).toBe(false);
			expect(body.detailsSubmitted).toBe(true);
			expect(body.requirements.currentlyDue).toEqual(["external_account"]);
		} finally {
			delete fake.responses["accounts.retrieve"];
		}
	});

	it("gives a creator with no account the not-connected shape at detail", async () => {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, reconId));

		const res = await req("/api/payments/stripe/onboard?detail=1", {
			headers: { Cookie: reconCookie },
		});
		const body = await res.json();
		expect(body.hasAccount).toBe(false);
		expect(body.detailsSubmitted).toBe(false);
	});

	it("returns a Stripe Express Dashboard login link for a connected creator", async () => {
		await knownGoodRow();

		const res = await req("/api/payments/stripe/dashboard-link", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: reconCookie },
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.url).toContain("connect.stripe.test/dashboard");
	});

	it("refuses the Dashboard door to a creator with no connected account", async () => {
		await db.delete(stripeAccounts).where(eq(stripeAccounts.userId, reconId));

		const res = await req("/api/payments/stripe/dashboard-link", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: reconCookie },
		});
		expect(res.status).toBe(409);
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
	 * bought. `fresh` clears first; without it the adds append, which a mixed-creator
	 * basket relies on: any number of creators coexist since the 2026-10-15 split.
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

		// 🚨 Customer and customer_email are either-or — Stripe refuses the pair (found
		// live 2026-10-15 as a 500 on every buyer holding a Customer). This buyer holds
		// one, so the session names it and takes its email from the Customer (every door
		// that creates one passes the account's email): the 2026-10-06 greyed-Pay-button
		// rule is met through the Customer, and the email param rides only when there is
		// no Customer to carry it.
		expect(params.customer).toBeTruthy();
		expect(params.customer_email).toBeUndefined();

		// 🚨 The split shape (Parker, 2026-10-15): the session charges the PLATFORM — no
		// `transfer_data` rides it, because a destination charge names exactly one
		// connected account and that constraint is what this basket used to be refused
		// over. The creator's share moves at completion, as one transfer per creator
		// funded by the charge, pinned in the completion tests below.
		expect(
			(params.payment_intent_data as { transfer_data?: unknown }).transfer_data,
		).toBeUndefined();
		// The earnings the response reports are still the whole basket's, on the sum —
		// the fee is per charge, which is the entire point of the basket.
		const expected = calculateFees(new Decimal(UNIT).times(3), { type: "digital" });
		expect(body.creatorEarnings).toBe(expected.creatorEarnings.toFixed(2));
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

	it("carries two creators on one charge — the dealbreaker, fixed (2026-10-15)", async () => {
		// The behavior this whole change exists to deliver: a basket holding two
		// creators' Works checks out as ONE session, ONE charge, and never wiped the
		// first creator's items on the second creator's add. The add is the ordinary
		// route now — no seeded-table hack, because the mixed state is no longer a race
		// only SQL could produce.
		await seedBasket([items[0].id, otherCreatorWorkId], { fresh: true });
		const added = await req("/api/payments/basket", {
			headers: { Origin: ORIGIN, Cookie: buyerCookie },
		});
		expect(((await added.json()) as { count: number }).count).toBe(2);

		const { res, body } = await basket([]);
		expect(res.status).toBe(200);
		const params = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		expect(params.line_items).toHaveLength(2);
		expect(
			(params.payment_intent_data as { transfer_data?: unknown }).transfer_data,
		).toBeUndefined();

		// One pending row per Work, each carrying its own creator — the completion path
		// groups by exactly this column to split the charge.
		const sessionId = String(body.clientSecret).split("_secret")[0];
		const rows = await db
			.select()
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, sessionId));
		expect(rows).toHaveLength(2);
		expect(new Set(rows.map((r) => r.creatorId)).size).toBe(2);
	});

	it("refuses the basket when either creator cannot take the money", async () => {
		// The precondition, now per creator: Anthers does not sell a creator's work
		// when the money cannot reach them, and a mixed basket asks for several
		// creators' money to move at once — every one of them must be reachable
		// before the buyer is charged. A third creator with no connected account.
		const { id: unconnected } = await signUp(`bskt_unconnected_${run}`);
		const strandedWorkId = (
			await insertWork({
				creatorId: unconnected,
				type: "game",
				title: `Unconnected creator ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: ODD,
			})
		).id;
		await seedBasket([items[0].id, strandedWorkId], { fresh: true });
		const { res, body } = await basket([]);
		expect(res.status).toBe(409);
		expect(body.error).toBe("This creator can't accept payments yet.");
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

		// Each line carries its own share of the ONE fee (the Basket card's receives
		// tooltip names it), and the shares sum to the whole — apportioned, never
		// recomputed per item.
		const shares = body.items.reduce(
			(acc: Decimal, i: { processingFee: string }) => acc.plus(new Decimal(i.processingFee)),
			new Decimal(0),
		);
		expect(shares.toFixed(2)).toBe(body.processingFee);
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
		// 🚨 Customer and customer_email are either-or — Stripe refuses the pair (found
		// live 2026-10-15 as a 500 on every buyer holding a Customer). This buyer holds
		// one, so the session names it and takes its email from the Customer (every door
		// that creates one passes the account's email); the email param rides only when
		// there is no Customer to carry it.
		expect(params.customer).toBeTruthy();
		expect(params.customer_email).toBeUndefined();
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

	it("reuses the buyer's Customer when they have one, and creates none when they don't", async () => {
		// The 2026-10-11 posture in the session itself. Nothing to reuse: the params name
		// `if_required` — a buyer who saved nothing and holds no subscription leaves no
		// Customer at Stripe behind. Something to reuse: `customer` — the session pays on
		// the record the saved address (or subscription) already made, so one buyer
		// accumulates into one Customer rather than one per flow.
		await db.delete(billingAccounts).where(eq(billingAccounts.userId, buyerId));
		const { res: noneRes } = await checkout();
		expect(noneRes.status).toBe(200);
		const none = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		expect(none.customer_creation).toBe("if_required");
		expect(none.customer).toBeUndefined();
		// The either-or's positive half: no Customer, so the verified account's email
		// rides the session — the 2026-10-06 greyed-Pay-button rule.
		expect(none.customer_email).toBe(`${buyerName}@example.com`);

		const savedId = `cus_saved_${uid()}`;
		await db
			.insert(billingAccounts)
			.values({ userId: buyerId, stripeCustomerId: savedId })
			.onConflictDoUpdate({ target: billingAccounts.userId, set: { stripeCustomerId: savedId } });
		const { res: reuseRes } = await checkout();
		expect(reuseRes.status).toBe(200);
		const reuse = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		expect(reuse.customer).toBe(savedId);
		expect(reuse.customer_creation).toBeUndefined();
		// And the pair's refusal shape never appears: no `customer_email` beside a
		// named Customer.
		expect(reuse.customer_email).toBeUndefined();
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

	it("charges the platform — the creator's share is pinned on the row, not the session", async () => {
		await connectCreator();

		const { res, body } = await checkout();
		expect(res.status).toBe(200);

		const params = fake.lastCall("checkout.sessions.create")?.args[0] as
			| Stripe.Checkout.SessionCreateParams
			| undefined;
		const intentData = params?.payment_intent_data as {
			transfer_data?: unknown;
			application_fee_amount?: number;
		};

		// The split shape (Parker, 2026-10-15): the session charges the PLATFORM and the
		// creator's share moves at completion as one transfer per creator, funded by the
		// charge — so nothing about the destination rides the session. The earnings the
		// completion transfer will move are pinned where the money's record lives, the
		// purchase row, at the price the creator set: location-independent by the same
		// construction the old `transfer_data[amount]` pin bought, one door further on.
		expect(intentData.transfer_data).toBeUndefined();
		// And deliberately NO `application_fee_amount` either: a static fee was the old
		// structure's way of holding the tax back, and it has no meaning under a platform
		// charge — whatever tax Stripe adds stays on the platform side by construction.
		expect(intentData.application_fee_amount).toBeUndefined();
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

// ─────────────────────────────────────────────────────────────────────────────
// The Badge first transaction — the checkout rail of support money (2026-10-15).
//
// A Badge bought from a creator page is a purchase: charged on the one checkout
// session, recorded in `badge_charges`, and at completion it writes the holding,
// moves the issuer's recurring line under proration none, records the day-exact
// reduction — and never transfers (support settles through the cycle distribution).
// The cases below send the real webhook for a pending session and assert everything
// the completion wrote, against the same model helpers the code derives from.

describe("Webhook: the Badge first transaction's completion", () => {
	let issuerId = 0;
	let rungId = 0;
	let workCreatorId = 0;
	let basketWorkId = 0;

	beforeAll(async () => {
		issuerId = (await signUp(`badge_issuer_${run}`)).id;
		rungId = (
			await db
				.insert(badges)
				.values({
					creatorId: issuerId,
					threshold: "6.00",
					label: "Sprout",
					description: "A fixture rung the badge suite holds.",
				})
				.returning({ id: badges.id })
		)[0].id;
		// A second creator selling a Work, connected — the mixed-charge case needs the
		// transfer path live beside the badge line. The ISSUER is connected too: the
		// completion's split must never receive badge money even when the issuer COULD
		// take a transfer, which is exactly the shape the mixed-charge test pins.
		workCreatorId = (await signUp(`badge_wcreator_${run}`)).id;
		await db.insert(stripeAccounts).values({
			userId: workCreatorId,
			stripeAccountId: `acct_${uid()}`,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
		await db.insert(stripeAccounts).values({
			userId: issuerId,
			stripeAccountId: `acct_badgeissuer_${uid()}`,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
		basketWorkId = (
			await insertWork({
				creatorId: workCreatorId,
				type: "game",
				title: `Badge basket work ${run}`,
				streamEnabled: false,
				downloadEnabled: true,
				access: FOR_SALE,
			})
		).id;
	}, DB_SETUP_TIMEOUT);

	beforeEach(() => {
		// The fake's calls accumulate across the file's describes; every test here
		// asserts on what IT made Stripe do, so each starts from a clean record.
		fake.reset();
		delete fake.responses["subscriptions.retrieve"];
	});

	afterEach(() => {
		delete fake.responses["subscriptions.retrieve"];
	});

	/** A buyer fresh to this test, so no test's writes can be another test's state. */
	async function freshBuyer(name: string): Promise<number> {
		return (await signUp(`badge_${name}_${run}`)).id;
	}

	/** One pending badge charge, keyed to a session — the state `.post("/basket/checkout")` leaves. */
	async function pendingBadgeCharge(
		buyer: number,
		sessionId: string,
		opts: Partial<typeof badgeCharges.$inferInsert> = {},
	) {
		await db.insert(badgeCharges).values({
			buyerId: buyer,
			badgeId: opts.badgeId ?? rungId,
			creatorId: opts.creatorId ?? issuerId,
			badgeLabel: opts.badgeLabel ?? "Sprout",
			threshold: opts.threshold ?? "6.00",
			chargedAmount: opts.chargedAmount ?? "6.00",
			processingFee: opts.processingFee ?? "0.48",
			billingCycle: opts.billingCycle ?? cycleKeyFor(new Date()),
			stripePaymentIntentId: sessionId,
			status: "pending",
		});
	}

	/**
	 * A completed payment intent + the session the completion resolves from — including
	 * the metadata the checkout stamped (`buyerId`), which is what the badge half is
	 * addressed by, and the saved payment method when one rode the charge.
	 */
	function completedSession(
		buyer: number,
		opts: { taxCents?: number; paymentMethod?: boolean } = {},
	) {
		const piId = `pi_${uid()}`;
		const sessionId = `cs_${uid()}`;
		// The saved card rides the session and the intent alike — what the completion
		// reads as the renewal's payment method.
		const session = fakeSessionFor(piId, { taxCents: opts.taxCents ?? 0 }) as ReturnType<
			typeof fakeSessionFor
		> & { payment_method?: string };
		session.id = sessionId;
		if (opts.paymentMethod ?? true) {
			session.payment_method = `pm_${uid()}`;
		}
		fake.responses["checkout.sessions.list"] = asyncList([session]);
		const event = stripeEvent("payment_intent.succeeded", {
			id: piId,
			object: "payment_intent",
			// The split's funding read and the badge half's card read both come off
			// the intent Stripe gave the webhook — a real one carries its charge.
			latest_charge: `ch_${uid()}`,
			metadata: { buyerId: String(buyer) },
			...((opts.paymentMethod ?? true) ? { payment_method: session.payment_method } : {}),
		});
		return { sessionId, event };
	}

	it("🚨 completes a pending badge charge: the row, the holding, the proration-none line, the day-exact reduction — and NO transfer", async () => {
		const buyer = await freshBuyer("sub_buyer");
		const subId = `sub_${uid()}`;
		// The buyer's subscription is live, with no line for the issuer yet — the existing
		// subscription's issuer line join, the badge-purchase half of the raise.
		await db
			.insert(billingAccounts)
			.values({ userId: buyer, stripeCustomerId: `cus_${uid()}`, stripeSubscriptionId: subId })
			.onConflictDoUpdate({ target: billingAccounts.userId, set: { stripeSubscriptionId: subId } });
		fake.responses["subscriptions.retrieve"] = subscription({ id: subId, anthers: 3 });

		const { sessionId, event } = completedSession(buyer, { paymentMethod: false });
		await pendingBadgeCharge(buyer, sessionId);
		expect((await sendWebhook(event)).status).toBe(200);

		// The row moved on the same latch, re-keyed to the intent — the completion's
		// whole job, read by the intent like every other post-completion read here.
		const piId = (event.data.object as { id: string }).id;
		const [row] = await db
			.select()
			.from(badgeCharges)
			.where(eq(badgeCharges.stripePaymentIntentId, piId));
		expect(row.status).toBe("completed");

		// The holding is the rung the row names, for the cycle the completion ran in.
		const [holding] = await db
			.select()
			.from(userBadges)
			.where(
				and(eq(userBadges.userId, buyer), eq(userBadges.billingCycle, cycleKeyFor(new Date()))),
			);
		expect(holding.badgeId).toBe(rungId);

		// The recurrence line: moved UNDER proration none (the checkout carried the
		// charge today), stamped for the issuer, and the buyer's cancellation cleared.
		const updateCall = fake.lastCall("subscriptions.update");
		expect(updateCall?.args[0]).toBe(subId);
		const params = updateCall?.args[1] as Stripe.SubscriptionUpdateParams;
		expect(params.proration_behavior).toBe("none");
		expect(params.cancel_at_period_end).toBe(false);
		expect((params as { metadata?: { userId?: string } }).metadata?.userId).toBe(String(buyer));
		const line = (
			params.items as {
				metadata?: { destination?: string };
				price_data?: { unit_amount?: number };
			}[]
		)[0];
		expect(line.metadata?.destination).toBe(String(issuerId));
		expect(line.price_data?.unit_amount).toBe(600);
		// And no subscription was created — the buyer's exists, the line joined it.
		expect(fake.callsTo("subscriptions.create")).toHaveLength(0);

		// The day-exact missed-days reduction, keyed to the next cycle — the exact
		// figure the model's own raise path records.
		const owed = await db
			.select()
			.from(supportReductions)
			.where(eq(supportReductions.userId, buyer));
		expect(owed).toHaveLength(1);
		expect(owed[0].billingCycle).toBe(nextCycleKey(cycleKeyFor(new Date())));
		expect(new Decimal(owed[0].amount).toFixed(2)).toBe(reductionFor(6, new Date()).toFixed(2));

		// 🚨 And NO transfer: badge money settles through the cycle distribution, not a
		// completion split — the completion never touches the transfer job for badge rows.
		expect(fake.callsTo("transfers.create")).toHaveLength(0);
	});

	it("creates a TRIAL to the next 1st for a buyer with none — the saved card riding it, no invoice today", async () => {
		const buyer = await freshBuyer("fresh_buyer");
		const { sessionId, event } = completedSession(buyer);
		const savedMethod = (event.data.object as { payment_method: string }).payment_method;
		await pendingBadgeCharge(buyer, sessionId);

		await sendWebhook(event);

		const createCall = fake.lastCall("subscriptions.create");
		const params = createCall?.args[0] as Stripe.SubscriptionCreateParams;
		// The trial is the shape that charges nothing today and bills the FULL rung at the
		// next 1st (the probe killed the future-anchor's stub charge — see billing.ts).
		expect(params.trial_end).toBe(Math.floor(cycleStart(nextCycleKey(cycleKeyFor(new Date()))).getTime() / 1000));
		expect(params.billing_cycle_anchor).toBeUndefined();
		expect(params.default_payment_method).toBe(savedMethod);
		const line = (params.items as { metadata?: { destination?: string } }[])[0];
		expect(line.metadata?.destination).toBe(String(issuerId));
		// And the existing-subscription branch never ran for this buyer.
		expect(fake.callsTo("subscriptions.update")).toHaveLength(0);
	});

	it("🚨 on a MIXED charge never moves a transfer for badge money — and apportion the charge's one tax across both tables, summing exactly", async () => {
		const buyer = await freshBuyer("mixed_buyer");
		const { sessionId, event } = completedSession(buyer, { taxCents: 100, paymentMethod: false });
		// Two works rows + one badge row, the odd amounts the pro-rata split has to work on.
		await db.insert(purchases).values([
			{
				buyerId: buyer,
				workId: basketWorkId,
				creatorId: workCreatorId,
				workTitle: "Mixed row A",
				workType: "game",
				type: "digital",
				amount: "3.00",
				processingFee: "0.19",
				creatorEarnings: "2.81",
				stripePaymentIntentId: sessionId,
				status: "pending",
			},
			{
				buyerId: buyer,
				workId: basketWorkId,
				creatorId: workCreatorId,
				workTitle: "Mixed row B",
				workType: "game",
				type: "digital",
				amount: "7.00",
				processingFee: "0.50",
				creatorEarnings: "6.50",
				stripePaymentIntentId: sessionId,
				status: "pending",
			},
		]);
		await pendingBadgeCharge(buyer, sessionId, {
			chargedAmount: "6.00",
			threshold: "6.00",
			processingFee: "0.24",
		});

		await sendWebhook(event);

		// The tax the completion stamped: three rows sum to EXACTLY what the session
		// collected. ($1.00 across $16 — 0.19 + 0.44 + the badge row absorbing 0.37.)
		// Post-completion reads go by the intent — the rows were re-keyed to it.
		const piId = (event.data.object as { id: string }).id;
		const purchaseRows = await db
			.select()
			.from(purchases)
			.where(and(eq(purchases.stripePaymentIntentId, piId), eq(purchases.status, "completed")));
		const badgeRow = await db
			.select()
			.from(badgeCharges)
			.where(eq(badgeCharges.stripePaymentIntentId, piId));
		expect(purchaseRows.map((r) => new Decimal(r.salesTax).toFixed(2)).sort()).toEqual([
			"0.19",
			"0.44",
		]);
		expect(badgeRow[0].status).toBe("completed");
		expect(new Decimal(badgeRow[0].salesTax).toFixed(2)).toBe("0.37");

		// The works' money moved; the badge's did not — one transfer, funded by the
		// charge, to the works creator only.
		const transfers = fake.callsTo("transfers.create");
		expect(transfers).toHaveLength(1);
	});

	it("is a no-op on redelivery — the re-key and the pending latch both cover the badge half", async () => {
		const buyer = await freshBuyer("redelivery_buyer");
		// An existing subscription, so the line move (not the create) is the branch the
		// latch has to protect from a second delivery's half-run.
		const subId = `sub_${uid()}`;
		await db
			.insert(billingAccounts)
			.values({ userId: buyer, stripeSubscriptionId: subId })
			.onConflictDoUpdate({ target: billingAccounts.userId, set: { stripeSubscriptionId: subId } });
		fake.responses["subscriptions.retrieve"] = subscription({ id: subId, anthers: 3 });

		const { sessionId, event } = completedSession(buyer, { paymentMethod: false });
		await pendingBadgeCharge(buyer, sessionId);

		expect((await sendWebhook(event)).status).toBe(200);
		expect(
			await db.select().from(supportReductions).where(eq(supportReductions.userId, buyer)),
		).toHaveLength(1);

		// A second delivery may write nothing: the row is completed, so the badge half
		// never runs again — no second reduction, no second line move.
		expect((await sendWebhook(event)).status).toBe(200);
		expect(
			await db.select().from(supportReductions).where(eq(supportReductions.userId, buyer)),
		).toHaveLength(1);
		expect(fake.callsTo("subscriptions.update")).toHaveLength(1);

		// And the holding is ONE row (upsert convergence — the pick replaces, never adds).
		const holdings = await db
			.select()
			.from(userBadges)
			.where(
				and(eq(userBadges.userId, buyer), eq(userBadges.billingCycle, cycleKeyFor(new Date()))),
			);
		expect(holdings).toHaveLength(1);
	});

	/**
	 * ⭐ The Anthers ladder rides the same rail and the same vocabulary: an issuer's id,
	 * whoever the issuer is. Raising the Anthers line through a badge purchase hits the
	 * existing stamped item by the SAME read every other issuer's line uses.
	 */
	it("raises the Anthers line through its own badge the way it raises any issuer's", async () => {
		const buyer = await freshBuyer("anthers_buyer");
		const anthersId = await anthersUserId();
		// (the Anthers ladder's $9 rung, seeded by the fixture the file loaded at import)
		const [anthersRung] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, "9.00")))
			.limit(1);
		const rung = anthersRung.id;

		const subId = `sub_${uid()}`;
		await db
			.insert(billingAccounts)
			.values({ userId: buyer, stripeSubscriptionId: subId })
			.onConflictDoUpdate({ target: billingAccounts.userId, set: { stripeSubscriptionId: subId } });
		// The Anthers line exists, stamped "anthers" — the retired literal still read as it.
		fake.responses["subscriptions.retrieve"] = subscription({ id: subId, anthers: 3 });

		const { sessionId, event } = completedSession(buyer, { paymentMethod: false });
		await pendingBadgeCharge(buyer, sessionId, {
			badgeId: rung,
			creatorId: anthersId,
			threshold: "9.00",
			chargedAmount: "6.00",
			badgeLabel: "Petal",
		});
		await sendWebhook(event);

		// The pick found the EXISTING anthers line and updated it in place — the delta
		// $6 badge charge carrying the raise of a $3 line to $9, no second line written.
		const params = fake.lastCall("subscriptions.update")
			?.args[1] as Stripe.SubscriptionUpdateParams;
		const line = (
			params.items as {
				id?: string;
				metadata?: { destination?: string };
				price_data?: { unit_amount?: number };
			}[]
		)[0];
		expect(line.id).toBeDefined();
		expect(line.metadata?.destination).toBe(String(anthersId));
		expect(line.price_data?.unit_amount).toBe(900);
		// The holding is the Anthers rung — the same row shape as any issuer's, one per
		// issuer within the cycle (the issuer pick replaces).
		const holding = await db
			.select()
			.from(userBadges)
			.where(
				and(eq(userBadges.userId, buyer), eq(userBadges.billingCycle, cycleKeyFor(new Date()))),
			);
		expect(holding.filter((h) => h.badgeId === rung)).toHaveLength(1);
	});
});

/**
 * The badge checkout surfaces — quote, basket checkout, buy-now — at the route level,
 * against the same recording fake: what the session was built WITH is the whole test.
 */
describe("The badge checkout routes", () => {
	let cookie: string;
	let buyerId2 = 0;
	let issuerCookie: string;
	let issuerId2 = 0;
	let issuerRungId = 0;
	const issuerHandle = `route_badge_issuer_${run}`;

	beforeAll(async () => {
		({ cookie, id: buyerId2 } = await signUp(`route_badge_buyer_${run}`));
		({ cookie: issuerCookie, id: issuerId2 } = await signUp(issuerHandle));
		issuerRungId = (
			await db
				.insert(badges)
				.values({
					creatorId: issuerId2,
					threshold: "6.00",
					label: "Route rung",
					description: "A fixture rung the badge routes hold.",
				})
				.returning({ id: badges.id })
		)[0].id;
		await db.insert(stripeAccounts).values({
			userId: issuerId2,
			stripeAccountId: `acct_${uid()}`,
			chargesEnabled: true,
			payoutsEnabled: true,
			onboardingComplete: true,
		});
	}, DB_SETUP_TIMEOUT);

	beforeEach(() => {
		// Same discipline as the completion describe: the fake's record is per-test, and
		// the subscription stubs never outlive the test that set them.
		fake.reset();
		delete fake.responses["subscriptions.retrieve"];
	});

	afterEach(() => {
		delete fake.responses["subscriptions.retrieve"];
	});

	it("🚨 buy-now builds the one-line session: the rung's Product, the full fee pinned, the saved card — and the basket untouched", async () => {
		const res = await req("/api/payments/badges/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ badgeId: issuerRungId }),
		});
		expect(res.status).toBe(200);

		const params = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		const line = params.line_items?.[0] as {
			price_data: { unit_amount?: number; product?: string; tax_behavior?: string };
		};
		expect(line.price_data.unit_amount).toBe(600);
		expect(line.price_data.product).toMatch(/^prod_/);
		expect(line.price_data.tax_behavior).toBe("exclusive");
		// The card rides — a buyer with no subscription has a renewal to bill.
		expect(params.payment_intent_data?.setup_future_usage).toBe("off_session");
		const metadata = params.payment_intent_data?.metadata as Record<string, string>;
		expect(metadata.kind).toBe("direct_purchase_badge");
		expect(metadata.badgeIds).toBe(String(issuerRungId));

		// The row the completion will find: pending, keyed to the session, the fee the
		// lone line's share — the whole charge's fee — and the cycle today's. (The
		// fake mints the session id on its side, so the row is found by the buyer's
		// latest — this suite runs its describes in order and the buyer here is
		// otherwise rowless.)
		const [row] = await db
			.select()
			.from(badgeCharges)
			.where(eq(badgeCharges.buyerId, buyerId2))
			.orderBy(desc(badgeCharges.id))
			.limit(1);
		expect(row).toBeDefined();
		expect(row.status).toBe("pending");
		expect(row.threshold).toBe("6.00");
		expect(row.chargedAmount).toBe("6.00");
		expect(new Decimal(row.processingFee).toFixed(2)).toBe(cardFee(6).toFixed(2));
		expect(row.billingCycle).toBe(cycleKeyFor(new Date()));

		// Buy-now bypassed the basket: whatever the buyer had parked is still parked.
		// (This buyer parked nothing; the invariant is the route never calls clearBasket —
		// asserted by the counts below.)
		const after = await req("/api/payments/basket", { headers: { Cookie: cookie } });
		expect(((await after.json()) as { count: number }).count).toBe(0);
	});

	it("🚨 quotes the badge line with the first transaction's price beside the monthly one", async () => {
		const add = await req("/api/payments/basket/items", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ badgeId: issuerRungId }),
		});
		expect(add.status).toBe(200);

		const res = await req("/api/payments/basket/quote", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: "{}",
		});
		expect(res.status).toBe(200);
		const quote = (await res.json()) as {
			items: {
				kind: string;
				badgeId?: number;
				price: string;
				recurring: string | null;
				title?: string | null;
			}[];
			creators: { itemCount: number; receives: string }[];
			subtotal: string;
			processingFee: string;
			feeSeparately: string;
		};
		const line = quote.items.find((i) => i.kind === "badge") as {
			badgeId: number;
			price: string;
			recurring: string | null;
			title?: string | null;
		};
		expect(line.badgeId).toBe(issuerRungId);
		// The whole threshold — the buyer holds nothing from this issuer yet.
		expect(line.price).toBe("6.00");
		expect(line.recurring).toBe("6.00");
		expect(quote.items).toHaveLength(1);
		// The lone line's fee share is the whole charge's fee, and the issuer receives
		// the remainder — read off the server, never derived here.
		expect(quote.subtotal).toBe("6.00");
		expect(new Decimal(quote.processingFee).toFixed(2)).toBe(cardFee(6).toFixed(2));
		expect(quote.creators[0].itemCount).toBe(1);
		expect(quote.creators[0].receives).toBe("5.53");

		// And the basket read answers the same shape the page renders from.
		const read = await req("/api/payments/basket", { headers: { Cookie: cookie } });
		const items = (
			(await read.json()) as {
				items: { kind: string; badgeId?: number; recurring?: string | null; price: string }[];
			}
		).items;
		expect(items[0].kind).toBe("badge");
		expect(items[0].badgeId).toBe(issuerRungId);
		expect(items[0].recurring).toBe("6.00");
	});

	it("🚨 carries the badge line into the basket checkout — and saves the card, because a renewal awaits and nothing else does", async () => {
		const res = await req("/api/payments/basket/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: "{}",
		});
		expect(res.status).toBe(200);

		const params = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		const line = params.line_items?.[0] as {
			price_data: { unit_amount?: number; product?: string };
		};
		expect(line.price_data.unit_amount).toBe(600);
		expect(line.price_data.product).toMatch(/^prod_/);
		// The save — a Badge ride with no existing subscription is the one payment a
		// purchase checkout may leave a card behind for.
		expect(params.payment_intent_data?.setup_future_usage).toBe("off_session");
		const metadata = params.payment_intent_data?.metadata as Record<string, string>;
		expect(metadata.kind).toBe("direct_purchase_basket");
		expect(metadata.badgeIds).toBe(String(issuerRungId));

		// The row keyed to the session id the fake minted; the basket cleared at checkout.
		const [row] = await db
			.select()
			.from(badgeCharges)
			.where(eq(badgeCharges.buyerId, buyerId2))
			.orderBy(desc(badgeCharges.id))
			.limit(1);
		expect(row.status).toBe("pending");
		const after = await req("/api/payments/basket", { headers: { Cookie: cookie } });
		expect(((await after.json()) as { count: number }).count).toBe(0);
	});

	it("never saves a card on a plain works-only basket — the 2026-10-06 posture, not the badge's", async () => {
		const fresh = await signUp(`route_work_buyer_${run}`);
		const work = await insertWork({
			creatorId: issuerId2,
			type: "game",
			title: `Badge route work ${run}`,
			streamEnabled: false,
			downloadEnabled: true,
			access: FOR_SALE,
		});
		await req("/api/payments/basket/items", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: fresh.cookie },
			body: JSON.stringify({ workId: work.id }),
		});

		const res = await req("/api/payments/basket/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: fresh.cookie },
			body: "{}",
		});
		expect(res.status).toBe(200);
		const params = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		// A buyer with no subscription buying only Works: nothing to recur, so nothing
		// is saved — the posture that kept the Link consent block off every purchase.
		expect(params.payment_intent_data?.setup_future_usage).toBeUndefined();
		// And no badge rows were written for it.
		const rows = await db
			.select()
			.from(badgeCharges)
			.where(eq(badgeCharges.buyerId, fresh.id))
			.orderBy(desc(badgeCharges.id))
			.limit(1);
		expect(rows).toHaveLength(0);
	});

	it("refuses a badge ride from a buyer whose subscription renewal has failed", async () => {
		const pastBuyer = await signUp(`route_past_${run}`);
		const subId = `sub_${uid()}`;
		await db
			.insert(billingAccounts)
			.values({ userId: pastBuyer.id, stripeSubscriptionId: subId })
			.onConflictDoUpdate({ target: billingAccounts.userId, set: { stripeSubscriptionId: subId } });
		fake.responses["subscriptions.retrieve"] = subscription({ id: subId, status: "past_due" });

		const res = await req("/api/payments/badges/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: pastBuyer.cookie },
			body: JSON.stringify({ badgeId: issuerRungId }),
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code?: string }).code).toBe("payment_past_due");
		expect(fake.callsTo("checkout.sessions.create")).toHaveLength(0);
		delete fake.responses["subscriptions.retrieve"];
	});

	it("🚨 refuses the buyer's own ladder", async () => {
		const res = await req("/api/payments/badges/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: issuerCookie },
			body: JSON.stringify({ badgeId: issuerRungId }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error?: string }).error).toMatch(/own Badge/i);
		expect(fake.callsTo("checkout.sessions.create")).toHaveLength(0);
	});

	it("🚨 refuses at-or-below the ratchet — what the buyer already holds is not purchasable", async () => {
		const ratchetBuyer = await signUp(`route_ratchet_${run}`);
		await db.insert(userBadges).values({
			userId: ratchetBuyer.id,
			badgeId: issuerRungId,
			billingCycle: cycleKeyFor(new Date()),
		});
		// A LOWER hypothetical rung would be refused the same way; the exact-rung case is
		// the sharpest (already-held = the same money re-charged for nothing).
		const res = await req("/api/payments/badges/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: ratchetBuyer.cookie },
			body: JSON.stringify({ badgeId: issuerRungId }),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error?: string }).error).toMatch(/already hold/i);
	});

	it("skips the connected-account precondition for Anthers as the issuer — its money is already platform-side", async () => {
		// (no stripe_accounts row for the Anthers account — the rung checkout works, because
		// the Anthers ladder's money never needs a transfer to be receivable)
		const anthersId = await anthersUserId();
		const [anthersRung] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.creatorId, anthersId), eq(badges.threshold, "3.00")))
			.limit(1);

		const res = await req("/api/payments/badges/checkout", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
			body: JSON.stringify({ badgeId: anthersRung.id }),
		});
		expect(res.status).toBe(200);
		const params = fake.lastCall("checkout.sessions.create")
			?.args[0] as Stripe.Checkout.SessionCreateParams;
		const metadata = params.payment_intent_data?.metadata as Record<string, string>;
		expect(metadata.badgeIds).toBe(String(anthersRung.id));
		const [row] = await db
			.select()
			.from(badgeCharges)
			.where(eq(badgeCharges.buyerId, buyerId2))
			.orderBy(desc(badgeCharges.id))
			.limit(1);
		expect(row.creatorId).toBe(anthersId);
	});
});
