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
import { accountCycles, badges, billingAccounts, invoices, userBadges } from "@anthers/db/schema";
import { currentCycleKey, cycleKeyFor } from "@anthers/shared/billing-cycle";
import { anthersSupportBreakdown } from "@anthers/shared/fees";
import { DONATION_TAX_CODE, STREAMED_SUBSCRIPTION_TAX_CODE } from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { and, eq, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import {
	createCustomer,
	createProduct,
	listActiveProducts,
	listCardPaymentMethods,
	paymentsConfigured,
	updateProduct,
} from "../lib/processor.js";
import { anthersUserId } from "./anthers-badges.js";

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

	if (!paymentsConfigured()) throw new Error("Stripe not configured");

	// `metadata.anthers = "platform"` is the stamp, and it is why this survives a restart
	// without a database column: the Product is found by what it IS, not by an id someone
	// wrote down. Search is eventually consistent on new objects, so the list is the
	// authority and search is not used here.
	const active = listActiveProducts();
	for await (const product of active ?? []) {
		if (product.metadata?.anthers === "platform") {
			cachedAnthersProduct = product.id;
			return product.id;
		}
	}

	const created = await createProduct({
		name: "Support for Anthers",
		// The Badge buys unlimited Public Access — a streamed audiovisual subscription,
		// per the posture's What Gets Taxed table. A Product has no line to code later,
		// so the code is stamped here where the Product is born.
		tax_code: STREAMED_SUBSCRIPTION_TAX_CODE,
		metadata: { anthers: "platform" },
	});
	if (!created) throw new Error("Stripe not configured");
	cachedAnthersProduct = created.id;
	return created.id;
}

/** What one subscription item is for — the user id of the account the line supports. */
export interface SupportItem {
	itemId: string;
	creatorId: number;
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
 * ⭐ **Every destination is a user id, Anthers' own line included** (the issuer pass,
 * 2026-10-04): the Anthers creator account is an ordinary issuer, so its line is stamped
 * with its user id exactly like a creator's — one vocabulary, no `null` destination, no
 * special case in `applyDirectedSupportFromSub`. An item still carrying the retired
 * `"anthers"` literal or a blank stamp is read as the Anthers account's line: no
 * subscription in any environment carries one (the stamp changed while the table was
 * empty), so this is a belt against a hand-authored Stripe object rather than a
 * migration path.
 */
export function itemsFromSub(sub: Stripe.Subscription, anthersId: number): SupportItem[] {
	return sub.items.data.map((item) => {
		const raw = item.metadata?.destination?.trim();
		// A blank stamp is UNSTAMPED, not account 0. `Number("")` is 0, which would credit
		// a real supporter's money to whichever account happens to hold user id 0.
		const parsed = !raw || raw === "anthers" ? anthersId : Number(raw);
		const unitCents = item.price?.unit_amount ?? 0;
		return {
			itemId: item.id,
			creatorId: Number.isFinite(parsed) && parsed > 0 ? parsed : anthersId,
			amount: (unitCents * Math.max(0, item.quantity ?? 1)) / 100,
		};
	});
}

/** Everything on the charge — Anthers' line and the creators' together. */
export function totalSupportFromSub(sub: Stripe.Subscription, anthersId: number): number {
	return itemsFromSub(sub, anthersId).reduce((sum, i) => sum + i.amount, 0);
}

/**
 * The monthly dollars pointed at **Anthers** — the Anthers line, which is the Badge's worth
 * and what sets the Time Pool.
 *
 * Reading the whole charge here would make a user who gives Anthers $3 and two creators
 * $7 and $2 look like a $12 Blossom funding $6 of Time Pool off a $3 gift — with no error
 * anywhere.
 *
 * The creators' amounts are deliberately unequal and deliberately not $3: a creator sets
 * their own Badge levels to any amount, and $3 is only ever the price of Public Access.
 */
