// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stripe Billing helpers for badge subscriptions: the price↔badge mapping, customer
 * creation, and webhook-driven reconciliation of a subscription's state onto the
 * user's account. The DB follows Stripe — subscription webhooks are the source of
 * truth for which badge is active.
 */
import { db } from "@anthers/db/client";
import { accountCycles, accounts, purchases, walletLedger } from "@anthers/db/schema";
import { BADGE_PLANS, type Badge, CARD_FLAT, CARD_RATE } from "@anthers/shared/constants";
import { badgePriceBreakdown } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { stripe } from "../lib/stripe.js";

function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Record this cycle's plan snapshot (badge + price decomposition + Seeds) for pool accounting. */
async function snapshotCycle(userId: number, badge: Badge, seedTotal: number): Promise<void> {
	const bd = badgePriceBreakdown(badge);
	const values = {
		badge,
		planPrice: bd.price.toFixed(2),
		timePool: bd.timePool.toFixed(2),
		seedTotal: seedTotal.toFixed(2),
		communityShare: bd.communityShare.toFixed(2),
	};
	await db
		.insert(accountCycles)
		.values({ userId, billingCycle: currentBillingCycle(), ...values })
		.onConflictDoUpdate({
			target: [accountCycles.userId, accountCycles.billingCycle],
			set: { ...values, updatedAt: new Date() },
		});
}

const BADGE_PRICE_ENV: Record<Exclude<Badge, "free">, string> = {
	root: "STRIPE_PRICE_ROOT",
	sprout: "STRIPE_PRICE_SPROUT",
	petal: "STRIPE_PRICE_PETAL",
	blossom: "STRIPE_PRICE_BLOSSOM",
};

/** The configured recurring Stripe price for a paid badge (null for free/unset). */
export function priceIdForBadge(badge: Badge): string | null {
	if (badge === "free") return null;
	return process.env[BADGE_PRICE_ENV[badge]]?.trim() || null;
}

/** Reverse of priceIdForBadge — names the badge from a subscription's price id. */
export function badgeForPriceId(priceId: string): Badge | null {
	for (const [badge, envKey] of Object.entries(BADGE_PRICE_ENV)) {
		if (process.env[envKey]?.trim() === priceId) return badge as Badge;
	}
	return null;
}

/** Create (once) and persist the user's Stripe customer id. */
export async function ensureStripeCustomer(userId: number, email: string): Promise<string> {
	if (!stripe) throw new Error("Stripe not configured");
	const [acct] = await db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
	if (acct?.stripeCustomerId) return acct.stripeCustomerId;
	const customer = await stripe.customers.create({
		email: email || undefined,
		metadata: { userId: String(userId) },
	});
	await db
		.update(accounts)
		.set({ stripeCustomerId: customer.id, updatedAt: new Date() })
		.where(eq(accounts.userId, userId));
	return customer.id;
}

/** The customer's saved card, if one is on file (attached when a payment is confirmed). */
export async function savedCardFor(
	customerId: string,
): Promise<{ id: string; brand: string; last4: string } | null> {
	if (!stripe) return null;
	const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
	const pm = pms.data[0];
	return pm?.card ? { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 } : null;
}

/**
 * Create a one-time charge that isn't a post purchase — a wallet top-up or a Seed buy.
 * The buyer pays the base amount plus card processing (Anthers keeps $0); a pending
 * `purchases` row is keyed by the PaymentIntent so the webhook can credit exactly once
 * on success. Returns the client secret to confirm inline.
 */
export async function createOneTimeCharge(opts: {
	userId: number;
	customerId: string;
	type: "wallet" | "seeds";
	base: number;
}): Promise<{ clientSecret: string | null; buyerTotal: string; processingFee: string }> {
	if (!stripe) throw new Error("Stripe not configured");
	const base = new Decimal(opts.base);
	const processing = base.mul(CARD_RATE).plus(CARD_FLAT); // buyer covers the card fee
	const buyerTotal = base.plus(processing);
	const pi = await stripe.paymentIntents.create({
		amount: Math.round(buyerTotal.toNumber() * 100),
		currency: "usd",
		customer: opts.customerId,
		payment_method_types: ["card"],
		metadata: { kind: opts.type, userId: String(opts.userId) },
	});
	await db.insert(purchases).values({
		buyerId: opts.userId,
		postId: null,
		type: opts.type,
		amount: base.toFixed(2),
		processingFee: processing.toFixed(2),
		crfFee: "0.00",
		creatorEarnings: "0.00",
		stripePaymentIntentId: pi.id,
		status: "pending",
	});
	return {
		clientSecret: pi.client_secret,
		buyerTotal: buyerTotal.toFixed(2),
		processingFee: processing.toFixed(2),
	};
}

