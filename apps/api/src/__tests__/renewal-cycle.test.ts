// SPDX-License-Identifier: Apache-2.0
/**
 * Every account renews on the 1st — the parameters that put it there, and the discount that
 * pays back the days before somebody started.
 *
 * 🚨 **The assertions are about what is SENT TO STRIPE, not about what we say afterward.**
 * Stripe decides what a charge comes to, so the only thing this code controls is the request,
 * and a test that checked the response body would pass against a fake that agreed with
 * whatever it was handed. `backdate_start_date`, `proration_behavior` and `proration_date` are
 * the whole of the mechanism.
 *
 * Nothing here reaches the network: `setStripeClient` swaps in a recording fake, which is why
 * `lib/stripe.ts` exposes a setter at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { accounts, invoices, seedAllocations, supportReductions, users } from "@anthers/db/schema";
import { currentCycleKey, cycleKeyFor, nextCycleKey } from "@anthers/shared/billing-cycle";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { planItemChange, syncSubscriptionToAccount } from "../services/billing";
import { applyReductionsToInvoice } from "../services/support-reductions";
import { createAccount } from "./account-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const ORIGIN = "http://localhost:3000";
const json = { "Content-Type": "application/json", Origin: ORIGIN };
const run = crypto.randomUUID().slice(0, 8);

function req(path: string, options?: RequestInit) {
	return app.fetch(new Request(`http://localhost${path}`, options));
}

// ── A recording fake, covering only what this file touches ───────────────────

interface Call {
	method: string;
	args: unknown[];
}

function fakeStripe() {
	const calls: Call[] = [];
	const responses: Record<string, unknown> = {};
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
		products: {
			list: () => ({
				// `ensureAnthersProduct` iterates this, so it has to be async-iterable.
				async *[Symbol.asyncIterator]() {
					yield { id: "prod_platform", metadata: { anthers: "platform" } };
				},
			}),
			create: record("products.create", () => ({ id: `prod_${uid()}` })),
		},
		customers: { create: record("customers.create", () => ({ id: `cus_${uid()}` })) },
		paymentMethods: { list: record("paymentMethods.list", () => ({ data: [] })) },
		subscriptions: {
			create: record("subscriptions.create", () => ({
				id: `sub_${uid()}`,
				latest_invoice: { confirmation_secret: { client_secret: "pi_test_secret" } },
			})),
			retrieve: record("subscriptions.retrieve", () => subscription({ anthers: 3 })),
			update: record("subscriptions.update", () => subscription({ anthers: 3 })),
		},
		coupons: { create: record("coupons.create", () => ({ id: `coup_${uid()}` })) },
		invoices: { updateLines: record("invoices.updateLines", () => ({})) },
	} as unknown as Stripe;

	return {
		client,
		responses,
		callsTo: (method: string) => calls.filter((c) => c.method === method),
		lastCall: (method: string) => calls.filter((c) => c.method === method).at(-1),
		reset: () => {
			calls.length = 0;
		},
	};
}

type Fake = ReturnType<typeof fakeStripe>;

function uid() {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

const SUB_ID = "sub_under_test";

/** A subscription in the shape `itemsFromSub` and the period readers expect. */
function subscription(opts: {
	anthers?: number;
	directed?: Record<number, number>;
	periodStart?: number;
	periodEnd?: number;
	status?: string;
	customer?: string;
}) {
	const periodStart = opts.periodStart ?? Math.floor(Date.UTC(2026, 8, 1) / 1000);
	const periodEnd = opts.periodEnd ?? Math.floor(Date.UTC(2026, 9, 1) / 1000);
	const item = (dollars: number, destination: string) => ({
		id: `si_${destination}`,
		quantity: 1,
		price: { unit_amount: Math.round(dollars * 100) },
		current_period_start: periodStart,
		current_period_end: periodEnd,
		metadata: { destination },
	});
	const data = [
		...(opts.anthers != null ? [item(opts.anthers, "anthers")] : []),
		...Object.entries(opts.directed ?? {}).map(([id, amt]) => item(amt, id)),
	];
	return {
		id: SUB_ID,
		object: "subscription",
		customer: opts.customer ?? "cus_under_test",
		status: opts.status ?? "active",
		cancel_at_period_end: false,
		metadata: {},
		items: { object: "list", data },
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built subset of Stripe's type
	} as any;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const supporterName = `renew_sub_${run}`;
const creatorName = `renew_creator_${run}`;

let fake: Fake;
let realClient: Stripe | null;
let supporterCookie: string;
let supporterId: number;
let creatorId: number;

async function signUp(username: string): Promise<{ cookie: string; id: number }> {
	const account = await createAccount(username);
	const [row] = await db
		.update(users)
		.set({ emailVerified: true })
		.where(eq(users.email, `${username}@example.com`))
		.returning({ id: users.id });
	return { cookie: account.cookie, id: row.id };
}

beforeAll(async () => {
	realClient = getStripe();
	fake = fakeStripe();
	setStripeClient(fake.client);
	({ cookie: supporterCookie, id: supporterId } = await signUp(supporterName));
	({ id: creatorId } = await signUp(creatorName));
}, DB_SETUP_TIMEOUT);

afterAll(() => {
	setStripeClient(realClient);
});

beforeEach(async () => {
	fake.reset();
	await db.delete(supportReductions).where(eq(supportReductions.userId, supporterId));
});

/** Point the account at a subscription so `POST /account` takes the change path. */
async function withSubscription(customerId = "cus_under_test") {
	await db
		.insert(accounts)
		.values({ userId: supporterId, stripeCustomerId: customerId, stripeSubscriptionId: SUB_ID })
		.onConflictDoUpdate({
			target: accounts.userId,
			set: { stripeCustomerId: customerId, stripeSubscriptionId: SUB_ID },
		});
}

async function clearSubscription() {
	await db
		.update(accounts)
		.set({ stripeSubscriptionId: "", currentPeriodStart: null })
		.where(eq(accounts.userId, supporterId));
}

function setSupport(body: object) {
	return req("/api/subscriptions/account", {
		method: "POST",
		headers: { ...json, Cookie: supporterCookie },
		body: JSON.stringify(body),
	});
}

// ── The anchor ───────────────────────────────────────────────────────────────

describe("a new subscription is anchored to the 1st", () => {
	it("backdates the start to the 1st of this month, so the whole month is charged today", async () => {
		await clearSubscription();
		const res = await setSupport({ anthersSupport: 6 });
		expect(res.status).toBe(200);

		const params = fake.lastCall("subscriptions.create")?.args[0] as
			| Stripe.SubscriptionCreateParams
			| undefined;
		expect(params?.backdate_start_date).toBeDefined();

		// The 1st of the current month, at midnight UTC — the instant, not merely the day,
		// because Stripe takes a unix timestamp and a local midnight is a different one.
		const expected = Math.floor(new Date(`${currentCycleKey()}T00:00:00.000Z`).getTime() / 1000);
		expect(params?.backdate_start_date).toBe(expected);
	});

	/**
	 * ⚠️ **The reach that looks right and is wrong in both flavors.** A
	 * `billing_cycle_anchor` at the *next* 1st either prorates — charging a sliver, which is
	 * the gate-for-a-day hole the decision closes — or does not, charging nothing at all
	 * until next month. Neither is "charged in full today", so neither may appear here.
	 */
	it("does not set a forward billing_cycle_anchor", async () => {
		await clearSubscription();
		await setSupport({ anthersSupport: 6 });
		const params = fake.lastCall("subscriptions.create")?.args[0] as
			| Stripe.SubscriptionCreateParams
			| undefined;
		expect(params?.billing_cycle_anchor).toBeUndefined();
	});

	it("records what every line owes back, against NEXT month", async () => {
		await clearSubscription();
		await setSupport({ anthersSupport: 6, directed: [{ creatorId, amount: 4 }] });

		const rows = await db
			.select()
			.from(supportReductions)
			.where(eq(supportReductions.userId, supporterId));

		const cycle = nextCycleKey(currentCycleKey());
		const today = new Date().getUTCDate();
		if (today === 1) {
			// Nothing is owed to somebody who started on the 1st, which is the whole point.
			expect(rows).toHaveLength(0);
			return;
		}
		expect(rows.map((r) => r.destination).sort()).toEqual(["anthers", String(creatorId)].sort());
		for (const row of rows) {
			expect(row.billingCycle).toBe(cycle);
			expect(row.appliedAt).toBeNull();
			expect(Number(row.amount)).toBeGreaterThan(0);
		}
	});
});

describe("what a new subscriber is quoted", () => {
	/**
	 * 🚨 **The confirmation modal's next-charge date is a sentence somebody agrees to**, so a
	 * wrong one is worse than a cosmetic defect. This quoted "a month from today" — which the
	 * 1st-of-the-month anchor made simply untrue — and did it with `setMonth(getMonth() + 1)`,
	 * the overflowing form that turns a quote given on 31 January into 3 March.
	 */
	it("names the 1st of next month, not a month from today", async () => {
		await clearSubscription();
		const res = await req("/api/subscriptions/preview/6", {
			method: "GET",
			headers: { Cookie: supporterCookie, Origin: ORIGIN },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { isChange: boolean; nextBillingUnix: number };
		expect(body.isChange).toBe(false);

		const quoted = new Date(body.nextBillingUnix * 1000);
		expect(quoted.getUTCDate()).toBe(1);
		expect(cycleKeyFor(quoted)).toBe(nextCycleKey(currentCycleKey()));
	});
});

// ── The two directions of a change ───────────────────────────────────────────

describe("a change splits by direction, per destination", () => {
	beforeEach(async () => {
		await withSubscription();
		fake.responses["subscriptions.retrieve"] = subscription({
			anthers: 6,
			directed: { [creatorId]: 4 },
		});
	});

	afterAll(() => {
		delete fake.responses["subscriptions.retrieve"];
	});

	it("charges a raise in full today, prorated from the start of the period", async () => {
		const res = await setSupport({ anthersSupport: 12, directed: [{ creatorId, amount: 4 }] });
		expect(res.status).toBe(200);

		const updates = fake.callsTo("subscriptions.update");
		const raise = updates.find(
			(c) => (c.args[1] as Stripe.SubscriptionUpdateParams).proration_behavior === "always_invoice",
		);
		expect(raise).toBeDefined();
		const params = raise?.args[1] as Stripe.SubscriptionUpdateParams;
		// Prorating from the period start is what makes "the rest of the month" the whole of
		// it. Without this the raise is charged for the remaining days only.
		expect(params.proration_date).toBe(Math.floor(Date.UTC(2026, 8, 1) / 1000));
		// Only the line that moved is sent. Sending the untouched creator line would prorate
		// a charge that has not changed.
		expect(params.items).toHaveLength(1);
		expect(params.items?.[0].metadata).toEqual({ destination: "anthers" });
	});

	it("lets a decrease wait for the 1st, with no proration and no credit", async () => {
		const res = await setSupport({ anthersSupport: 3, directed: [{ creatorId, amount: 4 }] });
		expect(res.status).toBe(200);

		const updates = fake.callsTo("subscriptions.update");
		const drop = updates.find(
			(c) => (c.args[1] as Stripe.SubscriptionUpdateParams).proration_behavior === "none",
		);
		expect(drop).toBeDefined();
		// 🚨 Nothing is invoiced. `always_invoice` here would credit the unused days back
		// immediately, which is the everyday case of money coming back after a creator was
		// already credited for it.
		expect(
			updates.some(
				(c) =>
					(c.args[1] as Stripe.SubscriptionUpdateParams).proration_behavior === "always_invoice",
			),
		).toBe(false);
	});

	it("does both at once when a request raises one line and drops another", async () => {
		const res = await setSupport({ anthersSupport: 12, directed: [] });
		expect(res.status).toBe(200);

		const behaviors = fake
			.callsTo("subscriptions.update")
			.map((c) => (c.args[1] as Stripe.SubscriptionUpdateParams).proration_behavior);
		expect(behaviors).toContain("always_invoice");
		expect(behaviors).toContain("none");
	});

	it("owes back only the INCREASE on a raise, never the new amount", async () => {
		await setSupport({ anthersSupport: 12, directed: [{ creatorId, amount: 4 }] });
		const [row] = await db
			.select()
			.from(supportReductions)
			.where(
				and(
					eq(supportReductions.userId, supporterId),
					eq(supportReductions.destination, "anthers"),
				),
			);

		if (new Date().getUTCDate() === 1) {
			expect(row).toBeUndefined();
			return;
		}
		// $6 → $12 is a $6 raise, so the days before today are owed against $6. Against $12
		// it would be twice that, handing back days on a line that ran all month.
		const daysGone = new Date().getUTCDate() - 1;
		const days = new Date(
			Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0),
		).getUTCDate();
		expect(Number(row.amount)).toBeCloseTo((6 * daysGone) / days, 2);
	});

	it("owes nothing back on a decrease", async () => {
		await setSupport({ anthersSupport: 3, directed: [{ creatorId, amount: 4 }] });
		const rows = await db
			.select()
			.from(supportReductions)
			.where(eq(supportReductions.userId, supporterId));
		expect(rows).toHaveLength(0);
	});
});

// ── The plan itself, without a route around it ───────────────────────────────

describe("planItemChange", () => {
	const anthersProduct = "prod_platform";

	it("deletes a destination that is no longer wanted", () => {
		const sub = subscription({ anthers: 3, directed: { 42: 5 } });
		const plan = planItemChange(sub, anthersProduct, 3, []);
		// ⚠️ Stripe does not remove an item you simply omit — the creator would keep being
		// charged for, silently, and visibly only on the supporter's next invoice.
		expect(plan.drops).toEqual([{ id: "si_42", deleted: true }]);
		expect(plan.raises).toHaveLength(0);
	});

	it("leaves an unchanged line alone entirely", () => {
		const sub = subscription({ anthers: 3, directed: { 42: 5 } });
		const plan = planItemChange(sub, anthersProduct, 3, [
			{ creatorId: 42, product: "prod_42", amount: 5 },
		]);
		expect(plan.raises).toHaveLength(0);
		expect(plan.drops).toHaveLength(0);
		expect(plan.started).toHaveLength(0);
	});

	it("treats a brand-new destination as owed its whole amount", () => {
		const sub = subscription({ anthers: 3 });
		const plan = planItemChange(sub, anthersProduct, 3, [
			{ creatorId: 42, product: "prod_42", amount: 5 },
		]);
		expect(plan.started).toEqual([{ creatorId: 42, amount: 5 }]);
		expect(plan.raises).toHaveLength(1);
		// No `id` — it is a new line rather than a change to one.
		expect(plan.raises[0]).not.toHaveProperty("id");
	});

	it("stamps every item it builds with its destination", () => {
		const sub = subscription({ anthers: 3 });
		const plan = planItemChange(sub, anthersProduct, 9, [
			{ creatorId: 42, product: "prod_42", amount: 5 },
		]);
		// 🚨 An unstamped item is credited to Anthers by `itemsFromSub`, so a creator's
		// support would silently fund the Time Pool instead of reaching them.
		for (const item of [...plan.raises, ...plan.drops]) {
			if ("deleted" in item) continue;
			const metadata = item.metadata as Record<string, string> | undefined;
			expect(metadata?.destination).toBeTruthy();
		}
	});
});

// ── The Anthers Badge minimum ────────────────────────────────────────────────

describe("the Anthers line is $0 or at least $3", () => {
	beforeEach(clearSubscription);

	it("refuses an amount that buys nothing", async () => {
		for (const amount of [1, 2, 2.99]) {
			const res = await setSupport({
				anthersSupport: amount,
				directed: [{ creatorId, amount: 5 }],
			});
			expect(res.status, `$${amount} to Anthers`).toBe(400);
		}
	});

	it("accepts $3 itself, which is what unlimited Public Access costs", async () => {
		const res = await setSupport({ anthersSupport: 3 });
		expect(res.status).toBe(200);
	});

	it("accepts $0, because giving Anthers nothing is a real position", async () => {
		// Directed-only: the whole charge goes to a creator and Anthers takes no line at all.
		const res = await setSupport({ anthersSupport: 0, directed: [{ creatorId, amount: 5 }] });
		expect(res.status).toBe(200);
	});

	it("still lets a CREATOR line sit below $3", async () => {
		// ⚠️ The floor bounds the Anthers destination only. A creator sets their own Badge
		// levels to any chargeable amount, and a shared minimum would put every creator's
		// ladder back on a $3 step.
		const res = await setSupport({ anthersSupport: 3, directed: [{ creatorId, amount: 1 }] });
		expect(res.status).toBe(200);
	});
});

// ── An amount in force never falls mid-cycle ─────────────────────────────────

describe("what is in force does not drop until the cycle turns", () => {
	const SEPT = Math.floor(Date.UTC(2026, 8, 1) / 1000);
	const OCT = Math.floor(Date.UTC(2026, 9, 1) / 1000);

	beforeEach(async () => {
		await db
			.update(accounts)
			.set({
				stripeCustomerId: "cus_under_test",
				anthersSupport: "12.00",
				creatorSupportTotal: "5.00",
				currentPeriodStart: new Date(SEPT * 1000),
			})
			.where(eq(accounts.userId, supporterId));
	});

	it("keeps the Badge somebody already paid for when they lower it mid-month", async () => {
		// The Stripe items say $3 the instant the decrease is applied, and the charge for
		// September was $12. Reading the items straight through takes away a Blossom Badge
		// eight days into a month it was bought for, with nothing refunded.
		await syncSubscriptionToAccount(
			subscription({ anthers: 3, periodStart: SEPT, periodEnd: OCT }),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporterId));
		expect(Number(acct.anthersSupport)).toBe(12);
	});

	it("takes the lower amount once the period has moved on", async () => {
		await syncSubscriptionToAccount(
			subscription({
				anthers: 3,
				periodStart: OCT,
				periodEnd: Math.floor(Date.UTC(2026, 10, 1) / 1000),
			}),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporterId));
		expect(Number(acct.anthersSupport)).toBe(3);
	});

	it("applies a raise immediately, because a raise is charged in full today", async () => {
		await syncSubscriptionToAccount(
			subscription({ anthers: 24, periodStart: SEPT, periodEnd: OCT }),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporterId));
		expect(Number(acct.anthersSupport)).toBe(24);
	});

	it("writes the period START, which nothing wrote before", async () => {
		// 🚨 The frozen key every settlement defect sits downstream of: the column held
		// whatever `ensureAccount` stamped and never moved, so every job keyed one month
		// forever.
		await syncSubscriptionToAccount(
			subscription({
				anthers: 12,
				periodStart: OCT,
				periodEnd: Math.floor(Date.UTC(2026, 10, 1) / 1000),
			}),
		);
		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporterId));
		expect(cycleKeyFor(acct.currentPeriodStart as Date)).toBe("2026-10-01");
	});
});