export function anthersSupportFromSub(sub: Stripe.Subscription, anthersId: number): number {
	return itemsFromSub(sub, anthersId)
		.filter((i) => i.creatorId === anthersId)
		.reduce((sum, i) => sum + i.amount, 0);
}

/**
 * The monthly dollars on the charge pointed at creators rather than at Anthers.
 *
 * The Anthers line is an ordinary destination now (the issuer pass, 2026-10-04), so this
 * keeps its creator-only meaning by exclusion — the one place the Anthers account is still
 * named as such in the item model rather than as "just another destination".
 */
export function directedSupportFromSub(sub: Stripe.Subscription, anthersId: number): number {
	return itemsFromSub(sub, anthersId)
		.filter((i) => i.creatorId !== anthersId)
		.reduce((sum, i) => sum + i.amount, 0);
}

/**
 * The per-destination picks, read from the items themselves — every line is a pick now,
 * Anthers' own included.
 *
 * ⚠️ These used to travel in subscription **metadata**, applied on activation and then
 * cleared, because the amounts lived nowhere else — a quantity of a shared unit could not
 * say who each Seed was for. With one item per destination the picks ARE the subscription,
 * so there is no stamp to go stale, no clearing step, and no window in which Stripe and the
 * database disagree about who is being supported.
 */
export function directedPicksFromSub(
	sub: Stripe.Subscription,
	anthersId: number,
): { creatorId: number; amount: number }[] {
	return itemsFromSub(sub, anthersId)
		.filter((i) => i.amount > 0)
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
 * The Stripe Product a creator's line is billed against, created on first use, carrying the
 * tax code for what support for this creator buys.
 *
 * `price_data` on a subscription item takes a Product **id**, not a name — so without one
 * per creator every line on a supporter's invoice would carry the same label and the
 * itemized receipt would say nothing. This is the whole reason the N-item model needs a
 * column at all.
 *
 * Lazy rather than eager: a creator nobody supports needs no Product, and creating one at
 * signup would make registering an account depend on Stripe being reachable.
 *
 * 🚨 **The Product's tax code follows the creator's gates, and is RE-STAMPED when they
 * change.** A subscription item has no `tax_code` param — the code rides on the Product —
 * so a creator whose gate ladder appears or disappears changes what their support buys,
 * and the Product has to follow or every renewal after the change is taxed as the wrong
 * thing. `creatorProductTaxCode` reads the gate state; the update is best-effort so a
 * Stripe hiccup cannot cost a supporter their subscription change.
 */
export async function ensureCreatorProduct(creatorId: number, handle: string): Promise<string> {
	if (!paymentsConfigured()) throw new Error("Stripe not configured");
	const [acct] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, creatorId))
		.limit(1);
	const taxCode = await creatorProductTaxCode(creatorId);
	if (acct?.stripeProductId) {
		// The gate state may have moved since the Product was made; the code follows it.
		if (acct.stripeProductTaxCode !== taxCode) {
			await updateProduct(acct.stripeProductId, { tax_code: taxCode }).catch(() => null);
			await db
				.update(billingAccounts)
				.set({ stripeProductTaxCode: taxCode, updatedAt: new Date() })
				.where(eq(billingAccounts.userId, creatorId));
		}
		return acct.stripeProductId;
	}
	const product = await createProduct({
		name: `Support for @${handle}`,
		// What support for this creator buys, as a tax code — see `creatorProductTaxCode`.
		tax_code: taxCode,
		metadata: { creatorId: String(creatorId) },
	});
	if (!product) throw new Error("Stripe not configured");
	await db
		.update(billingAccounts)
		.set({ stripeProductId: product.id, stripeProductTaxCode: taxCode, updatedAt: new Date() })
		.where(eq(billingAccounts.userId, creatorId));
	return product.id;
}

