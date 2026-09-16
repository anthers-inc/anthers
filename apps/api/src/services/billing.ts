// SPDX-License-Identifier: Apache-2.0
/**
 * Stripe Billing helpers for the support model.
 *
 * ONE subscription carries everything a user gives, as **one item per destination** —
 * Anthers and each creator, each priced at that destination's own monthly amount. Someone
 * giving Anthers $3, Alice $5 and Bob $2.50 has three items totaling $10.50, on one
 * invoice and one charge. That is the fully prepaid monthly charge the wiki's *How Money
 * Moves* describes, and it is also
 * what amortizes the fixed $0.30 across every creator on it.
 *
 * 🚨 **One item per destination, never one item with a quantity**, because a quantity of a
 * shared unit cannot express $2.50. The hazard that shape carried has not gone, it has
 * moved: the amounts are structural and legible on the invoice now, but **which
 * destination an item belongs to is still a stamp**, and reading an item's amount without
 * checking its `destination` metadata funds the wrong Time Pool exactly as silently as a
 * misread quantity did — a number taken to mean something else, with no error anywhere.
 * `splitFromSub` is the one place that check lives.
 *
 * The DB follows Stripe: subscription webhooks are the source of truth for both halves,
 * and the picks are applied on activation rather than at request time, so a declined card
 * cannot leave support directed that nobody paid for.
 */
import { db } from "@anthers/db/client";
import { accountCycles, accounts, seedAllocations } from "@anthers/db/schema";
import { currentCycleKey, cycleKeyFor } from "@anthers/shared/billing-cycle";
import { anthersSupportBreakdown } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { eq, sql } from "drizzle-orm";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";

/** Record this cycle's snapshot (what was given to Anthers + its decomposition + what was directed). */
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
		.values({ userId, billingCycle: currentCycleKey(), ...values })
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
 * charge here would make a user who gives Anthers $3 and two creators $7 and $2 look like a
 * $12 Blossom funding $6 of Time Pool off a $3 gift — with no error anywhere.
 *
 * The creators' amounts are deliberately unequal and deliberately not $3: a creator sets
 * their own Badge levels to any amount, and $3 is only ever the price of Public Access.
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
 * The billing period start, read the same way and for the same reason.
 *
 * 🚨 **Nothing wrote `accounts.current_period_start` after the row was created**, so it held
 * whatever `ensureAccount` stamped on the day somebody first paid and never moved again. Every
 * job that keys a cycle from it therefore keyed the same month forever — which is the frozen
 * key the settlement defects all sit downstream of. The **earliest** item is taken rather than
 * the latest, because a period runs from when it opened.
 */
export function periodStartFromSub(sub: Stripe.Subscription): number | null {
	const starts = sub.items.data.map((i) => i.current_period_start).filter((n): n is number => !!n);
	return starts.length > 0 ? Math.min(...starts) : null;
}

/**
 * The Stripe Product a creator's line is billed against, created on first use.
 *
 * `price_data` on a subscription item takes a Product **id**, not a name — so without one
 * per creator every line on a supporter's invoice would carry the same label and the
 * itemized receipt would say nothing. This is the whole reason the N-item model needs a
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

/** A destination's desired monthly amount, with the Product its line is billed against. */
export interface DesiredLine {
	/** `null` for the Anthers line, a creator's user id otherwise. */
	creatorId: number | null;
	product: string;
	amount: number;
}

/** What a change to an existing subscription splits into. */
export interface ItemChange {
	/** Items to send under `always_invoice` — charged in full today. */
	raises: Stripe.SubscriptionUpdateParams.Item[];
	/** Items to send under `proration_behavior: "none"` — they take effect on the 1st. */
	drops: Stripe.SubscriptionUpdateParams.Item[];
	/** What began or grew today, and is therefore owed the days before it. */
	started: { creatorId: number | null; amount: number }[];
}

/**
 * Split a requested change into the half that is charged now and the half that waits.
 *
 * 🚨 **Which half a destination lands in is decided per destination, never for the request.**
 * Somebody raising Anthers from $3 to $9 while dropping a creator is doing both things at
 * once, and a single `proration_behavior` for the whole update would either credit the drop
 * back immediately or fail to charge for the raise. Nothing about the request as a whole says
 * which it is.
 *
 * ⭐ **`started` carries the DELTA on a raise, not the new amount.** Somebody moving a line
 * from $3 to $10 on the 20th has been paying for the $3 all month and is charged $7 today, so
 * $7 is what the days before the 20th are owed against. Reading the new amount instead would
 * hand back nineteen days of a line that ran all month.
 */
