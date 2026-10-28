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
import {
	accountCycles,
	badgePerks,
	badges,
	billingAccounts,
	invoices,
	userBadges,
	works,
} from "@anthers/db/schema";
import { mostTaxablePerkKind } from "@anthers/shared/badge-art";
import {
	currentCycleKey,
	cycleKeyFor,
	cycleStart,
	nextCycleKey,
} from "@anthers/shared/billing-cycle";
import { anthersSupportBreakdown } from "@anthers/shared/fees";
import { STREAMED_SUBSCRIPTION_TAX_CODE, SUPPORT_TAX_CODE } from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { and, eq, ne, sql } from "drizzle-orm";
import type Stripe from "stripe";
import {
	createCustomer,
	createProduct,
	createSubscription,
	listActiveProducts,
	listCardPaymentMethods,
	paymentsConfigured,
	retrieveCustomer,
	retrieveSubscription,
	updateCustomer,
	updateProduct,
	updateSubscription,
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
 * line. A creator with no gates sells support that buys nothing at all, the support code
 * `txcd_90000001`, which Stripe Tax treats as a gratuity outside Colorado (PLR 22-005's
 * shape). The Anthers line's Product buys unlimited Public Access — also
 * `txcd_10402200`, stamped where that Product is provisioned.
 *
 * ⭐ **Perk-tagging is live (the Badge Maker, 2026-10-07), and it discriminates PER RUNG
 * through `taxCodeForBadge`** — a rung's own subscription line names a Product stamped
 * with that rung's most-taxable perk kind (`ensureBadgeProduct`). This per-creator
 * function stays for the ladder-less discrimination it always answered: a creator with
 * any gate ladder is a streamed subscription for the lines that do not name a rung.
 */
export async function creatorProductTaxCode(creatorId: number): Promise<string> {
	const [badge] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(eq(badges.creatorId, creatorId))
		.limit(1);
	return badge ? STREAMED_SUBSCRIPTION_TAX_CODE : SUPPORT_TAX_CODE;
}

/**
 * One rung's tax code — the most-taxable thing the rung actually delivers, with access
 * IN the comparison rather than beneath it (Parker, 2026-10-07, exercising it on a real
 * creator account).
 *
 * 🚨 **A rung that opens a gate on ANY of the creator's Works delivers access, and the
 * streamed-subscription code enters the comparison on that fact alone** — gates are data
 * rather than a tag, so the rung cannot be talked out of it by mis-tagging, and a
 * "recognition" tag can never put a gratuity code on a line whose supporters genuinely
 * receive gated access (that was the understatement the tags-first draft allowed). The
 * ordering across the pool: a physical good, digital good, service or community tag
 * outranks access; access outranks the three kinds that share the support code; and a
 * rung with no gate and no tag codes as support. The gate read is over `works.access`
 * rows (a row with `allow: true` whose threshold the rung's dollar amount meets is a gate
 * it opens), which is the comparison `resolveAccessSync` itself makes, read in TypeScript
 * rather than re-derived as a jsonb predicate.
 */
export async function taxCodeForBadge(badgeId: number): Promise<string> {
	const [badge] = await db
		.select({ id: badges.id, creatorId: badges.creatorId, threshold: badges.threshold })
		.from(badges)
		.where(eq(badges.id, badgeId))
		.limit(1);
	if (!badge) return SUPPORT_TAX_CODE;
	const perkRows = await db
		.select({ kind: badgePerks.kind })
		.from(badgePerks)
		.where(eq(badgePerks.badgeId, badgeId));
	const tagged = mostTaxablePerkKind(perkRows.map((r) => r.kind));
	// No tagged perk: does this rung's dollar amount open any gate on the creator's own
	// Works? A gate row with `allow: true` whose threshold the rung meets is a gate it
	// opens — the comparison `resolveAccessSync` itself makes, read in TypeScript rather
	// than re-derived as a jsonb predicate.
	const rows = await db
		.select({ access: works.access })
		.from(works)
		.where(eq(works.creatorId, badge.creatorId));
	const held = Number(badge.threshold);
	const opensAGate = rows.some((r) =>
		(r.access ?? []).some((row) => row.allow && held >= row.threshold),
	);

	// 🚨 Access sits IN the most-taxable comparison, not beneath it (Parker, 2026-10-07,
	// who will exercise this on a real creator account): a tag that names a real delivery
	// outranks the access beside it, but a GRATUITY tag does not — access is a real
	// taxable delivery, and the three kinds that share the support code must never
	// understate a line whose supporters genuinely receive gated access.
	if (opensAGate) {
		if (tagged && tagged.taxCode !== SUPPORT_TAX_CODE) return tagged.taxCode;
		return STREAMED_SUBSCRIPTION_TAX_CODE;
	}
	return tagged ? tagged.taxCode : SUPPORT_TAX_CODE;
}

/**
 * The Stripe Product one creator Badge's subscription lines bill against, carrying that
 * rung's own tax code — created on first use, re-stamped when the rung's kinds change.
 *
 * ⚠️ Per-rung rather than per-creator, because two rungs of one ladder can be taxed
 * differently (one carries a physical good, one is pure support). {@link ensureCreatorProduct} stays
 * for anything that bills the creator without naming a rung.
 */
export async function ensureBadgeProduct(
	badgeId: number,
	badgeLabel: string,
	creatorHandle: string,
): Promise<string> {
	if (!paymentsConfigured()) throw new Error("Stripe not configured");
	const [row] = await db.select().from(badges).where(eq(badges.id, badgeId)).limit(1);
	if (!row) throw new Error("Badge not found");
	const taxCode = await taxCodeForBadge(badgeId);
	if (row.stripeProductId) {
		if (row.stripeProductTaxCode !== taxCode) {
			await updateProduct(row.stripeProductId, { tax_code: taxCode }).catch(() => null);
			await db
				.update(badges)
				.set({ stripeProductTaxCode: taxCode, updatedAt: new Date() })
				.where(eq(badges.id, badgeId));
		}
		return row.stripeProductId;
	}
	const product = await createProduct({
		// The label is the rung's own — this line buys THIS Badge, and the itemized
		// receipt should say so rather than restating the creator's name.
		name: `${badgeLabel} — a Badge from @${creatorHandle}`,
		tax_code: taxCode,
		metadata: { badgeId: String(badgeId) },
	});
	if (!product) throw new Error("Stripe not configured");
	await db
		.update(badges)
		.set({ stripeProductId: product.id, stripeProductTaxCode: taxCode, updatedAt: new Date() })
		.where(eq(badges.id, badgeId));
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

/**
 * The buyer's existing Stripe Customer id, if one is on file — the id checkout reuses
 * (`customer`) instead of letting checkout build a second one, and the check every
 * prefill path runs before deciding there is nothing saved.
 */
export async function stripeCustomerIdFor(userId: number): Promise<string | null> {
	const [acct] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	return acct?.stripeCustomerId || null;
}

/**
 * Stamp the Customer a completed checkout created or carried onto the buyer's billing
 * row, so one buyer resolves to one Customer whichever door first touched Stripe.
 *
 * 🚨 **Never overwrites an existing id.** The subscription Customer is settled by Billing
 * and everything a subscription does hangs off it; a checkout Customer linked here is the
 * *fill* for a buyer whose first money door was a purchase, and re-linking would orphan
 * that history. The id lands from the completed session — a `customer_creation:
 * "if_required"` session carries one only when Stripe created it, so the null case is the
 * ordinary opted-out buyer and is a no-op by construction.
 */
export async function linkCheckoutCustomer(
	userId: number,
	customerId: string | null,
): Promise<void> {
	if (!customerId) return;
	const [acct] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	if (acct?.stripeCustomerId) return;
	await db
		.insert(billingAccounts)
		.values({ userId, stripeCustomerId: customerId })
		.onConflictDoUpdate({
			target: billingAccounts.userId,
			set: { stripeCustomerId: customerId, updatedAt: new Date() },
		});
}

/** The customer's saved card, if one is on file (attached when a payment is confirmed). */
export async function savedCardFor(
	customerId: string,
): Promise<{ id: string; brand: string; last4: string } | null> {
	const pms = await listCardPaymentMethods({ customer: customerId, type: "card", limit: 1 });
	const pm = pms?.data[0];
	return pm?.card ? { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 } : null;
}

/**
 * A buyer's **saved billing address** — the one opt-in address the 2026-10-11 decision
 * offers, and the only address Anthers stores nowhere: the address lives on the buyer's
 * Stripe Customer (`address`), the name that goes with it on the Customer's own `name`
 * field (`Stripe.Address` carries neither name nor anywhere else usable — that is what
 * its shape costs us, and the two are saved and cleared together), and this module
 * carries only the existing `stripeCustomerId`. No cache. The shape mirrors what the
 * purchase surfaces collect (an `UsAddressInput` less the country, which is US by
 * construction); `line2` is null when the buyer left it empty rather than a whitespace
 * string.
 */
export interface SavedBillingAddress {
	name: string;
	line1: string;
	line2: string | null;
	city: string;
	state: string;
	postalCode: string;
}

/**
 * Read the buyer's saved billing address, or null when nothing is saved — which is also
 * the reading for a buyer with no billing row at all, the ordinary case under
 * `customer_creation: "if_required"`. The client prefills checkout from this same shape;
 * an address Stripe holds for a non-US country is reported as nothing rather than
 * prefilling something the purchase surfaces would refuse.
 */
export async function savedBillingAddress(userId: number): Promise<SavedBillingAddress | null> {
	if (!paymentsConfigured()) return null;
	const [acct] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	if (!acct?.stripeCustomerId) return null;
	const customer = await retrieveCustomer(acct.stripeCustomerId);
	if (!customer || customer.deleted) return null;
	const address = customer.address;
	// The country check doubles as the null check (an optional chain): anything that is
	// not an address with a US country is exactly "nothing saved".
	if (address?.country !== "US" || !address.line1) return null;
	return {
		name: customer.name ?? "",
		line1: address.line1,
		line2: address.line2 ?? null,
		city: address.city ?? "",
		state: address.state ?? "",
		postalCode: address.postal_code ?? "",
	};
}

/**
 * Save (or replace) the buyer's billing address on their Stripe Customer — creating the
 * row and the Customer on first save through `ensureStripeCustomer`. This route is the
 * ONLY write of an address for reuse; checkout never writes to it, and nothing is
 * persistent for a buyer who has never come here.
 */
export async function saveBillingAddress(
	userId: number,
	email: string,
	address: SavedBillingAddress,
): Promise<SavedBillingAddress> {
	const customerId = await ensureStripeCustomer(userId, email);
	const updated = await updateCustomer(customerId, {
		name: address.name,
		address: {
			line1: address.line1,
			...(address.line2 ? { line2: address.line2 } : {}),
			city: address.city,
			state: address.state,
			postal_code: address.postalCode,
			country: "US",
		},
	});
	const saved = updated?.address;
	if (!updated || !saved?.line1) throw new Error("Stripe not configured");
	return {
		name: updated.name ?? address.name,
		line1: saved.line1,
		line2: saved.line2 ?? null,
		city: saved.city ?? address.city,
		state: saved.state ?? address.state,
		postalCode: saved.postal_code ?? address.postalCode,
	};
}

/**
 * Clear the buyer's saved billing address — the settings surface's "clear" button and,
 * through `eraseAccount`, the account-deletion wipe. A buyer with no billing row has
 * nothing to clear (`"none"`, not `"failed"`): the settings card reflects a saved state
 * that can legitimately be empty. `"failed"` is the one signal deletion defers on.
 */
export async function clearSavedBillingAddress(
	userId: number,
): Promise<"cleared" | "none" | "failed"> {
	if (!paymentsConfigured()) return "none";
	const [acct] = await db
		.select({ stripeCustomerId: billingAccounts.stripeCustomerId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	if (!acct?.stripeCustomerId) return "none";
	try {
		await updateCustomer(acct.stripeCustomerId, {
			// 🚨 `""` on an Emptyable param is this SDK's spelling of a JSON null — the
			// unset Stripe itself documents to clear the field — not a saved empty value.
			name: "",
			address: "",
		});
		return "cleared";
	} catch {
		return "failed";
	}
}

/**
 * Reconcile the billing row to a subscription's current state — called from the
 * webhook on customer.subscription.created/updated/deleted. A canceled or expired
 * subscription reverts the user to Free (no holdings this cycle that weren't paid for).
 *
 * 🚨 **Writes no amount anywhere.** The old accounts row carried two amount columns this
 * update used to rewrite; under the Badge model the amounts are `user_badges` holdings —
 * what the subscription's directed items buy is written by `applyDirectedSupportFromSub`
 * below, and what the Anthers line buys is resolved by reading the Anthers-ladder
 * holding at whatever the ledger needs it for. What this function still owns is the
 * Stripe machinery: the subscription id, the period pair, activity and cancellation.
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
	 * therefore genuinely in force today.
	 *
	 * 🚨 **The held-over Anthers amount is read off the HOLDING, not the items.** The
	 * in-force rule on a mid-cycle decrease lives on the badge holding now: the holding
	 * IS the account-level amount, so when the stored period says this decrease is still
	 * inside the cycle it was paid in, the existing holding is the "stored" figure —
	 * the unified apply takes the GREATER of the item price and the held rung for the
	 * Anthers pick, which keeps a Blossom somebody paid $12 for through the month the
	 * items already say $3. Once the period turns, the items are the whole truth and the
	 * holding is re-stamped outright.
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
		// computed; the columns are the record, never a read source for live state. The
		// creator total is the raw item sum here: a mid-cycle decrease's held-over
		// protection lives on the holdings, and settlement later records what the
		// cycle's charges actually directed.
		await snapshotCycle(acct.userId, anthersInForce, directedSupportFromSub(sub, anthersId));
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

	// The Anthers creator account — the ladder the follow rule does not reach (below).
	const anthersId = await anthersUserId();
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
		// rungs rather than sitting beside them**, the rule the dissolved picker's POST
		// carried and the one the dissolved Anthers special path carried. Without the
		// delete, a webhook after a re-price stacks the new rung beside the old one and
		// every MAX-reading surface reports the higher — a user who lowered from $12
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
		// ⭐ **Subscribing to a creator's Badge follows the creator** (Parker, 2026-10-11) —
		// the automatic consequence of the act, and the reasoning lives in
		// `services/follows.ts`'s docblock. The Anthers ladder is not a creator pick —
		// money on it is the subscription's Anthers line — so holding a rung on Anthers'
		// own Badges never follows anything, and anything else here is a creator the
		// subscriber has just decided to support. `ensureFollow` is idempotent, so a
		// replayed webhook makes nothing of the repeat, and the refused cases (a block,
		// an ungranted repository) are silent to this door: the holding is the act, the
		// follow rides along when it can. A cancellation never walks this back — see the
		// docblock.
		//
		// 🚨 **The follow service is imported lazily, and that is load-bearing.** A static
		// import of `./follows.js` closed an import-time cycle: this module is evaluated
		// deep inside the identity chain (`atproto-repo → atproto-records → access →
		// content-preferences → here`), and `follows`' own imports reach back through the
		// record writers into `atproto-client`, whose module body then ran while
		// `atproto-repo` was still mid-initialization — a `WORK_COLLECTION` TDZ that killed
		// `db:seed` and `db:media-fixture` outright. The lazy import keeps this module's
		// evaluation free of the follow ceremony; by the time any pick is applied, the
		// graph is fully loaded and the import resolves from cache.
		if (pick.creatorId !== anthersId) {
			const { ensureFollow } = await import("./follows.js");
			await ensureFollow(userId, pick.creatorId);
		}
	}
}

/**
 * The recurrence half of a Badge purchase: add or raise the issuer's line on the buyer's
 * support subscription **without charging today**.
 *
 * A checkout already carried the first transaction — the charge half of the raise this
 * line replaces. So the line is moved under `proration_behavior: "none"` (Stripe bills it
 * with the next renewal, which is the 1st for every account), and the caller records the
 * day-exact reduction (`recordReductions`, the same lines a raise through the
 * subscription would record) — the mid-month posture of `21.02` arrives through two rails
 * instead of one, and the arithmetic a normal raise produces is what the buyer gets.
 *
 * 🚨 **One update for every pick on the charge, and every line stamped.** A basket can
 * carry Badges from several creators, and `proration_behavior` — like the raise/drop
 * split `planItemChange` argues — is one setting for a whole call, so the lines travel
 * together. Every line carries `metadata.destination` (the stamp `itemsFromSub` reads
 * back); a badge-created line missing it would credit its money to Anthers.
 *
 * ⚠️ **A buyer with no subscription gets one, anchored on the next 1st** — the only shape
 * a post-checkout creation can take that does not charge today: the checkout already
 * carried the first Month, an invoice today would double-charge it, and an invoice whose
 * renewal is the next 1st is what "recurring at the rung" means. The buyer's saved card
 * (the checkout's `setup_future_usage` save, linked by the completion before this runs)
 * rides as `default_payment_method`, so the anchor's first invoice can bill off-session;
 * without one (the probe's fallback), the renewal fails the honest way — Stripe retries,
 * the account lapses visibly, Manage Billing fixes it.
 *
 * ⚠️ **A subscription whose renewal has failed is left alone** (logged, lines skipped) —
 * the checkout refuses a Badge ride on exactly that precondition, so reaching here means
 * the window between checkout and completion closed it; the holding still lands (the
 * money cleared), and the paid-card remedy is what makes the line join on a later pass.
 * A buyer who canceled at period end but is still active has the cancellation cleared:
 * they just paid a Badge, which is the opposite of intending to cancel.
 *
 * `pmId` is the confirmed payment method from the charge, when one was saved for the
 * recurrence — the no-subscription creation is the only consumer.
 */
export async function applyBadgeRecurrence(
	userId: number,
	picks: { issuerId: number; product: string; threshold: number }[],
	pmId: string | null,
): Promise<void> {
	if (picks.length === 0) return;
	if (!paymentsConfigured()) return;

	const anthersId = await anthersUserId();
	const lineOf = (pick: { issuerId: number; product: string; threshold: number }) => ({
		price_data: {
			currency: "usd",
			product: pick.product,
			unit_amount: Math.round(pick.threshold * 100),
			recurring: { interval: "month" as const },
			// Tax-exclusive as everywhere — see `supportItems`.
			tax_behavior: "exclusive" as const,
		},
		quantity: 1,
		// 🚨 The destination stamp — the only thing that says whose money this line is.
		metadata: { destination: String(pick.issuerId) },
	});

	const [acct] = await db
		.select()
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	const sub = acct?.stripeSubscriptionId
		? await retrieveSubscription(acct.stripeSubscriptionId)
		: null;

	if (sub && (sub.status === "active" || sub.status === "trialing")) {
		// One item per pick: an existing line at this destination is updated in place (its
		// amount becomes the rung's threshold — the raise) and a missing one is added.
		const existing = new Map(itemsFromSub(sub, anthersId).map((i) => [String(i.creatorId), i]));
		const changeItems = picks.map((pick) => {
			const have = existing.get(String(pick.issuerId));
			return {
				...(have ? { id: have.itemId } : {}),
				...lineOf(pick),
			};
		});
		// 🚨 Stripe does not charge a line added or changed under `proration_behavior:
		// "none"` until the next invoice — the whole shape of this function. The PROBE list
		// (the build plan) confirms the added-line half of that in test mode before ship.
		await updateSubscription(sub.id, {
			items: changeItems,
			proration_behavior: "none",
			cancel_at_period_end: false,
			automatic_tax: { enabled: true },
			metadata: { ...sub.metadata, userId: String(userId) },
		});
		return;
	}

	if (sub) {
		// past_due, unpaid, or otherwise uncollectable — logged and left; see above.
		console.error(
			`badge recurrence skipped: user ${userId}'s subscription ${sub.id} is ${sub.status} — the buyer owns the remedy`,
		);
		return;
	}

	// No subscription: create one whose first billing lands on the next 1st, charging
	// nothing today.
	//
	// ⚠️ **PROBED 2026-10-15, and the anchor shape did not survive the probe.** A
	// `billing_cycle_anchor` on the next 1st attempts a PRORATION STUB charge today
	// (creation → anchor, ~$3.10 on a $6 rung, left `open` by `default_incomplete` —
	// but the subscription itself sat in `incomplete`, and the stub was a second charge
	// on top of the first Month the checkout already carried). The shape that gives
	// "no charge today, the full rung on the next 1st" is a TRIAL ending there: the
	// creation invoices $0 immediately (a bookkeeping row, never attempted), the
	// subscription is `trialing` until the 1st, and the first real invoice — drafted at
	// the trial's end with the FULL rung, reason `subscription_cycle`, covered by the
	// day-exact reduction the caller recorded — is an ordinary renewal that auto-bills
	// the saved card and lapses honestly when it fails.
	const customerId = await ensureStripeCustomer(userId, "");
	const trialEnd = Math.floor(cycleStart(nextCycleKey(currentCycleKey())).getTime() / 1000);
	await createSubscription({
		customer: customerId,
		items: picks.map(lineOf),
		automatic_tax: { enabled: true },
		trial_end: trialEnd,
		// The saved card rides as the subscription's default payment method, so the
		// trial's first invoice can bill off-session; without one (the save offered
		// none), the renewal fails the honest way — Stripe retries, the account lapses
		// visibly, Manage Billing fixes it.
		...(pmId ? { default_payment_method: pmId } : {}),
		metadata: { userId: String(userId) },
	});
}
