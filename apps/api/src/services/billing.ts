// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stripe Billing helpers for badge subscriptions: the price↔badge mapping, customer
 * creation, and webhook-driven reconciliation of a subscription's state onto the
 * user's account. The DB follows Stripe — subscription webhooks are the source of
 * truth for which badge is active.
 */
import { db } from "@anthers/db/client";
import { accounts } from "@anthers/db/schema";
import type { Badge } from "@anthers/shared/constants";
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import { stripe } from "../lib/stripe.js";

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

	await db
		.update(accounts)
		.set({
			...(active && badge ? { badge } : {}),
			stripeSubscriptionId: sub.id,
			isActive: active,
			...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
			canceledAt: sub.cancel_at_period_end ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(accounts.id, acct.id));
}
