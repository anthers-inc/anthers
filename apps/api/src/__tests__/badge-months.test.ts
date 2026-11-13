// SPDX-License-Identifier: Apache-2.0
/**
 * The Badges tab's rolling five-month charge row.
 *
 * Three sources make one record, and each has a way to be wrong that the others cannot see:
 * an invoice line is money already collected but loses a mid-month purchase on the checkout
 * rail; a Badge charge is that purchase but knows nothing about the renewal; and the standing
 * subscription is the only source for a month that has not arrived. These tests pin all
 * three in one window, the prorate reduction that makes the second month cheaper, and the
 * current month's fallback when nothing has been recorded yet.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import {
	badgeCharges,
	badges,
	billingReductions,
	invoiceLines,
	invoices,
	stripeCustomers,
	userBadges,
} from "@anthers/db/schema";
import { currentCycleKey, nextCycleKey, previousCycleKey } from "@anthers/shared/billing-cycle";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import app from "../index";
import { getStripe, setStripeClient } from "../lib/stripe";
import { badgeChargeMonths } from "../services/badge-months";
import { createAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const run = crypto.randomUUID().slice(0, 8);
const SUB_ID = "sub_badge_months_under_test";

let realClient: Stripe | null;
let supporter: { cookie: string; userId: number };
let creator: { userId: number; handle: string };
let anthersId: number;
let current: Stripe.Subscription | null = null;

const fake = {
	subscriptions: { retrieve: async () => current },
} as unknown as Stripe;

function subscription(lines: { destination: string; dollars: number }[]) {
	return {
		id: SUB_ID,
		object: "subscription",
		customer: "cus_badge_months",
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

async function setSubscription(customerId = "cus_badge_months") {
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

async function paidInvoice(
	cycle: string,
	lines: { creatorId: number | null; amount: string }[],
): Promise<void> {
	const subtotal = lines.reduce((sum, line) => sum + Number(line.amount), 0).toFixed(2);
	const [row] = await db
		.insert(invoices)
		.values({
			userId: supporter.userId,
			stripeInvoiceId: `in_${crypto.randomUUID()}`,
			billingCycle: cycle,
			status: "paid",
			subtotal,
			discount: "0.00",
			tax: "0.00",
			total: subtotal,
			processingFee: "0.00",
		})
		.returning({ id: invoices.id });
	await db
		.insert(invoiceLines)
		.values(
			lines.map((line) => ({ invoiceId: row.id, creatorId: line.creatorId, amount: line.amount })),
		);
}

async function completedBadgeCharge(
	cycle: string,
	creatorId: number,
	badgeId: number,
	amount: string,
): Promise<void> {
	await db.insert(badgeCharges).values({
		buyerId: supporter.userId,
		badgeId,
		creatorId,
		badgeLabel: "Boba Tea-ier",
		threshold: "3.00",
		chargedAmount: amount,
		processingFee: "0.00",
		billingCycle: cycle,
		stripePaymentIntentId: `pi_${crypto.randomUUID()}`,
		status: "completed",
	});
}

beforeAll(async () => {
	realClient = getStripe();
	setStripeClient(fake);
	anthersId = await ensureAnthersLadder();
	const supporterAccount = await createAccount(`badge_months_supporter_${run}`, {
		emailVerified: true,
	});
	const creatorAccount = await createAccount(`badge_months_creator_${run}`, {
		emailVerified: true,
	});
	supporter = { cookie: supporterAccount.cookie, userId: supporterAccount.userId };
	creator = { userId: creatorAccount.userId, handle: creatorAccount.handle };
}, DB_SETUP_TIMEOUT);

afterAll(() => {
	setStripeClient(realClient);
});

beforeEach(async () => {
	current = null;
	await db.delete(badgeCharges).where(eq(badgeCharges.buyerId, supporter.userId));
	await db.delete(invoices).where(eq(invoices.userId, supporter.userId));
	await db.delete(billingReductions).where(eq(billingReductions.userId, supporter.userId));
	await db.delete(userBadges).where(eq(userBadges.userId, supporter.userId));
	await db.delete(badges).where(eq(badges.creatorId, creator.userId));
	await db.delete(stripeCustomers).where(eq(stripeCustomers.userId, supporter.userId));
});

const cycleAt = (offset: number) => {
	let cycle = currentCycleKey();
	if (offset < 0) {
		for (let i = 0; i < -offset; i++) cycle = previousCycleKey(cycle);
	}
	if (offset > 0) {
		for (let i = 0; i < offset; i++) cycle = nextCycleKey(cycle);
	}
	return cycle;
};

describe("the rolling five-month record", () => {
	it("reads a past month from its paid invoice lines, the Anthers line included", async () => {
		const past = cycleAt(-1);
		await paidInvoice(past, [
			{ creatorId: null, amount: "3.00" },
			{ creatorId: creator.userId, amount: "2.00" },
		]);

		const months = await badgeChargeMonths(supporter.userId);
		const month = months.find((row) => row.cycle === past);
		expect(month?.state).toBe("paid");
		expect(month?.total).toBe("5.00");
		expect(month?.badges.map((row) => [row.isAnthers, row.amount])).toEqual([
			[true, "3.00"],
			[false, "2.00"],
		]);
	});

	it("adds a mid-month Badge charge to the current month's invoice line", async () => {
		const currentCycle = cycleAt(0);
		const badgeId = await makeBadge(creator.userId, "3.00");
		await paidInvoice(currentCycle, [{ creatorId: null, amount: "3.00" }]);
		await completedBadgeCharge(currentCycle, creator.userId, badgeId, "3.00");

		const months = await badgeChargeMonths(supporter.userId);
		const month = months.find((row) => row.cycle === currentCycle);
		expect(month?.state).toBe("paid");
		expect(month?.total).toBe("6.00");
		expect(month?.badges.find((row) => row.handle === creator.handle)?.amount).toBe("3.00");
	});

	it("shows the prorate reduction next month and the full charge the month after", async () => {
		await makeBadge(creator.userId, "3.00");
		await setSubscription();
		current = subscription([
			{ destination: String(anthersId), dollars: 3 },
			{ destination: String(creator.userId), dollars: 3 },
		]);
		await db.insert(billingReductions).values({
			userId: supporter.userId,
			billingCycle: cycleAt(1),
			destination: String(creator.userId),
			amount: "0.90",
		});

		const months = await badgeChargeMonths(supporter.userId);
		const next = months.find((row) => row.cycle === cycleAt(1));
		const after = months.find((row) => row.cycle === cycleAt(2));
		expect(next?.state).toBe("estimated");
		expect(next?.badges.find((row) => row.handle === creator.handle)).toMatchObject({
			amount: "2.10",
			reduction: "0.90",
		});
		expect(after?.badges.find((row) => row.handle === creator.handle)).toMatchObject({
			amount: "3.00",
			reduction: "0.00",
		});
	});

	it("keeps the current month's holdings as an estimate when nothing is recorded", async () => {
		const badgeId = await makeBadge(creator.userId, "3.00");
		await db.insert(userBadges).values({
			userId: supporter.userId,
			badgeId,
			billingCycle: cycleAt(0),
		});

		const months = await badgeChargeMonths(supporter.userId);
		const currentMonth = months.find((row) => row.cycle === cycleAt(0));
		expect(currentMonth?.state).toBe("estimated");
		expect(currentMonth?.total).toBe("3.00");
	});

	it("answers five months with nothing charged for a free account", async () => {
		const months = await badgeChargeMonths(supporter.userId);
		expect(months).toHaveLength(5);
		expect(months.map((row) => row.cycle)).toEqual([
			cycleAt(-2),
			cycleAt(-1),
			cycleAt(0),
			cycleAt(1),
			cycleAt(2),
		]);
		expect(months.every((row) => row.total === "0.00" && row.badges.length === 0)).toBe(true);
	});

	it("projects nothing after a cancellation, because the whole subscription ends", async () => {
		await makeBadge(creator.userId, "3.00");
		await setSubscription();
		await db
			.update(stripeCustomers)
			.set({ canceledAt: new Date() })
			.where(eq(stripeCustomers.userId, supporter.userId));
		current = subscription([{ destination: String(creator.userId), dollars: 3 }]);

		const months = await badgeChargeMonths(supporter.userId);
		for (const cycle of [cycleAt(1), cycleAt(2)]) {
			const month = months.find((row) => row.cycle === cycle);
			expect(month?.state).toBe("estimated");
			expect(month?.badges).toEqual([]);
			expect(month?.total).toBe("0.00");
		}
	});

	it("serves the same record through the route", async () => {
		const past = cycleAt(-1);
		await paidInvoice(past, [{ creatorId: creator.userId, amount: "2.50" }]);

		const response = await app.fetch(
			new Request("http://localhost/api/subscriptions/badge-months", {
				headers: { Cookie: supporter.cookie },
			}),
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			months: { cycle: string; state: string; total: string }[];
		};
		expect(body.months.find((row) => row.cycle === past)).toMatchObject({
			state: "paid",
			total: "2.50",
		});
	});
});
