// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stripe Billing helpers for the support model.
 *
 * ONE subscription carries everything a user gives, as **one item per destination** —
 * Anthers and each creator, each priced at that destination's own monthly amount. Someone
 * giving Anthers $3, Alice $5 and Bob $2.50 has three items totalling $10.50, on one
 * invoice and one charge. That is 51.02's fully prepaid monthly charge, and it is also
 * what amortises the fixed $0.30 across every creator on it.
 *
 * 🚨 **This was ONE item with `quantity` = the total Seed count until 2026-08-16**, with
 * the Anthers/creator split riding in subscription metadata. Arbitrary amounts ended that:
 * a quantity of a shared unit cannot express $2.50, and the unit itself retired. What must
 * survive the change is the LESSON PR #223 paid for — a number read as if it meant
 * something else, with no error anywhere. That hazard has not gone, it has moved: the
 * amounts are now structural and legible on the invoice, but **which destination an item
 * belongs to is still a stamp**, and reading an item's amount without checking its
 * `destination` metadata funds the wrong Time Pool exactly as silently as before.
 * `splitFromSub` is the one place that check lives.
 *
 * The DB follows Stripe: subscription webhooks are the source of truth for both halves,
 * and the picks are applied on activation rather than at request time, so a declined card
 * cannot leave support directed that nobody paid for.
 */