/**
 * Credit a completed non-post charge to the account (wallet balance or Seed total).
 * Called from the webhook after the pending purchase flips to completed, so it runs
 * exactly once per PaymentIntent.
 */
export async function applyCreditForPurchase(purchase: {
	buyerId: number;
	type: string;
	amount: string;
}): Promise<void> {
	const [acct] = await db
		.select()
		.from(accounts)
		.where(eq(accounts.userId, purchase.buyerId))
		.limit(1);
	if (!acct) return;
	if (purchase.type === "wallet") {
		const next = (Number(acct.walletBalance) + Number(purchase.amount)).toFixed(2);
		await db
			.update(accounts)
			.set({ walletBalance: next, updatedAt: new Date() })
			.where(eq(accounts.id, acct.id));
		await db
			.insert(walletLedger)
			.values({ userId: purchase.buyerId, delta: purchase.amount, reason: "topup" });
	} else if (purchase.type === "seeds") {
		const next = (Number(acct.seedTotal) + Number(purchase.amount)).toFixed(2);
		await db
			.update(accounts)
			.set({ seedTotal: next, updatedAt: new Date() })
			.where(eq(accounts.id, acct.id));
		await snapshotCycle(purchase.buyerId, acct.badge as Badge, Number(next));
	}
}

/**
 * Reconcile the account row to a subscription's current state — called from the
 * webhook on customer.subscription.created/updated/deleted. Applies the badge only
 * while the subscription is live; a canceled/expired subscription reverts to Free.
 */
export async function syncSubscriptionToAccount(sub: Stripe.Subscription): Promise<void> {
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	const [acct] = await db
		.select()
		.from(accounts)
		.where(eq(accounts.stripeCustomerId, customerId))
		.limit(1);
	if (!acct) return;

	const gone = sub.status === "canceled" || sub.status === "incomplete_expired";
	if (gone) {
		// Ignore a stale subscription that isn't the account's current one.
		if (acct.stripeSubscriptionId && acct.stripeSubscriptionId !== sub.id) return;
		await db
			.update(accounts)
			.set({
				badge: "free",
				stripeSubscriptionId: "",
				isActive: true,
				canceledAt: null,
				updatedAt: new Date(),
			})
			.where(eq(accounts.id, acct.id));
		return;
	}

	const priceId = sub.items.data[0]?.price?.id;
	const badge = priceId ? badgeForPriceId(priceId) : null;
	const active = sub.status === "active" || sub.status === "trialing";
	const periodEndUnix = sub.items.data[0]?.current_period_end;

	// When a paid badge becomes active, set the plan's included Seeds — preserving any
	// extra Seeds the user bought on top of their previous plan's included count.
	let nextSeedTotal: number | null = null;
	if (active && badge) {
		const oldPlan = BADGE_PLANS[acct.badge as Badge];
		const extras = Math.max(0, Number(acct.seedTotal) - oldPlan.seeds);
		nextSeedTotal = BADGE_PLANS[badge].seeds + extras;
	}

	await db
		.update(accounts)
		.set({
			...(active && badge ? { badge } : {}),
			...(nextSeedTotal !== null ? { seedTotal: nextSeedTotal.toFixed(2) } : {}),
			stripeSubscriptionId: sub.id,
			isActive: active,
			...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
			canceledAt: sub.cancel_at_period_end ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(accounts.id, acct.id));

	if (active && badge && nextSeedTotal !== null) {
		await snapshotCycle(acct.userId, badge, nextSeedTotal);
	}
}