/**
 * The product tax code a creator's support Product carries, per the posture's What Gets
 * Taxed table.
 *
 * A subscription item has no `tax_code` param — the code lives on the **Product** the
 * line's `price_data` names, so `ensureCreatorProduct` stamps it and this recomputes it
 * when a creator's gates change. A creator whose gate ladder exists is one whose support
 * opens gated Works — a streamed/downloaded subscription, `txcd_10402200` on the whole
 * line. A creator with no gates sells support that buys nothing at all, the cash-donation
 * code `txcd_90000001`, which Stripe Tax treats as a gratuity outside Colorado (PLR
 * 22-005's shape). The Anthers line's Product buys unlimited Public Access — also
 * `txcd_10402200`, stamped where that Product is provisioned.
 *
 * ⚠️ **Perk-tagging arrives with the Badge Maker and is not built yet.** A creator whose
 * support carries a service or a physical good will be coded from what its creator tagged
 * (`txcd_20030000` general services, `txcd_99999999` tangible goods, shipping on its own
 * line) — until the tagging exists, a gate ladder is the one honest discriminator, and a
 * rung carrying more than one kind of perk is taxed at its most-taxable kind only once
 * there is a kind to read.
 */
export async function creatorProductTaxCode(creatorId: number): Promise<string> {
	const [badge] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(eq(badges.creatorId, creatorId))
		.limit(1);
	return badge ? STREAMED_SUBSCRIPTION_TAX_CODE : DONATION_TAX_CODE;
}

/**
 * One subscription item per destination, priced inline.
 *
 * 🚨 **`metadata.destination` is not decoration — it is the only thing that says whose
 * money this line is.** `itemsFromSub` reads it back, and an unstamped item is credited to
 * Anthers. Adding a destination here without stamping it therefore routes a creator's
 * support into the Time Pool silently, which is the N-item shape of the hazard PR #223
 * paid for.
 *
 * 🚨 **`tax_behavior: "exclusive"` on every line, because US prices are tax-exclusive** —
 * the buyer's total varies with their location, which is the point of automatic tax, and a
 * line left unspecified blocks tax calculation when no default behavior is set in the
 * Stripe Tax settings. The tax code itself rides on the Product each line names, stamped
 * by `ensureCreatorProduct` and `ensureAnthersProduct`.
 */
export function supportItems(
	anthersProduct: string,
	anthersId: number,
	anthersDollars: number,
	directed: { creatorId: number; product: string; amount: number }[],
): Stripe.SubscriptionCreateParams.Item[] {
	const monthly = (product: string, dollars: number, destination: string) => ({
		price_data: {
			currency: "usd",
			product,
			unit_amount: Math.round(dollars * 100),
			recurring: { interval: "month" as const },
			tax_behavior: "exclusive" as const,
		},
		quantity: 1,
		metadata: { destination },
	});
	const items: Stripe.SubscriptionCreateParams.Item[] = [];
	if (anthersDollars > 0) items.push(monthly(anthersProduct, anthersDollars, String(anthersId)));
	for (const d of directed) {
		if (d.amount > 0) items.push(monthly(d.product, d.amount, String(d.creatorId)));
	}
	return items;
}