import { db } from "@anthers/db/client";
import { accountCycles, accounts, purchases, seedAllocations } from "@anthers/db/schema";
import { supportAmount } from "@anthers/shared/constants";
import { anthersSupportBreakdown, cardFee } from "@anthers/shared/fees";
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
	anthersSupport: number,
	creatorSupportTotal: number,
): Promise<void> {
	const bd = anthersSupportBreakdown(anthersSupport);
	const values = {
		anthersSupport: new Decimal(anthersSupport).toFixed(2),
		timePool: bd.timePool.toFixed(2),
		creatorSupportTotal: creatorSupportTotal.toFixed(2),
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

/**
 * The Stripe Product the Anthers line is billed against, provisioned on demand.
 *
 * 🚨 **This read `process.env.STRIPE_PRODUCT_ANTHERS` and nothing ever set it.** PR #24
 * replaced the old one-price-times-a-quantity model with a Product per destination and
 * introduced this variable; it was declared in no spec, no `.env.example` and no dev
 * helper, and was absent from the running production app. `POST /account` returns **500**
 * when it is null — so from the moment the retirement deployed, **subscribing was dead in
 * production** and no test could see it, because tests supply their own Stripe double.
 *
 * The fix is not to declare the variable. A value an operator must remember to set in
 * every environment is the failure, and this repo has now been bitten by that exact shape
 * twice — `STUDIO_URL` is the other. So the platform Product is provisioned the same way a
 * creator's is by `ensureCreatorProduct` below: looked up, created if absent, and found
 * again by its metadata stamp rather than by a copied id.
 *
 * The env var still wins when set, so an operator who wants to pin a specific Product
 * (a migration, a shared sandbox) can — it is an override, no longer a requirement.
 */
let cachedAnthersProduct: string | null = null;

export async function ensureAnthersProduct(): Promise<string> {
	const pinned = process.env.STRIPE_PRODUCT_ANTHERS?.trim();
	if (pinned) return pinned;
	if (cachedAnthersProduct) return cachedAnthersProduct;

	const stripe = getStripe();
	if (!stripe) throw new Error("Stripe not configured");

	// `metadata.anthers = "platform"` is the stamp, and it is why this survives a restart
	// without a database column: the Product is found by what it IS, not by an id someone
	// wrote down. Search is eventually consistent on new objects, so the list is the
	// authority and search is not used here.
	for await (const product of stripe.products.list({ limit: 100, active: true })) {
		if (product.metadata?.anthers === "platform") {
			cachedAnthersProduct = product.id;
			return product.id;
		}
	}

	const created = await stripe.products.create({
		name: "Support for Anthers",
		metadata: { anthers: "platform" },
	});
	cachedAnthersProduct = created.id;
	return created.id;
}

/** What one subscription item is for. `null` creatorId means the Anthers line. */
export interface SupportItem {
	itemId: string;
	creatorId: number | null;
	/** Monthly dollars on this line. */
	amount: number;
}

/**
 * Every destination on a subscription, with what each is given.
 *
 * 🚨 **The `destination` stamp is what makes an item's amount mean anything**, and this is
 * the one place that is read. An item priced at $5 says nothing on its own about whether
 * $5 reaches Anthers' Time Pool or reaches Alice — and crediting the wrong one is silent,
 * because both are plausible numbers on a well-formed subscription. That is the same
 * failure PR #223 existed to prevent, wearing the shape the N-item model gives it.
 *
 * An **unstamped** item is treated as the Anthers line rather than dropped, which is the
 * migration path and not a guess: every subscription predating this change carried one
 * item, and the accounts on them were Anthers-only or had their split in metadata that no
 * longer applies. Dropping it instead would silently zero a paying supporter's Badge.
 */
export function itemsFromSub(sub: Stripe.Subscription): SupportItem[] {
	return sub.items.data.map((item) => {
		const raw = item.metadata?.destination?.trim();
		// A blank stamp is UNSTAMPED, not creator 0. `Number("")` is 0, which would credit
		// a real supporter's money to whichever account happens to hold user id 0.
		const creatorId = !raw || raw === "anthers" ? null : Number(raw);
		const unitCents = item.price?.unit_amount ?? 0;
		return {
			itemId: item.id,
			creatorId:
				Number.isFinite(creatorId) && creatorId !== null && creatorId > 0 ? creatorId : null,
			amount: (unitCents * Math.max(0, item.quantity ?? 1)) / 100,
		};
	});
}

/** Everything on the charge — Anthers' line and the creators' together. */
export function totalSupportFromSub(sub: Stripe.Subscription): number {
	return itemsFromSub(sub).reduce((sum, i) => sum + i.amount, 0);
}

/**
 * The monthly dollars pointed at **Anthers** — the Badge, and what sets the Time Pool.
 *
 * `accounts.anthersSupport` is the Badge *and* it sets the Time Pool, so reading the whole
 * charge here would make a user who gives Anthers $3 and two creators $3 each look like a
 * $9 Blossom funding $4.50 of Time Pool off a $3 gift — with no error anywhere.
 */
export function anthersSupportFromSub(sub: Stripe.Subscription): number {
	return itemsFromSub(sub)
		.filter((i) => i.creatorId === null)
		.reduce((sum, i) => sum + i.amount, 0);
}

/** The monthly dollars on the charge pointed at creators rather than at Anthers. */
export function directedSupportFromSub(sub: Stripe.Subscription): number {
	return itemsFromSub(sub)
		.filter((i) => i.creatorId !== null)
		.reduce((sum, i) => sum + i.amount, 0);
}

/**
 * The per-creator picks, read from the items themselves.
 *
 * ⚠️ These used to travel in subscription **metadata**, applied on activation and then
 * cleared, because the amounts lived nowhere else — a quantity of a shared unit could not
 * say who each Seed was for. With one item per destination the picks ARE the subscription,
 * so there is no stamp to go stale, no clearing step, and no window in which Stripe and the
 * database disagree about who is being supported.
 */
export function directedPicksFromSub(
	sub: Stripe.Subscription,
): { creatorId: number; amount: number }[] {
	return itemsFromSub(sub)
		.filter((i): i is SupportItem & { creatorId: number } => i.creatorId !== null && i.amount > 0)
		.map((i) => ({ creatorId: i.creatorId, amount: i.amount }));
}

/** The billing period end, read across items rather than from the first one. */
export function periodEndFromSub(sub: Stripe.Subscription): number | null {
	// Every item on one subscription shares a period, but `items.data[0]` is now an
	// arbitrary destination rather than "the" item — so take the latest and stop depending
	// on which creator happens to sort first.
	const ends = sub.items.data.map((i) => i.current_period_end).filter((n): n is number => !!n);
	return ends.length > 0 ? Math.max(...ends) : null;
}

/**
 * The Stripe Product a creator's line is billed against, created on first use.
 *
 * `price_data` on a subscription item takes a Product **id**, not a name — so without one
 * per creator every line on a supporter's invoice would carry the same label and the
 * itemised receipt would say nothing. This is the whole reason the N-item model needs a
 * column at all.
 *
 * Lazy rather than eager: a creator nobody supports needs no Product, and creating one at
 * signup would make registering an account depend on Stripe being reachable.
 */
export async function ensureCreatorProduct(creatorId: number, handle: string): Promise<string> {
	const stripe = getStripe();
	if (!stripe) throw new Error("Stripe not configured");
	const [acct] = await db.select().from(accounts).where(eq(accounts.userId, creatorId)).limit(1);
	if (acct?.stripeProductId) return acct.stripeProductId;
	const product = await stripe.products.create({
		name: `Support for @${handle}`,
		metadata: { creatorId: String(creatorId) },
	});
	await db
		.update(accounts)
		.set({ stripeProductId: product.id, updatedAt: new Date() })
		.where(eq(accounts.userId, creatorId));
	return product.id;
}

/**
 * One subscription item per destination, priced inline.
 *
 * 🚨 **`metadata.destination` is not decoration — it is the only thing that says whose
 * money this line is.** `itemsFromSub` reads it back, and an unstamped item is credited to
 * Anthers. Adding a destination here without stamping it therefore routes a creator's
 * support into the Time Pool silently, which is the N-item shape of the hazard PR #223
 * paid for.
 */
export function supportItems(
	anthersProduct: string,
	anthersDollars: number,
	directed: { creatorId: number; product: string; amount: number }[],
): Stripe.SubscriptionCreateParams.Item[] {
	const monthly = (product: string, dollars: number, destination: string) => ({
		price_data: {
			currency: "usd",
			product,
			unit_amount: Math.round(dollars * 100),
			recurring: { interval: "month" as const },
		},
		quantity: 1,
		metadata: { destination },
	});
	const items: Stripe.SubscriptionCreateParams.Item[] = [];
	if (anthersDollars > 0) items.push(monthly(anthersProduct, anthersDollars, "anthers"));
	for (const d of directed) {
		if (d.amount > 0) items.push(monthly(d.product, d.amount, String(d.creatorId)));
	}
	return items;
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
	const next = (Number(acct.creatorSupportTotal) + Number(purchase.amount)).toFixed(2);
	await db
		.update(accounts)
		.set({ creatorSupportTotal: next, updatedAt: new Date() })
		.where(eq(accounts.id, acct.id));
	await snapshotCycle(purchase.buyerId, supportAmount(acct.anthersSupport), Number(next));
}

/**
 * Reconcile the account row to a subscription's current state — called from the
 * webhook on customer.subscription.created/updated/deleted. A canceled or expired
 * subscription reverts the account to $0 (Free).
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
				anthersSupport: "0.00",
				stripeSubscriptionId: "",
				isActive: true,
				canceledAt: null,
				updatedAt: new Date(),
			})
			.where(eq(accounts.id, acct.id));
		return;
	}

	const active = sub.status === "active" || sub.status === "trialing";
	const anthersSupport = anthersSupportFromSub(sub);
	// The paid-for directed balance is the rest of the same charge. It is set from the
	// subscription rather than accumulated, so a user who lowers what they give next month
	// cannot keep directing support they have stopped paying for.
	const directedTotal = directedSupportFromSub(sub);
	const periodEndUnix = periodEndFromSub(sub);

	await db
		.update(accounts)
		.set({
			...(active
				? {
						anthersSupport: new Decimal(anthersSupport).toFixed(2),
						creatorSupportTotal: new Decimal(directedTotal).toFixed(2),
					}
				: {}),
			stripeSubscriptionId: sub.id,
			isActive: active,
			...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
			canceledAt: sub.cancel_at_period_end ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(accounts.id, acct.id));

	if (active) {
		await applyDirectedSupportFromSub(acct.userId, sub);
		await snapshotCycle(acct.userId, anthersSupport, directedTotal);
	}
}

/**
 * Write the per-creator allocations the user is paying for this cycle.
 *
 * 🚨 **Read from the subscription's ITEMS, not from metadata** (2026-08-16). The picks used
 * to travel as a JSON blob on `sub.metadata.directed`, applied on activation and then
 * cleared — necessary while a quantity of a shared unit could not say who each Seed was
 * for, and a genuine hazard: between "confirm this payment" and "the webhook says it
 * succeeded" the truth lived in a string that had to be parsed, trusted, and unset exactly
 * once. The items ARE the picks now, so there is no stamp to go stale and no clearing step
 * whose failure would replay them.
 *
 * The property that mattered survives untouched: nothing is written until the subscription
 * is **active**, so a card that declines cannot leave support directed that nobody paid for.
 *
 * Idempotent: the webhook can deliver the same event more than once, so each row is an
 * upsert keyed on (user, creator, cycle).
 */
async function applyDirectedSupportFromSub(
	userId: number,
	sub: Stripe.Subscription,
): Promise<void> {
	const picks = directedPicksFromSub(sub);
	if (picks.length === 0) return;

	const cycle = currentBillingCycle();
	for (const pick of picks) {
		const amount = new Decimal(pick.amount).toFixed(2);
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
}
