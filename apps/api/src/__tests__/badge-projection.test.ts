// SPDX-License-Identifier: Apache-2.0
/**
 * A future cycle's Badge projection — what the next renewal will charge.
 *
 * The projection is not the current cycle's holdings with tomorrow's date on them: a Badge
 * that started mid-month is charged in full when it starts and carries a day-exact
 * reduction against the next renewal, and a decrease or removal moves the subscription's
 * line immediately while the holding stays put until the 1st. So these tests pin both
 * halves — the reduction is read from `billing_reductions`, and the standing amount is
 * read from the subscription's items rather than from `user_badges`.
 *
 * Nothing reaches Stripe: `setStripeClient` swaps in a fake whose `retrieve` returns the
 * subscription each test describes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badges, billingReductions, stripeCustomers, userBadges } from "@anthers/db/schema";
import { currentCycleKey, nextCycleKey } from "@anthers/shared/billing-cycle";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { projectedBadgeHoldings } from "../services/badge-projection";
import { createAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
const SUB_ID = "sub_projection_under_test";

/** A subscription carrying one line per destination, in the shape `itemsFromSub` reads. */
function subscription(lines: { destination: string; dollars: number }[]) {
	return {
		id: SUB_ID,
		object: "subscription",
		customer: "cus_projection",
		status: "active",
		cancel_at_period_end: false,
		metadata: {},
		items: {
			object: "list",
			data: lines.map((line) => ({
				id: `si_${line.destination}`,
				quantity: 1,
				price: { unit_amount: Math.round(line.dollars * 100) },
				metadata: { destination: line.destination },
			})),
		},
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built subset of Stripe's type
	} as any;
}

let current: Stripe.Subscription | null = null;
const fake = {
	subscriptions: { retrieve: async () => current },
} as unknown as Stripe;

let realClient: Stripe | null;
let supporter: { cookie: string; userId: number };
let creator: { userId: number; handle: string };

async function setSubscription(customerId = "cus_projection") {
	await db
		.insert(stripeCustomers)
		.values({
			userId: supporter.userId,
			stripeCustomerId: customerId,
			stripeSubscriptionId: SUB_ID,
		})
		.onConflictDoUpdate({
			target: stripeCustomers.userId,
			set: {
				stripeCustomerId: customerId,
				stripeSubscriptionId: SUB_ID,
				canceledAt: null,
			},
		});
}

async function makeBadge(creatorId: number, threshold: string, label = "Boba Tea-ier") {
	const [row] = await db
		.insert(badges)
		.values({ creatorId, threshold, label })
		.returning({ id: badges.id });
	return row.id;
}

beforeAll(async () => {
	realClient = getStripe();
	setStripeClient(fake);
	await ensureAnthersLadder();
	const supporterAccount = await createAccount(`projection_supporter_${run}`, {
		emailVerified: true,
	});
	const creatorAccount = await createAccount(`projection_creator_${run}`, { emailVerified: true });
	supporter = { cookie: supporterAccount.cookie, userId: supporterAccount.userId };
	creator = { userId: creatorAccount.userId, handle: creatorAccount.handle };
}, DB_SETUP_TIMEOUT);

afterAll(() => {
	setStripeClient(realClient);
});

beforeEach(async () => {
	current = null;
	await db.delete(billingReductions).where(eq(billingReductions.userId, supporter.userId));
	await db.delete(userBadges).where(eq(userBadges.userId, supporter.userId));
	await db.delete(badges).where(eq(badges.creatorId, creator.userId));
	await db.delete(stripeCustomers).where(eq(stripeCustomers.userId, supporter.userId));
});

describe("what next month holds", () => {
	it("charges a mid-month Badge its second-month, reduction-discounted amount", async () => {
		await makeBadge(creator.userId, "3.00");
		await setSubscription();
		current = subscription([{ destination: String(creator.userId), dollars: 3 }]);
		await db.insert(billingReductions).values({
			userId: supporter.userId,
			billingCycle: nextCycleKey(currentCycleKey()),
			destination: String(creator.userId),
			amount: "0.90",
		});

		const response = await app.fetch(
			new Request(
				`http://localhost/api/subscriptions/my-badges?cycle=${nextCycleKey(currentCycleKey())}`,
				{ headers: { Cookie: supporter.cookie } },
			),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			badges: { threshold: string; projectedCharge: string; creator: { handle: string } }[];
		};
		expect(body.badges).toHaveLength(1);
		expect(body.badges[0].creator.handle).toBe(creator.handle);
		expect(body.badges[0].threshold).toBe("3.00");
		expect(body.badges[0].projectedCharge).toBe("2.10");
	});

	it("🚨 reads the subscription's standing amount, not the holding the cycle paid for", async () => {
		// The supporter lowered from $5 to $3 mid-month: the item moved at once, the holding
		// stays at $5 until the 1st. A projection that read the holding would show a charge
		// the account has already dropped.
		const held = await makeBadge(creator.userId, "5.00", "Patron");
		await db.insert(userBadges).values({
			userId: supporter.userId,
			badgeId: held,
			billingCycle: currentCycleKey(),
		});
		await makeBadge(creator.userId, "3.00");
		await setSubscription();
		current = subscription([{ destination: String(creator.userId), dollars: 3 }]);

		const rows = await projectedBadgeHoldings(supporter.userId, nextCycleKey(currentCycleKey()));
		expect(rows).toHaveLength(1);
		expect(rows[0].threshold).toBe("3.00");
		expect(rows[0].projectedCharge).toBe("3.00");
	});

	it("holds nothing after a cancellation, because the whole subscription ends", async () => {
		await makeBadge(creator.userId, "3.00");
		await setSubscription();
		await db
			.update(stripeCustomers)
			.set({ canceledAt: new Date() })
			.where(eq(stripeCustomers.userId, supporter.userId));
		current = subscription([{ destination: String(creator.userId), dollars: 3 }]);

		expect(await projectedBadgeHoldings(supporter.userId, nextCycleKey(currentCycleKey()))).toEqual(
			[],
		);
	});

	it("projects no further out than the next cycle", async () => {
		await makeBadge(creator.userId, "3.00");
		await setSubscription();
		current = subscription([{ destination: String(creator.userId), dollars: 3 }]);

		const beyond = nextCycleKey(nextCycleKey(currentCycleKey()));
		expect(await projectedBadgeHoldings(supporter.userId, beyond)).toEqual([]);
	});

	it("keeps a line whose rung has gone rather than dropping the charge", async () => {
		// No badge row at the item's amount: the rung was removed, but the subscription line
		// still charges. The row must survive so the month's total is not short by money the
		// account will pay.
		await setSubscription();
		current = subscription([{ destination: String(creator.userId), dollars: 4 }]);

		const rows = await projectedBadgeHoldings(supporter.userId, nextCycleKey(currentCycleKey()));
		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe("$4.00");
		expect(rows[0].projectedCharge).toBe("4.00");
	});
});

describe("a database with no subscription to read", () => {
	it("falls back to this cycle's holdings at their list price", async () => {
		const id = await makeBadge(creator.userId, "3.00");
		await db.insert(userBadges).values({
			userId: supporter.userId,
			badgeId: id,
			billingCycle: currentCycleKey(),
		});
		// No stripeCustomers row at all: payments were never configured for this account.
		const rows = await projectedBadgeHoldings(supporter.userId, nextCycleKey(currentCycleKey()));
		expect(rows.map((row) => [row.threshold, row.projectedCharge])).toEqual([["3.00", "3.00"]]);
	});
});