/** A destination's desired monthly amount, with the Product its line is billed against. */
export interface DesiredLine {
	/** The account the line supports — the Anthers creator account's id for its own line. */
	creatorId: number;
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
	started: { creatorId: number; amount: number }[];
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
	anthersId: number,
	anthersDollars: number,
	directed: { creatorId: number; product: string; amount: number }[],
): ItemChange {
	const key = (creatorId: number) => String(creatorId);

	const desired = new Map<string, DesiredLine>();
	if (anthersDollars > 0) {
		desired.set(key(anthersId), {
			creatorId: anthersId,
			product: anthersProduct,
			amount: anthersDollars,
		});
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
	for (const item of itemsFromSub(sub, anthersId)) {
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
			// Tax-exclusive, as at creation — see `supportItems`.
			tax_behavior: "exclusive" as const,
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
	if (!paymentsConfigured()) throw new Error("Stripe not configured");
	const [acct] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	if (acct?.stripeCustomerId) return acct.stripeCustomerId;
	const customer = await createCustomer({
		email: email || undefined,
		metadata: { userId: String(userId) },
	});
	if (!customer) throw new Error("Stripe not configured");
	// ⚠️ Upserts rather than updates. **A billing row is lazily created** — one appears on
	// the first billing write, whichever door that is — so a plain UPDATE affected nothing
	// for a user no billing door had touched yet, and this returned a customer id it had
	// not persisted. Adulthood verification is the caller for whom "never billed" is the
	// normal case.
	await db
		.insert(billingAccounts)
		.values({ userId, stripeCustomerId: customer.id })
		.onConflictDoUpdate({
			target: billingAccounts.userId,
			set: { stripeCustomerId: customer.id, updatedAt: new Date() },
		});
	return customer.id;
}

/** The customer's saved card, if one is on file (attached when a payment is confirmed). */
export async function savedCardFor(
	customerId: string,
): Promise<{ id: string; brand: string; last4: string } | null> {
	const pms = await listCardPaymentMethods({ customer: customerId, type: "card", limit: 1 });
	const pm = pms?.data[0];
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
 * Reconcile the billing row to a subscription's current state — called from the
 * webhook on customer.subscription.created/updated/deleted. A canceled or expired
 * subscription reverts the user to Free (no holdings this cycle that weren't paid for).
 *
 * 🚨 **Writes no amount anywhere.** The old accounts row carried two amount columns this
 * update used to rewrite; under the Badge model the amounts are `user_badges` holdings —
 * what the subscription's directed items buy is written by `applyDirectedSupportFromSub`
 * below, and what the Anthers line buys is resolved by reading the org-ladder holding at
 * whatever the ledger needs it for. What this function still owns is the Stripe machinery:
 * the subscription id, the period pair, activity and cancellation, plus the directed
 * balance the Badge picker draws against (`billing_accounts.directed_budget` — the
 * subscription's directed items ARE that balance, so the webhook is the writer that
 * knows it).
 */
export async function syncSubscriptionToAccount(sub: Stripe.Subscription): Promise<void> {
	const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
	const [acct] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.stripeCustomerId, customerId))
		.limit(1);
	if (!acct) return;

	// The Anthers creator account's id — the one destination this sync still names as
	// such (its own line is an ordinary destination; see `itemsFromSub`). Resolved once
	// here because the in-force comparisons and the snapshot need it.
	const anthersId = await anthersUserId();

	const gone = sub.status === "canceled" || sub.status === "incomplete_expired";
	if (gone) {
		// Ignore a stale subscription that isn't the account's current one.
		if (acct.stripeSubscriptionId && acct.stripeSubscriptionId !== sub.id) return;
		await db
			.update(billingAccounts)
			.set({
				stripeSubscriptionId: "",
				isActive: true,
				canceledAt: null,
				updatedAt: new Date(),
			})
			.where(eq(billingAccounts.id, acct.id));
		await lapseUnpaidMonth(acct.userId);
		return;
	}

	/**
	 * 🚨 **Retries exhausted: the benefits lapse** (Parker, 2026-09-14). A renewal that fails keeps
	 * the user's Badge and cleared gates through Stripe's retry window — `past_due` changes
	 * nothing here — and they end when Stripe gives up and marks the subscription unpaid. The
	 * subscription itself is kept, so paying what is owed makes it active again and the holdings
	 * are applied again from its items on the activation webhook.
	 */
	if (sub.status === "unpaid") {
		if (acct.stripeSubscriptionId && acct.stripeSubscriptionId !== sub.id) return;
		await db
			.update(billingAccounts)
			.set({
				isActive: false,
				directedBudget: "0.00",
				updatedAt: new Date(),
			})
			.where(eq(billingAccounts.id, acct.id));
		await lapseUnpaidMonth(acct.userId);
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
	 * already applies per creator with its add-only-upsert** — allocation is add-only within
	 * a cycle — rather than a new idea; what this column adds is the account-level half for
	 * the *budget*, which is the number the picker draws down against.
	 */
	/**
	 * 🚨 **The held-over Anthers amount is read off the HOLDING, not the items.** The
	 * in-force rule on a mid-cycle decrease lives on the badge holding now: the holding
	 * IS the account-level amount, so when the stored period says this decrease is still
	 * inside the cycle it was paid in, the existing holding is the "stored" figure —
	 * `applyAnthersBadgeHolding` takes the GREATER of the item price and the held rung,
	 * which keeps a Blossom somebody paid $12 for through the month the items already
	 * say $3. Once the period turns, the items are the whole truth and the holding is
	 * re-stamped outright.
	 */
	const heldOver =
		acct.currentPeriodStart != null &&
		periodStartUnix != null &&
		cycleKeyFor(acct.currentPeriodStart) === cycleKeyFor(new Date(periodStartUnix * 1000));
	const inForce = (fromSub: number, stored: string) =>
		heldOver ? Decimal.max(fromSub, stored) : new Decimal(fromSub);

	// The held Anthers badge's threshold — the "stored" half of the in-force comparison,
	// read from the Anthers-ladder holding rather than from a dead amount column.
	const heldAnthers = await heldAnthersBadgeAmountForSync(acct.userId);
	// The paid-for directed balance is what the subscription's directed items add up to,
	// held over the same way — a supporter who drops a creator on the 10th has already
	// paid that creator for the month. The stored figure participates only while the
	// period has not turned; past that the items are the whole truth.
	const directedTotal = inForce(
		directedSupportFromSub(sub, anthersId),
		// A stored read participates in the held-over guard only, same as the amount
		// columns this replaced; the budget rides the billing row, which is where the
		// picker reads it back.
		acct.directedBudget,
	);

	await db
		.update(billingAccounts)
		.set({
			stripeSubscriptionId: sub.id,
			isActive: active,
			...(periodStartUnix ? { currentPeriodStart: new Date(periodStartUnix * 1000) } : {}),
			...(periodEndUnix ? { currentPeriodEnd: new Date(periodEndUnix * 1000) } : {}),
			canceledAt: sub.cancel_at_period_end ? new Date() : null,
			updatedAt: new Date(),
		})
		.where(eq(billingAccounts.id, acct.id));

	if (active) {
		// ⚠️ The budget's held-over write needs `currentPeriodStart` to have been read BEFORE
		// the update above stamped the new period — ordering that matters, so the in-force
		// total goes through one more update that carries it.
		await db
			.update(billingAccounts)
			.set({ directedBudget: directedTotal.toFixed(2), updatedAt: new Date() })
			.where(eq(billingAccounts.id, acct.id));
		// The in-force Anthers figure — possibly the higher, held-over one — is what the
		// holding gets stamped with, and what the snapshot records for the cycle.
		const anthersInForce = inForce(
			anthersSupportFromSub(sub, anthersId),
			heldAnthers.toFixed(2),
		).toNumber();
		/**
		 * ⭐ **One apply for every destination, Anthers' own line included** (the issuer pass,
		 * 2026-10-04). The separate `applyAnthersBadgeHolding` dissolved into
		 * `applyDirectedSupport`: the Anthers line is stamped with the account's user
		 * id like every creator's, so the directed apply's find-or-create resolves its rung
		 * exactly as it resolves a creator's. The in-force rule rides in as a substitution —
		 * the Anthers pick's amount is the held-over figure when that is higher, so the
		 * add-only-upsert (which cannot lower within a cycle) receives the amount the
		 * holding should end at rather than the raw item price the items already moved off
		 * of. A $0 Anthers amount still means Free: the apply is skipped for zero-amount
		 * picks, and no holding is written for the new cycle — Free is the absence of a
		 * held rung, not a row at $0 (the 2026-10-03 reversal).
		 */
		const picks = directedPicksFromSub(sub, anthersId).map((pick) =>
			pick.creatorId === anthersId ? { ...pick, amount: anthersInForce } : pick,
		);
		await applyDirectedSupport(acct.userId, picks);
		// The cycle snapshot keeps its history columns — pass the numbers this run
		// computed; the columns are the record, never a read source for live state.
		await snapshotCycle(acct.userId, anthersInForce, directedTotal.toNumber());
	}
}

/**
 * The held Anthers rung's threshold, for the sync's own in-force comparison.
 *
 * A read, not a re-export: this returns 0 (rather than throwing) when no ladder is
 * seeded, because a sync against an unseeded database must proceed with amounts of zero
 * rather than fail the billing webhook — the loud failure belongs to the Anthers read at
 * resolve time, and seeding is a deployment step that this sync cannot perform.
 */
async function heldAnthersBadgeAmountForSync(userId: number): Promise<number> {
	let anthersId: number;
	try {
		anthersId = await anthersUserId();
	} catch {
		return 0;
	}
	const cycle = currentCycleKey();
	const [held] = await db
		.select({ held: sql<string>`COALESCE(MAX(${badges.threshold}), '0.00')` })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(
			and(
				eq(userBadges.userId, userId),
				eq(userBadges.billingCycle, cycle),
				sql`${badges.creatorId} = ${anthersId}`,
			),
		);
	return Number(held?.held ?? 0);
}

/**
 * Write (or clear) the user's holding on the org's ladder for what the Anthers line costs.
 *
 * ⭐ **The Anthers line is a Badge holding like any directed one.** Its threshold IS the
 * amount the old `accounts.anthers_support` column carried, so under the Badge model the
 * webhook's write is what makes the held Badge exist at all — every Anthers-side reader
 * (`heldAnthersBadgeAmount`, the Public Access meter, the Time Pool, the sticker
 * allowance) reads this holding.
 *
 * 🚨 **Replace, never stack, and $0 clears rather than seeds.** The picker's
 * one-holding-per-issuer-per-cycle rule applies to the org's ladder with special force: a
 * viewer moving $12 → $3 mid-cycle must read $3, and a cancel (the items carry no Anthers
 * line at all) must leave NO holding, because "free" under the Badge model is the absence
 * of a held rung, not a $0 row beside a paid one. The holding is find-or-create on the
 * org's ladder exactly as `applyDirectedSupportFromSub` resolves a creator's, so a ladder
 * re-seed cannot drop what was paid for. A $0 line (Free — nothing to hold) clears the
 * org's rungs and writes nothing.
 */
export async function applyAnthersBadgeHolding(
	userId: number,
	anthersDollars: number,
): Promise<void> {
	const org = await anthersUserId();
	const cycle = currentCycleKey();
	// The org's other rungs go first — replace-not-stack, and it clears the held rung on
	// a cancel, which is the whole of "reverts to Free".
	await db
		.delete(userBadges)
		.where(
			sql`${userBadges.userId} = ${userId} AND ${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${org})`,
		);
	if (anthersDollars <= 0) return;
	const threshold = new Decimal(anthersDollars).toFixed(2);
	let [badge] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, org), eq(badges.threshold, threshold)))
		.limit(1);
	if (!badge) {
		// Find-or-create, exactly as the directed path resolves a creator's rung: the
		// Anthers line is normally priced from the seeded ladder, but a subscription
		// predating a re-price can name a level the current seed doesn't carry, and a
		// missing row would silently drop a paid-for holding on a replayed webhook. The
		// row is created at the level the subscriber actually pays — the rung's label is
		// its amount, the same shape billing creates creator rungs with.
		[badge] = await db
			.insert(badges)
			.values({
				creatorId: org,
				threshold,
				label: `$${threshold}`,
				description: "A rung created by billing at a threshold a subscription pays for.",
			})
			.returning({ id: badges.id });
	}
	await db
		.insert(userBadges)
		.values({ userId, badgeId: badge.id, billingCycle: cycle })
		.onConflictDoUpdate({
			target: [userBadges.userId, userBadges.badgeId, userBadges.billingCycle],
			// Add-only within a cycle, same as the directed holdings: a replayed webhook
			// rewrites the same row rather than stacking a second one.
			set: { updatedAt: new Date() },
		});
}