// ── A renewal that fails ─────────────────────────────────────────────────────

describe("a renewal that fails", () => {
	const monthStart = Math.floor(new Date(`${currentCycleKey()}T00:00:00.000Z`).getTime() / 1000);
	const monthEnd = Math.floor(
		new Date(`${nextCycleKey(currentCycleKey())}T00:00:00.000Z`).getTime() / 1000,
	);
	const thisMonth = (status: string) =>
		subscription({
			anthers: 12,
			directed: { [creatorId]: 5 },
			status,
			periodStart: monthStart,
			periodEnd: monthEnd,
		});

	beforeEach(async () => {
		await withSubscription();
		await db
			.update(accounts)
			.set({
				anthersSupport: "12.00",
				creatorSupportTotal: "5.00",
				currentPeriodStart: new Date(monthStart * 1000),
				isActive: true,
			})
			.where(eq(accounts.userId, supporterId));
		await db
			.insert(seedAllocations)
			.values({ userId: supporterId, creatorId, amount: "5.00", billingCycle: currentCycleKey() })
			.onConflictDoNothing();
		await db.delete(invoices).where(eq(invoices.userId, supporterId));
	});

	afterAll(() => {
		delete fake.responses["subscriptions.retrieve"];
	});

	const gatesThisMonth = () =>
		db
			.select()
			.from(seedAllocations)
			.where(
				and(
					eq(seedAllocations.userId, supporterId),
					eq(seedAllocations.billingCycle, currentCycleKey()),
				),
			);

	it("🚨 refuses a change while the last payment failed, rather than opening a second subscription", async () => {
		fake.responses["subscriptions.retrieve"] = thisMonth("past_due");

		const res = await setSupport({ anthersSupport: 24 });

		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("payment_past_due");
		expect(fake.callsTo("subscriptions.create")).toHaveLength(0);
		expect(fake.callsTo("subscriptions.update")).toHaveLength(0);
	});

	it("keeps the Badge and this month's gates through Stripe's retries", async () => {
		await syncSubscriptionToAccount(thisMonth("past_due"));

		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporterId));
		expect(Number(acct.anthersSupport)).toBe(12);
		expect(await gatesThisMonth()).toHaveLength(1);
	});

	it("🚨 takes the Badge and this month's gates away once Stripe marks it unpaid", async () => {
		await syncSubscriptionToAccount(thisMonth("unpaid"));

		const [acct] = await db.select().from(accounts).where(eq(accounts.userId, supporterId));
		expect(Number(acct.anthersSupport)).toBe(0);
		expect(Number(acct.creatorSupportTotal)).toBe(0);
		expect(await gatesThisMonth()).toHaveLength(0);
		// Kept, so that paying what is owed makes the same subscription active again.
		expect(acct.stripeSubscriptionId).toBe(SUB_ID);
	});

	it("keeps the gates of a month that was paid for when the subscription is canceled", async () => {
		await db.insert(invoices).values({
			userId: supporterId,
			stripeInvoiceId: `in_EXAMPLE_${uid()}`,
			billingCycle: currentCycleKey(),
			subtotal: "17.00",
			total: "17.00",
		});

		await syncSubscriptionToAccount(thisMonth("canceled"));

		expect(await gatesThisMonth()).toHaveLength(1);
	});
});