export function planItemChange(
	sub: Stripe.Subscription,
	anthersProduct: string,
	anthersDollars: number,
	directed: { creatorId: number; product: string; amount: number }[],
): ItemChange {
	const key = (creatorId: number | null) => (creatorId === null ? "anthers" : String(creatorId));

	const desired = new Map<string, DesiredLine>();
	if (anthersDollars > 0) {
		desired.set("anthers", { creatorId: null, product: anthersProduct, amount: anthersDollars });
	}
	for (const d of directed) {
		if (d.amount > 0) {
			desired.set(key(d.creatorId), {
				creatorId: d.creatorId,
				product: d.product,
				amount: d.amount,
			});
		}
	}

	const current = new Map<string, SupportItem>();
	for (const item of itemsFromSub(sub)) {
		const k = key(item.creatorId);
		// Two lines pointed at one destination is not a shape this writes, but an older
		// subscription can carry one — sum them so the comparison is against everything that
		// destination is actually being charged, and keep the first id to update.
		const existing = current.get(k);
		current.set(k, existing ? { ...existing, amount: existing.amount + item.amount } : item);
	}

	const line = (id: string | undefined, d: DesiredLine): Stripe.SubscriptionUpdateParams.Item => ({
		...(id ? { id } : {}),
		price_data: {
			currency: "usd",
			product: d.product,
			unit_amount: Math.round(d.amount * 100),
			recurring: { interval: "month" as const },
		},
		quantity: 1,
		// 🚨 The stamp is what says whose money this line is — `itemsFromSub` reads it back,
		// and an unstamped item is credited to Anthers. Never build an item without it.
		metadata: { destination: key(d.creatorId) },
	});

	const change: ItemChange = { raises: [], drops: [], started: [] };

	for (const [k, want] of desired) {
		const have = current.get(k);
		if (!have) {
			change.raises.push(line(undefined, want));
			change.started.push({ creatorId: want.creatorId, amount: want.amount });
		} else if (want.amount > have.amount) {
			change.raises.push(line(have.itemId, want));
			change.started.push({ creatorId: want.creatorId, amount: want.amount - have.amount });
		} else if (want.amount < have.amount) {
			change.drops.push(line(have.itemId, want));
		}
		// Equal — untouched. Sending it anyway would prorate a line that has not moved.
	}

	for (const [k, have] of current) {
		// ⚠️ Stripe does NOT remove an item you simply omit, so a creator somebody stopped
		// supporting keeps being charged for unless it is deleted explicitly. That was true of
		// the rebuild-everything version too, and is the one property of it worth keeping.
		if (!desired.has(k)) change.drops.push({ id: have.itemId, deleted: true });
	}

	return change;
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
	// ⚠️ Upserts rather than updates. **Signing up does not create an `accounts` row** — one
	// appears on first payment — so a plain UPDATE affected nothing for a user who had never
	// paid, and this returned a customer id it had not persisted. Every existing caller
	// reaches here through a flow that already made the row, which is why it never showed;
	// adulthood verification is the first caller for whom "never paid" is the normal case.
	await db
		.insert(accounts)
		.values({ userId, stripeCustomerId: customer.id })
		.onConflictDoUpdate({
			target: accounts.userId,
			set: { stripeCustomerId: customer.id, updatedAt: new Date() },
		});
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

// 🚨 **A one-off support top-up used to live here** (`createOneTimeCharge`, behind
// `POST /subscriptions/seeds/buy`), and it is named here only because `purchases.type` still
// has `"seeds"` in it and rows of that type can still be read. Nothing creates one: the
// charge paid the fixed $0.30 by itself — the exact cost the monthly subscription exists to
// amortize — and the credit it wrote to `creator_support_total` was overwritten by the next
// subscription update, because that column is SET from the subscription rather than
// accumulated. `services/refunds.ts` and `services/dmca.ts` still branch on the type, which
// is about data that exists rather than a path that runs.

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
	const periodStartUnix = periodStartFromSub(sub);
	const periodEndUnix = periodEndFromSub(sub);

	/**
	 * 🚨 **An in-force amount never falls within a cycle**, because a decrease takes effect on
	 * the 1st and the month it was lowered in has already been paid for in full.
	 *
	 * The Stripe side of a decrease is `proration_behavior: "none"` — the price changes, no
	 * money moves, and the next invoice on the 1st is the only thing that differs. That is
	 * correct billing and it is also the trap: the *items* say $3 the instant somebody lowers
	 * from $12, so reading them straight through would take away a Blossom Badge they had
	 * already bought, eight days into the month, with nothing refunded.
	 *
	 * So within a cycle the higher of the two wins, and the new value is taken outright once
	 * the cycle turns. A raise is unaffected, since a raise is charged in full today and is
	 * therefore genuinely in force today. ⭐ **This is the rule `applyDirectedSupportFromSub`
	 * already applies per creator with its `GREATEST` upsert** — allocation is add-only within
	 * a cycle — rather than a new idea; what was missing was the account-level half.
	 */
	const heldOver =
		acct.currentPeriodStart != null &&
		periodStartUnix != null &&
		cycleKeyFor(acct.currentPeriodStart) === cycleKeyFor(new Date(periodStartUnix * 1000));
	const inForce = (fromSub: number, stored: string) =>
		heldOver ? Decimal.max(fromSub, stored) : new Decimal(fromSub);

	const anthersSupport = inForce(anthersSupportFromSub(sub), acct.anthersSupport);
	// The paid-for directed balance is the rest of the same charge, held over the same way —
	// a supporter who drops a creator on the 10th has already paid that creator for the month.
	const directedTotal = inForce(directedSupportFromSub(sub), acct.creatorSupportTotal);

	await db
		.update(accounts)
		.set({
			...(active
				? {
						anthersSupport: anthersSupport.toFixed(2),
						creatorSupportTotal: directedTotal.toFixed(2),
					}
				: {}),
			stripeSubscriptionId: sub.id,
			isActive: active,
			...(periodStartUnix ? { currentPeriodStart: new Date(periodStartUnix * 1000) } : {}),
			...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
			canceledAt: sub.cancel_at_period_end ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(accounts.id, acct.id));

	if (active) {
		await applyDirectedSupportFromSub(acct.userId, sub);
		await snapshotCycle(acct.userId, anthersSupport.toNumber(), directedTotal.toNumber());
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

	const cycle = currentCycleKey();
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