/**
 * Take away the creator Badges this month's holdings cleared, unless the month was paid for.
 *
 * ⚠️ **The holdings are written before the renewal is collected.** The subscription moves to
 * the new month on the 1st, still active, a moment before its charge is attempted, so a renewal
 * that then fails has already cleared that month's gates. When the benefits lapse those have to
 * go. A month with a paid invoice keeps them: somebody who cancels partway through a month they
 * paid for still has it.
 */
async function lapseUnpaidMonth(userId: number): Promise<void> {
	const cycle = currentCycleKey();
	const [paid] = await db
		.select({ id: invoices.id })
		.from(invoices)
		.where(
			and(
				eq(invoices.userId, userId),
				eq(invoices.billingCycle, cycle),
				eq(invoices.status, "paid"),
			),
		)
		.limit(1);
	if (paid) return;
	await db
		.delete(userBadges)
		.where(and(eq(userBadges.userId, userId), eq(userBadges.billingCycle, cycle)));
}

/**
 * Write the Badge holdings the user is paying for this cycle.
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
 * ⭐ **Under the Badge model a pick names a Badge, not an amount.** An item's amount is the
 * threshold of the Badge its destination holds, so each pick is resolved to the issuer's
 * badge row at that threshold and the holding is written on that row. The resolution is
 * find-or-create: a creator may rename or re-price their ladder after the subscription was
 * taken out, and the supporter paid for a rung that exists at that dollar level — a missing
 * row at the threshold would silently drop a paid-for holding on a replayed webhook.
 *
 * Idempotent: the webhook can deliver the same event more than once, so each row is an
 * upsert keyed on (user, badge, cycle).
 */