// ── Spending the reduction against the renewal ───────────────────────────────

/**
 * A draft renewal invoice with one line per destination, dated the way Stripe dates one.
 *
 * 🚨 **The invoice's own `period_start` is the month BEFORE the renewal**, and only its lines'
 * `period` names the month it pays for. A fixture that put the renewal's month on `period_start`
 * would pass a reader of that field, which looks for reductions against the wrong month on every
 * real renewal.
 */
function draftInvoice(opts: {
	lines: { destination: string; dollars: number }[];
	status?: string;
	billingReason?: string;
	/** The month the renewal pays for, which only its lines say. */
	paysFor?: number;
}) {
	const paysFor = opts.paysFor ?? Math.floor(Date.UTC(2026, 9, 1) / 1000);
	const d = new Date(paysFor * 1000);
	return {
		id: "in_under_test",
		object: "invoice",
		status: opts.status ?? "draft",
		billing_reason: opts.billingReason ?? "subscription_cycle",
		customer: "cus_under_test",
		period_start: Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1) / 1000),
		period_end: paysFor,
		parent: { subscription_details: { subscription: SUB_ID } },
		lines: {
			has_more: false,
			data: opts.lines.map((l) => ({
				id: `il_${l.destination}`,
				amount: Math.round(l.dollars * 100),
				period: { start: paysFor, end: paysFor + 31 * 86400 },
				parent: {
					type: "subscription_item_details",
					subscription_item_details: { subscription_item: `si_${l.destination}`, proration: false },
				},
			})),
		},
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built subset of Stripe's type
	} as any;
}

