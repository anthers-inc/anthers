// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stripe Billing helpers for the support model.
 *
 * ONE subscription carries every Seed a user holds, at the single **$3 Seed** price, with
 * **quantity = the total** — Anthers' and the creators' together. Someone giving a Seed to
 * Anthers and one to each of two creators is quantity 3, $9/month, one charge. That is
 * 51.02's fully prepaid monthly charge, and it is also what amortises the fixed $0.30
 * across every creator on it.
 *
 * 🚨 Quantity is therefore NOT the Anthers count. The split rides in subscription
 * metadata (`anthersSeeds`, and `directed` for the per-creator picks) — see
 * `anthersSeedsFromSub`, where getting this wrong inflates a Badge and the Time Pool.
 *
 * The DB follows Stripe: subscription webhooks are the source of truth for both halves,
 * and the picks are applied on activation rather than at request time, so a declined card
 * cannot leave Seeds directed that nobody paid for.
 */
import { db } from "@anthers/db/client";
import { accountCycles, accounts, purchases, seedAllocations } from "@anthers/db/schema";
import { SEED_PRICE, seedCost } from "@anthers/shared/constants";
import { anthersSeedBreakdown, cardFee } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";

function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/** Record this cycle's snapshot (Anthers-Seeds + their decomposition + creator-Seeds). */
async function snapshotCycle(
	userId: number,
	anthersSeeds: number,
	creatorSeedTotal: number,
): Promise<void> {
	const bd = anthersSeedBreakdown(anthersSeeds);
	const values = {
		anthersSeeds,
		anthersSpend: new Decimal(seedCost(anthersSeeds)).toFixed(2),
		timePool: bd.timePool.toFixed(2),
		creatorSeedTotal: creatorSeedTotal.toFixed(2),
		foundation: Decimal.max(0, bd.foundation).toFixed(2),
	};
	await db
		.insert(accountCycles)
		.values({ userId, billingCycle: currentBillingCycle(), ...values })
		.onConflictDoUpdate({
			target: [accountCycles.userId, accountCycles.billingCycle],
			set: { ...values, updatedAt: new Date() },
		});
}

/** The configured recurring Stripe price for a single $3 Anthers-Seed (null if unset). */
export function seedPriceId(): string | null {
	return process.env.STRIPE_PRICE_SEED?.trim() || null;
}

/** Every Seed on the subscription — Anthers' and the creators' together. */
export function totalSeedsFromSub(sub: Stripe.Subscription): number {
	return Math.max(0, sub.items.data[0]?.quantity ?? 0);
}

/**
 * The **Anthers** Seed count — the subscription's quantity is the whole charge.
 *
 * 🚨 One subscription carries every Seed a user holds, because 51.02 is one fully
 * prepaid monthly charge and batching is what amortises the fixed $0.30 across the
 * creators on it. So quantity is 3 for someone giving one Seed to Anthers and one to
 * each of two creators — and quantity is emphatically NOT the Anthers count.
 *
 * That distinction is load-bearing: `accounts.anthersSeeds` is the Badge and it sets the
 * Time Pool, so reading quantity here would make that user a 3-Seed Petal funding $4.50
 * of Time Pool off a $3 gift to Anthers. The split rides in subscription metadata, which
 * the create call has always written.
 *
 * The fallback is the migration path rather than a guess: every subscription that
 * predates directed Seeds is Anthers-only, so for those quantity *is* the Anthers count.
 */
export function anthersSeedsFromSub(sub: Stripe.Subscription): number {
	const total = totalSeedsFromSub(sub);
	const raw = sub.metadata?.anthersSeeds;
	// A blank stamp is UNSTAMPED, not zero. `Number("")` is 0, which would hand every Seed
	// on the charge to the creators' side and drop the user's Badge to Free.
	if (typeof raw !== "string" || raw.trim() === "") return total;
	const stamped = Number(raw);
	if (!Number.isFinite(stamped) || stamped < 0) return total;
	return Math.min(Math.floor(stamped), total);
}

/** The Seeds on the charge that are pointed at creators rather than at Anthers. */
export function directedSeedsFromSub(sub: Stripe.Subscription): number {
	return Math.max(0, totalSeedsFromSub(sub) - anthersSeedsFromSub(sub));
}

/** Create (once) and persist the user's Stripe customer id. */
export async function ensureStripeCustomer(userId: number, email: string): Promise<string> {
	const stripe = getStripe();
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
	const stripe = getStripe();
	if (!stripe) return null;
	const pms = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
	const pm = pms.data[0];
	return pm?.card ? { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 } : null;
}

/**
 * Create a one-time charge to buy directed creator-Seeds. A Seed is a flat $3 all-in,
 * so the buyer is charged exactly `base` and the at-cost card fee comes **out** of it —
 * this path charged `base + processing` until 2026-08-04, which is the posture the
 * 2026-08-03 revamp retired everywhere else and missed here (mandatory-fee disclosure
 * law requires the advertised price to contain every mandatory fee). Nothing consumed
 * the route from the UI, so no buyer was ever overcharged; it was the API contradicting
 * the model. `cardFee` owns the arithmetic — don't restate it.
 *
 * A pending `purchases` row is keyed by the PaymentIntent so the webhook credits exactly
 * once on success. Returns the client secret to confirm inline.
 */