export async function applyDirectedSupport(
	userId: number,
	picks: { creatorId: number; amount: number }[],
): Promise<void> {
	if (picks.length === 0) return;

	const cycle = currentCycleKey();
	for (const pick of picks) {
		// The threshold as stored on every money column: a two-decimal string, so the
		// lookup below matches the `numeric` column exactly rather than by float.
		const threshold = new Decimal(pick.amount).toFixed(2);
		// The issuer's Badge at this threshold — the rung the subscriber is paying for.
		// Find-or-create rather than find-only, for the reason above: the item carries
		// what was paid, and the holding must name a row that exists at that level.
		let [badge] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.creatorId, pick.creatorId), eq(badges.threshold, threshold)))
			.limit(1);
		if (!badge) {
			[badge] = await db
				.insert(badges)
				.values({
					creatorId: pick.creatorId,
					threshold,
					label: `$${threshold}`,
					description: "A rung created by billing at a threshold a subscription pays for.",
				})
				.returning({ id: badges.id });
		}
		// 🚨 **One holding per issuer per cycle — the pick REPLACES the issuer's other
		// rungs rather than sitting beside them**, the same rule the picker's POST
		// enforces and the one the dissolved Anthers special path carried. Without the
		// delete, a webhook after a re-price stacks the new rung beside the old one and
		// every MAX-reading surface reports the higher — a viewer who lowered from $12
		// to $3 would keep reading $12 the moment the cycle turned, with no error
		// anywhere. The unique key makes the re-delivered webhook idempotent; this makes
		// a *changed* subscription honest.
		await db
			.delete(userBadges)
			.where(
				and(
					eq(userBadges.userId, userId),
					eq(userBadges.billingCycle, cycle),
					ne(userBadges.badgeId, badge.id),
					sql`${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${pick.creatorId})`,
				),
			);
		await db
			.insert(userBadges)
			.values({ userId, badgeId: badge.id, billingCycle: cycle })
			.onConflictDoUpdate({
				target: [userBadges.userId, userBadges.badgeId, userBadges.billingCycle],
				// A holding is add-only within a cycle (20.03), so a replayed webhook never
				// walks back what the subscriber is paying for — the unique key already
				// makes the re-delivery a no-op, and the stamp exists to bump `updated_at`.
				set: { updatedAt: new Date() },
			});
	}
}