async function owe(destination: string, amount: string, cycle = "2026-10-01") {
	await db.insert(supportReductions).values({
		userId: supporterId,
		billingCycle: cycle,
		destination,
		amount,
	});
}

describe("the reduction is spent on the draft renewal", () => {
	beforeEach(async () => {
		await withSubscription();
		fake.responses["subscriptions.retrieve"] = subscription({
			anthers: 6,
			directed: { [creatorId]: 4 },
		});
	});

	afterAll(() => {
		delete fake.responses["subscriptions.retrieve"];
	});

	it("puts a one-off coupon on each line, for that destination's own reduction", async () => {
		await owe("anthers", "3.80");
		await owe(String(creatorId), "2.53");

		const applied = await applyReductionsToInvoice(
			draftInvoice({
				lines: [
					{ destination: "anthers", dollars: 6 },
					{ destination: String(creatorId), dollars: 4 },
				],
			}),
		);
		expect(applied).toBe(2);

		// The amounts, in cents, as sent to Stripe.
		const coupons = fake
			.callsTo("coupons.create")
			.map((c) => (c.args[0] as Stripe.CouponCreateParams).amount_off);
		expect(coupons.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([253, 380]);

		// Each coupon dies with the invoice it was made for — one left loose in the account
		// is a discount anybody's next invoice can pick up.
		for (const call of fake.callsTo("coupons.create")) {
			const params = call.args[0] as Stripe.CouponCreateParams;
			expect(params.duration).toBe("once");
			expect(params.max_redemptions).toBe(1);
		}
	});

	it("marks every row applied, and names the invoice it went to", async () => {
		await owe("anthers", "3.80");
		await applyReductionsToInvoice(
			draftInvoice({ lines: [{ destination: "anthers", dollars: 6 }] }),
		);

		const [row] = await db
			.select()
			.from(supportReductions)
			.where(eq(supportReductions.userId, supporterId));
		expect(row.appliedAt).not.toBeNull();
		expect(row.appliedInvoiceId).toBe("in_under_test");
	});

	/**
	 * 🚨 The floor, and the carry that makes it safe. A start late in the month can owe back
	 * nearly the whole of the next charge, and an invoice discounted to nothing is one no
	 * processor will take — so the discount stops at $1 and the rest is written forward
	 * rather than dropped.
	 */
	it("never discounts an invoice below the minimum, and carries what is left", async () => {
		// Owing the whole invoice is the case that forces the floor to bite — somebody who
		// started on the last day of a month is close to this.
		await owe("anthers", "6.00");
		await applyReductionsToInvoice(
			draftInvoice({ lines: [{ destination: "anthers", dollars: 6 }] }),
		);

		// $6 invoice against Stripe's $0.50 floor → $5.50 spendable, so $0.50 carries.
		const coupon = fake.lastCall("coupons.create")?.args[0] as Stripe.CouponCreateParams;
		expect(coupon.amount_off).toBe(550);

		const carried = await db
			.select()
			.from(supportReductions)
			.where(
				and(
					eq(supportReductions.userId, supporterId),
					eq(supportReductions.billingCycle, "2026-11-01"),
				),
			);
		expect(carried).toHaveLength(1);
		expect(Number(carried[0].amount)).toBeCloseTo(0.5, 2);
		expect(carried[0].carriedFromId).not.toBeNull();
	});

	/**
	 * ⭐ A supporter is owed the money whatever happened to the line that earned it. Somebody
	 * who stopped supporting a creator would otherwise hold a reduction keyed to a
	 * destination that no longer appears on any invoice — owed forever, paid never.
	 */
	it("spends a reduction whose own line is gone against whatever lines remain", async () => {
		await owe(String(creatorId), "2.00");
		const applied = await applyReductionsToInvoice(
			draftInvoice({ lines: [{ destination: "anthers", dollars: 6 }] }),
		);
		expect(applied).toBe(1);
		const coupon = fake.lastCall("coupons.create")?.args[0] as Stripe.CouponCreateParams;
		expect(coupon.amount_off).toBe(200);
	});

	/**
	 * 🚨 Stripe retries a webhook, and a second delivery must not mint a second coupon. The
	 * idempotency is structural — every row is settled on the first pass, and the carry rows
	 * it creates are keyed to the NEXT cycle — which is easy to lose in a refactor and
	 * impossible to notice without this assertion.
	 */
	it("is a no-op when the same invoice is delivered again", async () => {
		await owe("anthers", "3.80");
		const invoice = draftInvoice({ lines: [{ destination: "anthers", dollars: 6 }] });

		expect(await applyReductionsToInvoice(invoice)).toBe(1);
		expect(await applyReductionsToInvoice(invoice)).toBe(0);
		expect(fake.callsTo("coupons.create")).toHaveLength(1);
	});

	it("leaves an invoice that is no longer a draft alone", async () => {
		await owe("anthers", "3.80");
		const applied = await applyReductionsToInvoice(
			draftInvoice({ lines: [{ destination: "anthers", dollars: 6 }], status: "open" }),
		);
		expect(applied).toBe(0);
		expect(fake.callsTo("invoices.updateLines")).toHaveLength(0);
	});

	/**
	 * ⚠️ **The invoice for a mid-month raise is the charge the reduction compensates for.**
	 * Discounting it here would pay the money back before it was taken, and leave the
	 * renewal it was meant for at full price.
	 */
	it("leaves a mid-month change's own invoice alone", async () => {
		await owe("anthers", "3.80");
		const applied = await applyReductionsToInvoice(
			draftInvoice({
				lines: [{ destination: "anthers", dollars: 6 }],
				billingReason: "subscription_update",
			}),
		);
		expect(applied).toBe(0);
	});

	it("does nothing when the account is owed nothing, which is nearly every invoice", async () => {
		const applied = await applyReductionsToInvoice(
			draftInvoice({ lines: [{ destination: "anthers", dollars: 6 }] }),
		);
		expect(applied).toBe(0);
		expect(fake.callsTo("coupons.create")).toHaveLength(0);
	});

	it("🚨 reads the cycle off the month the lines pay for, not off the invoice's own period or today", async () => {
		// A renewal is drafted before its period opens, so today is still the previous month,
		// and Stripe dates the invoice's own period to the previous month as well. Either would
		// look for reductions against a month nothing was recorded against.
		await owe("anthers", "1.25", cycleKeyFor(new Date(Date.UTC(2026, 9, 1))));
		const invoice = draftInvoice({
			lines: [{ destination: "anthers", dollars: 6 }],
			paysFor: Math.floor(Date.UTC(2026, 9, 1) / 1000),
		});
		expect(new Date(invoice.period_start * 1000).getUTCMonth()).toBe(8);
		expect(await applyReductionsToInvoice(invoice)).toBe(1);
	});
});

describe("a raise never falls back to prorating from today", () => {
	/**
	 * 🚨 Stripe reads a missing `proration_date` as *now*, so a subscription whose items
	 * carry no period would have its raise prorated across the days remaining and charged as
	 * a sliver — which is the gate-for-a-day hole arriving silently rather than by design. A
	 * missing period has to fail toward charging in full.
	 */
	it("prorates from the 1st when the subscription carries no period at all", async () => {
		await withSubscription();
		const periodless = subscription({ anthers: 3 });
		for (const item of periodless.items.data) {
			item.current_period_start = undefined;
			item.current_period_end = undefined;
		}
		fake.responses["subscriptions.retrieve"] = periodless;

		await setSupport({ anthersSupport: 9 });

		const raise = fake
			.callsTo("subscriptions.update")
			.find(
				(c) =>
					(c.args[1] as Stripe.SubscriptionUpdateParams).proration_behavior === "always_invoice",
			);
		const params = raise?.args[1] as Stripe.SubscriptionUpdateParams;
		expect(params.proration_date).toBe(
			Math.floor(new Date(`${currentCycleKey()}T00:00:00.000Z`).getTime() / 1000),
		);
		delete fake.responses["subscriptions.retrieve"];
	});
});