export async function createOneTimeCharge(opts: {
	userId: number;
	customerId: string;
	type: "seeds";
	base: number;
}): Promise<{ clientSecret: string | null; buyerTotal: string; processingFee: string }> {
	const stripe = getStripe();
	if (!stripe) throw new Error("Stripe not configured");
	const base = new Decimal(opts.base);
	const processing = cardFee(base); // at cost, out of the price — never added to it
	const buyerTotal = base;
	const pi = await stripe.paymentIntents.create({
		amount: Math.round(buyerTotal.toNumber() * 100),
		currency: "usd",
		customer: opts.customerId,
		payment_method_types: ["card"],
		metadata: { kind: opts.type, userId: String(opts.userId) },
	});
	await db.insert(purchases).values({
		buyerId: opts.userId,
		// A Seed buy is not a Work purchase — nothing to unlock, and no creator side to
		// record. Both stated explicitly so the nulls read as "this charge has no such
		// thing" rather than "nobody filled these in".
		workId: null,
		creatorId: null,
		type: opts.type,
		amount: base.toFixed(2),
		processingFee: processing.toFixed(2),
		crfFee: "0.00",
		// A Seed buy carries no sales tax today; recorded explicitly so the column
		// means "no tax was collected" rather than "nobody filled this in".
		salesTax: "0.00",
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
 * Credit a completed creator-Seed purchase to the account's creator-Seed balance.
 * Called from the webhook after the pending purchase flips to completed, so it runs
 * exactly once per PaymentIntent.
 */
export async function applyCreditForPurchase(purchase: {
	// Null once the buyer has deleted their account. A Seed credit is applied at
	// purchase time, long before any deletion could land, so in practice this is never
	// null here — it is typed honestly and guarded rather than asserted away.
	buyerId: number | null;
	type: string;
	amount: string;
}): Promise<void> {
	if (purchase.type !== "seeds") return;
	// Nothing to credit if there is no longer an account to credit it to.
	if (purchase.buyerId == null) return;
	const [acct] = await db
		.select()
		.from(accounts)
		.where(eq(accounts.userId, purchase.buyerId))
		.limit(1);
	if (!acct) return;
	const next = (Number(acct.creatorSeedTotal) + Number(purchase.amount)).toFixed(2);
	await db
		.update(accounts)
		.set({ creatorSeedTotal: next, updatedAt: new Date() })
		.where(eq(accounts.id, acct.id));
	await snapshotCycle(purchase.buyerId, acct.anthersSeeds, Number(next));
}

/**
 * Reconcile the account row to a subscription's current state — called from the
 * webhook on customer.subscription.created/updated/deleted. The subscription's
 * quantity is the user's Anthers-Seed count; a canceled/expired subscription
 * reverts to 0 (Free).
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
				anthersSeeds: 0,
				stripeSubscriptionId: "",
				isActive: true,
				canceledAt: null,
				updatedAt: new Date(),
			})
			.where(eq(accounts.id, acct.id));
		return;
	}

	const active = sub.status === "active" || sub.status === "trialing";
	const anthersSeeds = anthersSeedsFromSub(sub);
	// The paid-for creator-Seed balance is the rest of the same charge. It is set from the
	// subscription rather than accumulated, so a user who lowers their count next month
	// cannot keep directing Seeds they have stopped paying for.
	const directedTotal = directedSeedsFromSub(sub) * SEED_PRICE;
	const periodEndUnix = sub.items.data[0]?.current_period_end;

	await db
		.update(accounts)
		.set({
			...(active ? { anthersSeeds, creatorSeedTotal: directedTotal.toFixed(2) } : {}),
			stripeSubscriptionId: sub.id,
			isActive: active,
			...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
			canceledAt: sub.cancel_at_period_end ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(accounts.id, acct.id));

	if (active) {
		await applyDirectedSeedsFromSub(acct.userId, sub);
		await snapshotCycle(acct.userId, anthersSeeds, directedTotal);
	}
}

/**
 * Write the per-creator allocations the user chose when they subscribed.
 *
 * The picks travel on the subscription's metadata because that is the record that
 * survives the gap between "confirm this payment" and "the webhook says it succeeded" —
 * writing allocations at request time would direct Seeds that were never paid for if the
 * card then declined.
 *
 * Idempotent: the webhook can deliver the same event more than once, so each row is an
 * upsert keyed on (user, creator, cycle) and the metadata is cleared once applied.
 */
async function applyDirectedSeedsFromSub(userId: number, sub: Stripe.Subscription): Promise<void> {
	const raw = sub.metadata?.directed;
	if (!raw) return;

	let picks: { creatorId: number; seeds: number }[];
	try {
		picks = JSON.parse(raw) as { creatorId: number; seeds: number }[];
	} catch {
		return;
	}
	if (!Array.isArray(picks) || picks.length === 0) return;

	const cycle = currentBillingCycle();
	for (const pick of picks) {
		if (!Number.isInteger(pick?.creatorId) || !Number.isInteger(pick?.seeds) || pick.seeds <= 0) {
			continue;
		}
		const amount = (pick.seeds * SEED_PRICE).toFixed(2);
		await db
			.insert(seedAllocations)
			.values({ userId, creatorId: pick.creatorId, amount, billingCycle: cycle })
			.onConflictDoUpdate({
				target: [seedAllocations.userId, seedAllocations.creatorId, seedAllocations.billingCycle],
				// Allocation is add-only within a cycle (20.03), so an existing larger
				// direction is never walked back by a replayed webhook.
				set: { amount: sql`GREATEST(${seedAllocations.amount}, ${amount}::numeric)` },
			});
	}

	const stripe = getStripe();
	if (stripe) {
		await stripe.subscriptions.update(sub.id, { metadata: { ...sub.metadata, directed: "" } });
	}
}
