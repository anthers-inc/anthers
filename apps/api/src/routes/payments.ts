// SPDX-License-Identifier: Apache-2.0
/**
 * Payment routes — Stripe Connect onboarding, checkout, purchases, charitable ledger.
 *
 * ⚠️ **No payment operation is a direct SDK call.** This route goes through
 * `lib/processor.ts`, the processor boundary — see that module's header for why the
 * vendor must stay swappable and why every new payment operation belongs there rather
 * than here as `stripe.<resource>.<op>`.
 *
 * Direct purchases run as **platform charges with a per-creator split at completion**
 * (Parker, 2026-10-15, the multi-creator basket decision) — a Checkout Session in
 * elements mode with automatic tax, charged to the platform; then each distinct creator's
 * share moves out as one transfer funded by the charge (`services/purchase-split.ts` is
 * the one writer of that half). The destination-charge shape this replaces pinned one
 * creator's transfer inside the charge (`transfer_data[amount]`), which named exactly one
 * connected account — the constraint that forced the one-creator basket, removed rather
 * than accepted; the counsel brief's "A basket spanning two creators" decision record
 * (Internal Wiki doc 26) carries the reasoning, the precedent and the accepted cost.
 * Since 2026-08-03 the listed price IS the advertised price: card processing comes
 * **out of** it, and sales tax is the only thing added on top — resolved by Stripe Tax
 * from the buyer's billing address at the session, per the product tax code each line
 * carries (the posture's What Gets Taxed table). The tax lands on the platform side by
 * construction, because Anthers is the marketplace facilitator and the liability. Anthers
 * keeps $0. A creator with no connected account is a hard 409, not a platform-held
 * fallback.
 *
 * A digital sale also carried the first download's bandwidth at cost until
 * 2026-08-12. Delivery is free on R2, so `deliveryFee` is now always $0.00 and every
 * download of a purchased Work is included forever, on any number of devices.
 */

import { db } from "@anthers/db/client";
import {
	badgeCharges,
	badges,
	billingAccounts,
	disputes,
	invoices,
	purchases,
	stripeAccounts,
	userBadges,
	users,
	works,
} from "@anthers/db/schema";
import { currentCycleKey, cycleEnd, cycleStart } from "@anthers/shared/billing-cycle";
import { isChargeableAmount, MAX_BASKET_ITEMS, REFUND_AUTO_CAP } from "@anthers/shared/constants";
import { calculateFees } from "@anthers/shared/fees";
import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import type { WorkType } from "@anthers/shared/tax-codes";
import { purchaseTaxCode, SHIPPING_TAX_CODE } from "@anthers/shared/tax-codes";
import { zValidator } from "@hono/zod-validator";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { z } from "zod";
import {
	createAccountLoginLink,
	createAccountOnboardingLink,
	createCheckoutSession,
	createConnectAccount,
	expireCheckoutSession,
	listCheckoutSessions,
	listRefundsForCharge,
	paymentsConfigured,
	retrieveCheckoutSession,
	retrieveConnectAccount,
	retrieveConnectBalance,
	retrieveSubscription,
	verifyWebhookSignature,
} from "../lib/processor.js";
import { getOptionalUserId, requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";
import { oweAccessReceipt } from "../services/access-receipts.js";
import { anthersUserId } from "../services/anthers-badges.js";
import {
	addBasketBadge,
	addBasketItem,
	clearBasket,
	clearPurchasedBasketItems,
	listBasket,
	removeBasketBadge,
	removeBasketItem,
	updateBasketItem,
} from "../services/basket.js";
import {
	applyBadgeRecurrence,
	applyDirectedSupport,
	ensureBadgeProduct,
	ensureCreatorProduct,
	linkCheckoutCustomer,
	savedBillingAddress,
	stripeCustomerIdFor,
	syncSubscriptionToAccount,
} from "../services/billing.js";
import { recordDisputeClosed, recordDisputeCreated } from "../services/disputes.js";
import { markInvoiceMoneyReturned, recordPaidInvoice } from "../services/invoices.js";
import { saveOnPurchase } from "../services/library.js";
import { recordNettingForDispute, reverseNettingForWonDispute } from "../services/netting.js";
import { stripeFlagPatchFromAccount } from "../services/payouts.js";
import {
	type BuyerListing,
	physicalStorefront,
	quotePhysicalTax,
	resolvePhysicalSale,
} from "../services/physical-sales.js";
import { releaseStock, reserveStock } from "../services/physical-stock.js";
import { splitChargeToCreators } from "../services/purchase-split.js";
import {
	sendPurchaseReceipts,
	sendRefundReceipts,
	sendSupportReceipt,
} from "../services/receipts.js";
import {
	refundPurchase,
	refundsAfterDownloadInWindow,
	reverseCreatorShare,
	settleRefundedPurchase,
} from "../services/refunds.js";
import { clampHandlingDays, createShipmentForPurchase } from "../services/shipments.js";
import { addTopUpToInvoice } from "../services/storage-topup.js";
import { applyReductionsToInvoice, recordReductions } from "../services/support-reductions.js";

/**
 * Shared purchase resolution for checkout and quote: find the Work, confirm it's
 * purchasable by this user, and compute the fee breakdown — so both endpoints
 * quote identical numbers. Returns an error shape (with an HTTP status) or the
 * resolved Work + amount + fees.
 *
 * A purchase names a **Work**, because a Work is what carries the gate and what a
 * permanent unlock has to be permanent *about*. Buying "a post" never quite made sense
 * once one Work could sit behind several posts at different prices.
 */
async function resolvePurchase(slug: string, userId: number) {
	const [work] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
	if (!work) return { ok: false as const, status: 404 as const, error: "Work not found" };

	// A private Work isn't on sale — it hasn't been released to anyone yet.
	if (work.visibility !== "released" && work.creatorId !== userId)
		return { ok: false as const, status: 404 as const, error: "Work not found" };

	// resolveAccess is the source of truth: owner / free / entitled / already-purchased
	// all mean "nothing to buy"; a hard gate with no price path isn't purchasable.
	const access = await resolveAccess(work, userId);
	if (access.canAccess)
		return {
			ok: false as const,
			status: 400 as const,
			error: "You already have access to this work",
		};

	// 🚨 **A physical or service Work is refused at checkout, because nothing fulfills
	// it — and the goods-works rule prices them here as null, so this refusal has to
	// come BEFORE the priced-row checks.** There is no shipping lane and no
	// fulfillment mechanism behind either type. This is the posture's refusal rather
	// than a judgment about the kinds: selling them arrives when the fulfillment
	// behind them arrives, and until then checkout is the one door that has to say no.
	if (work.type === "physical" || work.type === "service")
		return {
			ok: false as const,
			status: 400 as const,
			error: "This kind of work can't be bought yet — there's nothing to deliver it.",
		};

	if (!access.requiresPurchase || !access.price)
		return {
			ok: false as const,
			status: 400 as const,
			error: "This work is not available for direct purchase",
		};

	const amount = new Decimal(access.price);
	if (amount.lte(0))
		return { ok: false as const, status: 400 as const, error: "This work is free" };

	// 🚨 **A price the processor will not accept, caught here rather than at Stripe.** The
	// validators refuse a sub-floor price on the way in, but a Work priced before that
	// shipped is still a row in the database — and without this the failure surfaces as a
	// PaymentIntent error at checkout, to the buyer, about somebody else's pricing. Nothing
	// rewrites the creator's number: raising a price on their behalf is not ours to do, and
	// the next edit of that Work is refused with the same sentence.
	if (!isChargeableAmount(amount.toNumber()))
		return {
			ok: false as const,
			status: 409 as const,
			// Says what is true and nothing more. Nothing here notifies the creator, so the
			// message must not imply that anything has — a sentence that invents a
			// notification is a worse defect than the price it is explaining.
			error:
				"This work is priced below what a card payment can process, so it can't be bought right now. Only the creator can change that.",
		};

	// All-in list price: card processing comes OUT of the price, sales tax is added on
	// top, and Anthers keeps $0 (the purchase fee was removed 2026-08-03, the delivery
	// charge 2026-08-12 — so the Work's asset size no longer enters the arithmetic at
	// all). `calculateFees` owns it — never restate it at a call site.
	const fees = calculateFees(amount, { type: "digital" });
	return { ok: true as const, work, amount, fees };
}

/**
 * The Badge purchase resolution — the same job `resolvePurchase` does for a Work, for the
 * rung a buyer picked: confirm it may be held by this buyer, and pin the money.
 *
 * 🚨 **A Badge is a purchase like any other, and its first transaction prices like the
 * raise it is** (Parker, 2026-10-14/15). What the buyer already give this issuer this
 * cycle is the raise's base read off the HOLDING — the in-force truth the activation
 * webhook keeps — so:
 *
 * - holding none → the first transaction charges the rung's full threshold;
 * - holding a lower rung → it charges the DELTA (threshold − held), the amount a request
 *   through the subscription would have raised the line by, and `recordReductions`
 *   credits the same missed-days figure at the renewal;
 * - holding that threshold or higher → nothing to buy (the ratchet), refused here rather
 *   than quoted at zero, because a zero delta is not a discount, it is a no-op.
 *
 * One ladder per basket line and one line per ladder are the basket service's rules; the
 * money refusals are all here, at the door where they are honest. ⚠️ The Stripe-side
 * half — the rung's Product — is priced only when the caller will build a session
 * (`needsProduct`): a quote names prices the database knows, so a quote stays free of
 * processor calls the same way a Work's quote always was.
 */
async function resolveBadgePurchase(
	badgeId: number,
	userId: number,
	opts?: { atCheckout?: boolean; needsProduct?: boolean },
) {
	const [badge] = await db.select().from(badges).where(eq(badges.id, badgeId)).limit(1);
	if (!badge) return { ok: false as const, status: 404 as const, error: "Badge not found" };

	// 🚨 Nobody holds their own Badge — the same refusal every holding door answers.
	if (badge.creatorId === userId)
		return { ok: false as const, status: 400 as const, error: "You cannot hold your own Badge" };

	// The issuer the support is directed at, with the handle the receipt and the basket
	// page name — reachable only through the badge until it is read here.
	const [issuer] = await db
		.select({ id: users.id, handle: users.atprotoHandle })
		.from(users)
		.where(eq(users.id, badge.creatorId))
		.limit(1);
	if (!issuer) return { ok: false as const, status: 404 as const, error: "Badge not found" };

	// What the buyer already gives this issuer this cycle — MAX over the holdings, the
	// same read the sync uses for its in-force comparisons, for the same reason: several
	// rows would only ever mean the ratchet's climb, and the largest rung is the truth.
	const [heldRow] = await db
		.select({ held: sql<string>`COALESCE(MAX(${badges.threshold}), '0.00')` })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(
			and(
				eq(userBadges.userId, userId),
				eq(userBadges.billingCycle, currentCycleKey()),
				eq(badges.creatorId, badge.creatorId),
			),
		);
	const held = new Decimal(heldRow?.held ?? "0.00");

	const threshold = new Decimal(badge.threshold);
	// 🚨 The ratchet at the money door: a rung at or below what the buyer holds is not a
	// purchase, it is a no-op — refusing reads much truer than quoting a $0.00 line.
	if (threshold.lte(held))
		return {
			ok: false as const,
			status: 400 as const,
			error: "You already hold this rung or higher from this creator.",
		};
	const amount = threshold.minus(held);

	// 🚨 A price the processor will not accept — the same catch `resolvePurchase` keeps for
	// a Work, for the same reasons: the refusal surfaces where the buyer can read it, names
	// what is true and nothing more, and nothing rewrites the creator's number.
	if (!isChargeableAmount(amount.toNumber()))
		return {
			ok: false as const,
			status: 409 as const,
			error:
				"This Badge's upgrade is priced below what a card payment can process, so it can't be bought right now. Only the creator can change that.",
		};

	// 🚨 A buyer whose subscription renewal has failed is refused, never sold to: the
	// recurrence could not bill either. The same refusal the support-change path answers
	// with, and the same remedy (pay what is owed in Manage Billing). The Stripe read is
	// the checkout's job — `atCheckout` gates it, so a quote stays free of processor calls.
	if (opts?.atCheckout) {
		const [acct] = await db
			.select({ stripeSubscriptionId: billingAccounts.stripeSubscriptionId })
			.from(billingAccounts)
			.where(eq(billingAccounts.userId, userId))
			.limit(1);
		if (acct?.stripeSubscriptionId) {
			const sub = await retrieveSubscription(acct.stripeSubscriptionId);
			if (sub && (sub.status === "past_due" || sub.status === "unpaid")) {
				return {
					ok: false as const,
					status: 409 as const,
					code: "payment_past_due" as const,
					error:
						"Your last payment didn't go through. Update your card in Manage Billing, and you can change your support once it has.",
				};
			}
		}
	}

	// The Stripe Product the first-transaction line and the recurrence both bill against
	// — the rung's own, created on first use, carrying the rung's own tax code (the
	// most-taxable thing the rung delivers). One Product per rung, re-stamped when the
	// rung's kinds change — `ensureBadgeProduct` owns all of that. A quote skips it:
	// pricing the line is the database's read, not the processor's.
	const product =
		opts?.needsProduct === false
			? null
			: await ensureBadgeProduct(badgeId, badge.label, issuer.handle);

	return { ok: true as const, badge, issuer, held, threshold, amount, product };
}

/** One resolved line of a basket, in the order the buyer built it. */
type ResolvedLine =
	| {
			kind: "work";
			/** The full Work row, as the single-purchase path resolves it. */
			work: typeof works.$inferSelect;
			/** The goods money on this line — the unit price already multiplied out. */
			amount: Decimal;
			/** This line's share of the charge's ONE card fee — pro-rata, last line absorbs. */
			lineFee: Decimal;
			/**
			 * A physical good's pick and its shipping. Absent for every digital Work,
			 * which is why the type carries it rather than every line growing four null
			 * columns: only a good has a count, choices and a parcel.
			 */
			physical?: {
				listing: BuyerListing;
				picks: Array<{ name: string; label: string }>;
				quantity: number;
				/** The listing's flat shipping. Charged once per creator — see `shippingFor`. */
				shipping: Decimal;
				/** What this line was charged for shipping; zero unless it carries the creator's. */
				shippingOnLine: Decimal;
				taxCategory: string;
				handlingBusinessDays: number;
			};
	  }
	| {
			kind: "badge";
			badge: {
				id: number;
				creatorId: number;
				threshold: string;
				label: string | null;
			};
			issuer: { id: number; handle: string | null };
			/** What the buyer already holds from this issuer this cycle, as a money string. */
			held: Decimal;
			threshold: Decimal;
			amount: Decimal;
			/** The rung's Stripe Product, when the resolution priced one — a quote's is null. */
			product: string | null;
			lineFee: Decimal;
	  };

/**
 * The same resolution for a **basket** of items bought on one charge — Works and Badge
 * first transactions alike.
 *
 * 🚨 **A basket carries any number of creators, settled as one platform charge plus one
 * transfer per creator at completion** (Parker, 2026-10-15). The one-creator rule this
 * function used to enforce — `mixed_creators` — existed because a Stripe **destination
 * charge** names exactly one connected account in `transfer_data`, so a basket spanning
 * two creators could not be a single destination charge. The split decision removed that
 * constraint rather than accepting it: the charge is made to the platform and the money
 * moves out per creator on the charge's completion (`completeSessionPurchases` below,
 * funded by the charge), which is the same merchant-of-record posture monthly support
 * already runs — the counsel brief's "A basket spanning two creators" decision record
 * carries the reasoning and the accepted cost.
 *
 * **Badge lines ride the same charge and settle by a different rail** (2026-10-15): a
 * Badge's money never transfers at completion — support settles through the cycle
 * distribution (`settle-cycle.ts` reads `badge_charges` alongside the invoices) — so
 * `creatorIds` below means "whose money is on the charge", of which the purchase split
 * moves only the Works' shares. An issuer whose connected account cannot take a payout is
 * refused here exactly as a Work's creator is, Anthers' own ladder excepted (its money
 * already sits on the platform balance by construction; there is nowhere for a transfer
 * to go).
 */
/** One stored basket line, as the buyer built it — a Work or a Badge rung. */
export type StoredBasketRow =
	| {
			kind: "work";
			workId: number;
			slug: string;
			/** A physical line's count and chosen values; absent for every digital Work. */
			quantity?: number;
			options?: Array<{ name: string; label: string }> | null;
	  }
	| { kind: "badge"; badgeId: number };

async function resolveStoredBasket(
	rows: StoredBasketRow[],
	userId: number,
	opts?: { atCheckout?: boolean; needsProduct?: boolean },
): Promise<
	| { ok: false; status: 400 | 404 | 409; error: string; code?: string; itemId?: number | string }
	| {
			ok: true;
			items: ResolvedLine[];
			subtotal: Decimal;
			fees: ReturnType<typeof calculateFees>;
			/** Every issuer's id the charge covers — Works' creators and Badge issuers alike. */
			creatorIds: (number | null)[];
	  }
> {
	// Deduplicated by identity: adding the same Work or rung twice is one line (the adds
	// already no-op on duplicates; this is the same defense at this door).
	const deduped: StoredBasketRow[] = Object.values(
		rows.reduce<Record<string, StoredBasketRow>>((acc, row) => {
			acc[row.kind === "work" ? `w${row.workId}` : `b${row.badgeId}`] = row;
			return acc;
		}, {}),
	);
	if (deduped.length === 0) return { ok: false, status: 400, error: "Your basket is empty" };
	if (deduped.length > MAX_BASKET_ITEMS)
		return {
			ok: false,
			status: 400,
			error: `A basket holds at most ${MAX_BASKET_ITEMS} items`,
		};

	// Resolved per item, in the order the buyer built the basket — the line fee shares
	// below are pinned in this order, and the receipt reads in it. The basket changes who
	// pays the flat fee, never who may buy what.
	// The items list with line shares assigned by the apportionment pass below — read at
	// push as zeros, never consumed before that pass runs.
	const items: ResolvedLine[] = [];
	for (const row of deduped) {
		if (row.kind === "work") {
			// 🚨 **A physical good resolves on its own path, and it is the only line whose
			// money is not the access row alone.** Its goods price is the Work's baseline
			// offer, its count and choices are the buyer's, and its shipping is the
			// listing's flat charge — none of which `resolvePurchase` knows, because that
			// resolver refuses a good outright. The refusal it gives is kept for every
			// other `physical` reach (a single-purchase URL), which is the product's own
			// rule: the basket is the one buy door.
			const [maybeWork] = await db
				.select({ type: works.type })
				.from(works)
				.where(eq(works.slug, row.slug))
				.limit(1);
			if (maybeWork?.type === "physical") {
				const sale = await resolvePhysicalSale(row.slug, userId, {
					quantity: row.quantity,
					options: row.options ?? [],
				});
				if (!sale.ok) return { ...sale, itemId: row.workId };
				items.push({
					kind: "work",
					work: sale.work,
					amount: sale.goodsPrice,
					lineFee: new Decimal(0),
					physical: {
						listing: sale.listing,
						picks: sale.picks,
						quantity: sale.quantity,
						shipping: sale.shippingPrice,
						shippingOnLine: new Decimal(0),
						taxCategory: sale.taxCategory,
						handlingBusinessDays: sale.handlingBusinessDays,
					},
				});
				continue;
			}
			const one = await resolvePurchase(row.slug, userId);
			if (!one.ok) return { ...one, itemId: row.workId };
			items.push({ kind: "work", work: one.work, amount: one.amount, lineFee: new Decimal(0) });
		} else {
			const one = await resolveBadgePurchase(row.badgeId, userId, opts);
			if (!one.ok) return { ...one, itemId: row.badgeId };
			items.push({
				kind: "badge",
				badge: {
					id: one.badge.id,
					creatorId: one.badge.creatorId,
					threshold: String(one.badge.threshold),
					label: one.badge.label,
				},
				issuer: one.issuer,
				held: one.held,
				threshold: one.threshold,
				amount: one.amount,
				product: one.product,
				lineFee: new Decimal(0),
			});
		}
	}

	/**
	 * 🚨 **Shipping is charged once per creator, and the charge lands on that creator's
	 * last line.** A creator ships their own parcels, so a basket holding two of their
	 * goods is still one shipping charge; holding goods from two creators is two, because
	 * two people post two boxes. The figure is the **highest** of that creator's lines'
	 * shipping prices — the least surprising single number when a creator prices a mug
	 * differently from a print, and the direction that never underpays them for a parcel.
	 *
	 * It is allocated to their last line rather than spread, the same "last absorbs"
	 * shape the fee split keeps: one line carries the money, and the row's `shippingAmount`
	 * is what the tax record and the creator's earnings read.
	 */
	const shippingForCreator = new Map<number, Decimal>();
	for (const item of items) {
		if (item.kind !== "work" || !item.physical || item.work.creatorId == null) continue;
		const cid = item.work.creatorId;
		const previous = shippingForCreator.get(cid);
		if (!previous || item.physical.shipping.gt(previous)) {
			shippingForCreator.set(cid, item.physical.shipping);
		}
	}
	const shippingByCreator = new Map<number, Decimal>();
	const carriers = new Map<number, Extract<ResolvedLine, { kind: "work" }>>();
	for (const item of items) {
		if (item.kind !== "work" || !item.physical || item.work.creatorId == null) continue;
		carriers.set(item.work.creatorId, item);
	}
	for (const [cid, shipping] of shippingForCreator) {
		const carrier = carriers.get(cid);
		if (!carrier?.physical) continue;
		carrier.physical.shippingOnLine = shipping;
		shippingByCreator.set(cid, shipping);
	}
	const shippingTotal = [...shippingByCreator.values()].reduce(
		(acc, value) => acc.plus(value),
		new Decimal(0),
	);

	// 🚨 Fees on the SUM, once — computing per item and adding would charge the flat
	// $0.30 per item and defeat the entire point of the basket (Works and Badges amortize
	// it identically; the Badge's money follows the settlement rail, the fee's share is
	// pinned on the row either way). The sum is everything the charge collects: goods,
	// Badges and the shipping the buyer is paying, because the card fee is levied on what
	// is charged rather than on what is merchandise.
	const subtotal = items.reduce((acc, i) => acc.plus(i.amount), shippingTotal);
	const fees = calculateFees(subtotal, { type: "digital" });

	// The value each line contributes to the apportionment — goods plus the shipping it
	// carries, so a line that costs the buyer more also carries more of the fee.
	const chargeValue = (item: ResolvedLine): Decimal =>
		item.kind === "work" && item.physical
			? item.amount.plus(item.physical.shippingOnLine)
			: item.amount;

	// 🚨 The per-line fee shares are APPORTIONED, not recomputed — pro-rata by item value
	// with the last line absorbing the rounding remainder, so the parts always reconstruct
	// the whole exactly. `badge_charges.processing_fee` and the purchase rows' fee both
	// read their share from these, so the rows and the quote cannot disagree.
	let allocatedFee = new Decimal(0);
	for (let idx = 0; idx < items.length; idx++) {
		items[idx].lineFee =
			idx === items.length - 1
				? fees.processingFee.minus(allocatedFee)
				: fees.processingFee.times(chargeValue(items[idx])).dividedBy(subtotal).toDecimalPlaces(2);
		if (idx < items.length - 1) allocatedFee = allocatedFee.plus(items[idx].lineFee);
	}

	// The distinct issuers the charge covers. Anthers' own ladder is NOT excluded here —
	// the checkout's connected-account precondition below skips it explicitly, and the
	// purchase split skips an issuer with no connected account by the same rule — because
	// `creatorIds` is the read-side vocabulary of "whose money is on this charge", and for
	// Anthers that is true in the same sense it is for every issuer.
	const creatorIds = [
		...new Set(items.map((i) => (i.kind === "work" ? i.work.creatorId : i.issuer.id))),
	];
	return { ok: true as const, items, subtotal, fees, creatorIds };
}

/**
 * Build the Checkout Session a purchase is charged through — the one charge shape that can
 * carry a product tax code, and so the only path a purchase has been charged through since
 * real tax calculation landed (2026-09-29).
 *
 * 🚨 **A platform charge, not a destination charge** (Parker, 2026-10-15, the multi-creator
 * basket decision). A destination charge pinned the creator's transfer through
 * `transfer_data[amount]` — one connected account per charge, which is exactly the
 * constraint that forced the one-creator basket. The split decision removed the constraint
 * rather than accepting it: the charge is made to the platform, and the completion path
 * moves each creator's share out as one transfer per creator, funded by the charge
 * (`completeSessionPurchases`), amounts read off the rows' pinned earnings so they never
 * vary with the buyer's location. The money's dwell on the platform balance is seconds, not
 * the ~six-week hold monthly support already runs, and the merchant-of-record posture is
 * the one that decision records — see the counsel brief's "A basket spanning two
 * creators" callout for the reasoning and the accepted cost.
 *
 * The tax mechanics are unchanged by the split. `automatic_tax` resolves from the buyer's
 * address per line's product tax code, the tax lands on the platform side by construction
 * (it never entered a transfer), and Anthers remains the marketplace facilitator and the
 * liability — the Creator Terms say so — so plain `enabled: true` keeps the liability on
 * the platform, where it already was.
 *
 * ⚠️ **US billing addresses only, enforced client-side by construction, backstopped
 * here.** The purchase surfaces collect the address through Anthers' own US-only form
 * (the Checkout-flavored Billing Address Element offers no country allow-list, which is
 * why it was replaced), so the session a browser creates carries a US address by
 * construction — there is no country field to enter anything else into. The completion
 * path below is the backstop for anything that reaches the API anyway: a hand-rolled
 * session built against the API directly, or a form a modified client skipped. It
 * refuses a session whose resolved billing address is not US, leaving the rows `pending`
 * for a hand refund — the boundary holds even when the client's half does not.
 *
 * `buyerTotal` is the price itself: tax joins it inside the session, resolved per buyer,
 * and `total_details.amount_tax` is what the completion path stamps onto the purchase rows.
 */
function purchaseSession(params: {
	/** The web origin the buyer's browser will return to after a redirect-based method. */
	origin: string;
	/** One line per Work, each carrying the tax code for what the buyer receives. */
	lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
	/**
	 * The buyer's existing Stripe Customer id, when one is on file — the session reuses
	 * it rather than building a second one. Null for a buyer whose first money door this
	 * is, which is the ordinary case under the 2026-10-11 decision (a Customer is created
	 * `if_required`, or by checkout when Stripe needs one, and the completion webhook then
	 * links it — `linkCheckoutCustomer`).
	 */
	customerId: string | null;
	/**
	 * The buyer's account email, put on the session as its Customer's address. None of the
	 * purchase surfaces collect an email (the address form is name-and-address), so without
	 * this the session held none and Stripe's `canConfirm` stayed false forever — the
	 * greyed-out Pay button Parker found on the live checkout (2026-10-06). See below.
	 */
	customerEmail: string;
	/**
	 * 🚨 **Set ONLY when a Badge's recurrence awaits and no active subscription exists**
	 * (the checkout computes it — see the basket route's note). A purchase checkout keeps
	 * `payment_method_save: "disabled"` and never offers a save; this is the one payment
	 * a checkout is allowed to leave a card behind for, because a Badge line created on
	 * the platform charge has to renew against something on file.
	 *
	 * ⚠️ PROBE at implementation (2026-10-15): whether `setup_future_usage` on a
	 * `mode: "payment"` session saves the confirming card WITHOUT re-introducing Link's
	 * consent block — the 2026-10-06 incident (the block's empty phone field held
	 * `canConfirm` false all day) lives in this exact interplay. If the block reappears,
	 * the alternative is a SetupIntent ride-along at completion, and the probe decides.
	 */
	saveCard?: boolean;
	/**
	 * `"us"` when the charge carries a physical good, so Checkout collects the address the
	 * creator ships to. Absent for every digital charge, which asks for nothing beyond the
	 * billing address that resolves tax.
	 */
	shippingAddress?: "us";
	metadata: Record<string, string>;
}): Stripe.Checkout.SessionCreateParams {
	return {
		mode: "payment",
		ui_mode: "elements",
		// A good has to be sent somewhere, and this is how Checkout asks. The address is
		// stamped onto the purchase rows at completion, which is where the creator's order
		// list reads it; a digital charge collects nothing here.
		...(params.shippingAddress === "us"
			? { shipping_address_collection: { allowed_countries: ["US" as const] } }
			: {}),
		// 🚨 **The email is what confirms the session.** Stripe requires a valid customer
		// email before a session may be confirmed — `canConfirm` stays false without one —
		// and none of the purchase surfaces collect one: no Contact Details Element, no
		// email field on the address form, and no `customer_email` here. Every buyer is a
		// verified account (`requireVerified`), so the email is already held, already
		// proven, and simply belongs on the session — the receipt and the Customer record
		// both want it anyway. Found as the disabled Pay button (2026-10-06): all three
		// address fields resolved a real tax, the card was filled, and the button never
		// un-greyed.
		//
		// 🚨 **`customer` and `customer_email` are either-or, never both** — Stripe refuses
		// the pair outright ("You may only specify one of these parameters"), found live
		// 2026-10-15: a buyer with a Customer on file — which the saved billing address
		// now routinely creates — 500s the checkout the moment both ride the create. With
		// a Customer named, the session takes its email from the Customer (every door that
		// creates one passes the account's email — `ensureStripeCustomer`), so the email
		// requirement is met through it; without a Customer, the account's own verified
		// email rides the session.
		...(params.customerId ? {} : { customer_email: params.customerEmail }),
		// The buyer's billing address is what tax resolves from, and it is required in full
		// because local tax is address-level rather than state-level — the same full street
		// address the return worksheets and the threshold forecast later read off the row.
		billing_address_collection: "required",
		// 🚨 **A Customer exists only for a buyer with something to reuse, per the
		// 2026-10-11 decision.** A buyer whose billing row carries a customer id pays on
		// that same Customer (`customer`), so a saved address or a subscription
		// accumulates into the one record; nobody else leaves a Customer behind at all
		// (`if_required` creates one only when the session needs it, and a plain card
		// payment without a save does not) — and if Stripe does create one, the
		// completion webhook links it via `linkCheckoutCustomer` so the next purchase
		// reuses it. Before the decision, every one-time buyer kept a permanent
		// customer object with their address and email on it.
		//
		// ⚠️ **Two riders go only with the customer, found by the probe (2026-10-15,
		// test mode):**
		// - `saved_payment_method_options` is REFUSED on a customerless session outright
		//   ("requires a customer") — so the suppression pair below rides only when a
		//   customer does. A customerless session renders no save UI to suppress
		//   (nothing is on file to save, and the client's own `enableSave: "never"`
		//   governs what the element would offer), so the suppression is redundant
		//   there, and required here.
		// - `customer_update[address]` is what makes checkout's collected address SAVE
		//   onto the Customer (and what automatic_tax requires a customer-carried
		//   session to carry when that customer has no address yet — the same probe's
		//   second rejection). The saved-billing-address door reads the customer's
		//   address, so this is the persistence path as well as the acceptance one.
		...(params.customerId
			? {
					customer: params.customerId,
					customer_update: { address: "auto" as const },
					saved_payment_method_options: {
						payment_method_save: "disabled",
						payment_method_remove: "disabled",
					},
				}
			: { customer_creation: "if_required" as const }),
		// 🚨 Card-only is the account-wide Default configuration (Parker, 2026-10-06:
		// the Dashboard's Default narrowed to card and nothing else, matching the
		// buyer-facing decision rather than overriding it per deployment). No
		// configuration parameter is sent, and no deployment carries
		// `STRIPE_PAYMENT_METHOD_CONFIGURATION` — the Dashboard governs what every
		// session offers, which is the shape this API version is built around. The
		// env lever below is kept for a genuinely per-deployment override — a named
		// config used some places and not others — but nothing names one today.
		//
		// The one code-side lever the types DO support on this API version:
		// `payment_method_configuration` — and ONLY when `STRIPE_PAYMENT_METHOD_CONFIGURATION`
		// is set. Unset by default, the Dashboard's account-wide configuration
		// governs what every session offers; setting the env names a configuration to
		// override that default per deployment.
		...(process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION?.trim()
			? { payment_method_configuration: process.env.STRIPE_PAYMENT_METHOD_CONFIGURATION.trim() }
			: {}),
		// 🚨 **The Link consent block is suppressed on the sessions it could render on.** A
		// plain purchase never stores a card (`setup_future_usage` is nowhere), so the
		// session does not ask to save — and Checkout renders Link's consent block ("Save
		// my information for faster checkout", an email + MOBILE NUMBER sub-form, checkbox
		// checked by default) whenever a Customer rides the session: a saved one passed
		// in, or one Stripe created. A buyer who ignores the block left the phone field
		// empty and Stripe held `canConfirm` false forever: the fully-filled form with a
		// greyed Pay button (2026-10-06, live payment_method collection blocked all day;
		// the client-side `savedPaymentMethod.enableSave: "never"` below removes the
		// sub-form from its side too). The suppression is the customer-riding branch's
		// rider — on a customerless session there is no save UI to suppress (nothing is
		// on file, and the probe showed the pair itself is refused there).
		//
		// ⚠️ The one exception is `saveCard` — set when a Badge's recurrence awaits and
		// the buyer has no active subscription (Parker, 2026-10-15). The suppression pair
		// is the customer-riding branch's rider now (`saved_payment_method_options` is
		// REFUSED on a customerless session — the probe's finding above); a save driven
		// through `setup_future_usage` asks no consent question, and the client's
		// `savedPaymentMethod.enableSave: "never"` governs the element's side either way.
		line_items: params.lineItems,
		automatic_tax: { enabled: true },
		payment_intent_data: {
			metadata: params.metadata,
			// The one save a purchase checkout may make — a Badge's recurrence needs the
			// card on file, and the confirmation is where it lives. See `saveCard` above.
			...(params.saveCard ? { setup_future_usage: "off_session" as const } : {}),
		},
		// Where a redirect-based payment method sends the buyer back; cards don't use it,
		// but the session requires it when one is enabled. `STRIPE_RETURN_PATHS` owns every
		// URL the server hands Stripe — see `scripts/stripe-redirect-guard.test.ts`.
		return_url: `${params.origin}${STRIPE_RETURN_PATHS.checkoutReturn}`,
	};
}

/**
 * One line item per Work, carrying the tax code for what the buyer receives.
 *
 * 🚨 **The code follows the Work's type, from `purchaseTaxCode` — never a default.** A
 * session without a code falls back to Stripe's preset, which would tax every line as
 * generic tangible goods and quietly mis-tax downloads, streams and donations alike. The
 * caller has already refused the types with no code (physical, service).
 */
function workLineItem(
	work: { id: number; title: string | null; type: string },
	amountCents: number,
	taxCode: string,
	opts?: { quantity?: number; variant?: string[] },
): Stripe.Checkout.SessionCreateParams.LineItem {
	const variant = (opts?.variant ?? []).filter(Boolean);
	return {
		price_data: {
			currency: "usd",
			// US prices are tax-exclusive: the buyer's total varies with their location,
			// which is the point of automatic tax.
			tax_behavior: "exclusive",
			// `amountCents` is the line's goods total; a quantity above one divides back to
			// the unit price, so the receipt reads "2 × $12.00" rather than one $24 line.
			unit_amount: Math.round(amountCents / Math.max(1, opts?.quantity ?? 1)),
			product_data: {
				// A Work's title is nullable in the database; the Work's slug-anchored page
				// is what names it publicly, but a receipt line needs something, and a
				// fallback reads better on a card statement than an empty string.
				name: work.title || `Work #${work.id}`,
				...(variant.length > 0 ? { description: variant.join(" · ") } : {}),
				tax_code: taxCode,
			},
		},
		quantity: Math.max(1, opts?.quantity ?? 1),
	};
}

/**
 * The delivery line a physical order carries — one per creator, taxed as shipping.
 *
 * `txcd_92010001` is Stripe's "shipping in conjunction with the sale of physical goods",
 * and it is a separate code from the goods because a jurisdiction may treat the two
 * differently. A zero figure is no line at all, which the caller decides (`shippingLineItem`
 * is only called for a creator whose shipping is above zero).
 */
function shippingLineItem(
	creatorHandle: string,
	amountCents: number,
): Stripe.Checkout.SessionCreateParams.LineItem {
	return {
		price_data: {
			currency: "usd",
			tax_behavior: "exclusive",
			unit_amount: amountCents,
			product_data: {
				name: `Shipping${creatorHandle ? ` from @${creatorHandle}` : ""}`,
				tax_code: SHIPPING_TAX_CODE,
			},
		},
		quantity: 1,
	};
}

/**
 * One line item for a Badge's first Month, against the rung's own Stripe Product —
 * `ensureBadgeProduct` created it carrying the rung's own tax code (the most-taxable
 * thing the rung delivers), so the line needs nothing beside the product reference and
 * the first transaction's amount: the full threshold, or an upgrade's delta.
 */
function badgeLineItem(
	product: string,
	amountCents: number,
): Stripe.Checkout.SessionCreateParams.LineItem {
	return {
		price_data: {
			currency: "usd",
			// US prices are tax-exclusive: the buyer's total varies with their location,
			// which is the point of automatic tax — the same behavior every purchase line
			// and every subscription line carries.
			tax_behavior: "exclusive",
			unit_amount: amountCents,
			product,
		},
		quantity: 1,
	};
}

/**
 * Whether the buyer carries a support subscription Stripe can still bill — the test the
 * card-save decision makes (a Badge's recurrence rides that subscription's payment
 * method when it exists, so the checkout need not save one) and the completion's
 * decision between "add the line to the existing subscription" and "create one".
 *
 * ⚠️ Deliberately narrow: `active` and `trialing` are the only YES. A past-due or unpaid
 * subscription cannot take a new line (the checkout refuses a Badge ride at
 * `atCheckout` for exactly that), and no subscription at all is the ordinary Badge-buyer
 * case the card save exists for.
 */
async function hasActiveSupportSubscription(userId: number): Promise<boolean> {
	const [acct] = await db
		.select({ stripeSubscriptionId: billingAccounts.stripeSubscriptionId })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	if (!acct?.stripeSubscriptionId) return false;
	const sub = await retrieveSubscription(acct.stripeSubscriptionId);
	return sub?.status === "active" || sub?.status === "trialing";
}

/**
 * Complete the purchases a Checkout Session was created for: re-key the rows from the
 * session id to the PaymentIntent it produced, and stamp the tax Stripe Tax collected plus
 * the buyer's resolved billing address.
 *
 * 🚨 **This is where the remittance record becomes real.** The purchase rows are what the
 * sales-tax return worksheet and the threshold forecast read, and both need per-charge tax
 * and buyer location — retrofitting onto past charges is the expensive direction, which is
 * why the columns are stamped here rather than derived later. `salesTax` was zero at
 * checkout because Anthers' arithmetic cannot know the buyer's location; the session can.
 * Since the Badge purchase rides the same checkout, `badge_charges` rows are stamped by
 * the same latch and share the charge's ONE tax figure (apportioned across the union of
 * everything the charge carried).
 *
 * ⚠️ **US billing only, enforced here as the backstop.** The buy surfaces collect the
 * address through Anthers' own US-only form — there is no country field to enter
 * anything else into, so a browser-built session carries a US address by construction.
 * This refusal is the defense in depth for what that cannot see: a hand-rolled API
 * call, a modified client, a form skipped. A non-US address is a hard failure that
 * leaves the rows `pending` and the money to be returned by hand. Refusing loudly beats
 * collecting tax Anthers is not registered to collect.
 *
 * Idempotent by the same latch the rest of the webhook uses: only `pending` rows move —
 * in both tables.
 */
async function completeSessionPurchases(pi: Stripe.PaymentIntent): Promise<void> {
	// The session id does not exist when the PaymentIntent's metadata is written (Stripe
	// creates the intent inside the session), so the session cannot be named in the
	// intent's metadata — it is found by listing sessions for the intent.
	const list = listCheckoutSessions({ payment_intent: pi.id, limit: 1 });
	if (!list) return;
	let session: Stripe.Checkout.Session | null = null;
	for await (const found of list) {
		session = found;
		break;
	}
	if (!session) return;

	// The buyer's address as Checkout resolved it. Null on a session that never asked for
	// one, which ours always do — a null here means the session shape changed and the
	// posture's record is incomplete, so it fails toward refusing the completion.
	//
	// 🚨 **A charge carrying goods has two addresses, and the delivery one is what gets
	// stamped.** Checkout collects the shipping address only when the session asked for one
	// (`shipping_address_collection`), and a creator ships to where the buyer said the parcel
	// goes — not to where the card is billed. Every other charge falls back to billing,
	// which is the same address it always recorded.
	const shippingAddress = session.collected_information?.shipping_details?.address ?? null;
	const address = shippingAddress ?? session.customer_details?.address ?? null;
	if (address?.country !== "US") {
		console.error(
			`purchase completion refused: session ${session.id} billed outside the US (${address?.country ?? "no address"}) — refund by hand`,
		);
		return;
	}

	const intentId =
		typeof session.payment_intent === "string"
			? session.payment_intent
			: session.payment_intent?.id;
	if (!intentId || intentId !== pi.id) return;

	// The tax Stripe Tax actually collected on the whole charge, in cents.
	const taxCents = session.total_details?.amount_tax ?? 0;
	const tax = new Decimal(taxCents).dividedBy(100).toFixed(2);

	// Re-key the rows onto the PaymentIntent, stamping the location and the tax. Only
	// `pending` rows move, so a redelivered event is a no-op — the same latch the
	// PI-keyed branch below relies on. Both tables ride the latch: a charge that carried
	// Badge lines completes them alongside the purchase rows.
	const rows = await db
		.select()
		.from(purchases)
		.where(and(eq(purchases.stripePaymentIntentId, session.id), eq(purchases.status, "pending")));
	const badgesPending = await db
		.select()
		.from(badgeCharges)
		.where(
			and(eq(badgeCharges.stripePaymentIntentId, session.id), eq(badgeCharges.status, "pending")),
		);
	if (rows.length === 0 && badgesPending.length === 0) return;

	// The charge's ONE tax figure apportioned across EVERYTHING it carried — purchase
	// rows and Badge charge rows together, pro-rata by item value, the very last line of
	// the union absorbing the rounding remainder, so the rows of both tables sum to what
	// Stripe collected exactly. (Purchases first, Badges after: the historical order —
	// a no-Badge charge apportions over its purchase rows exactly as before.)
	// ⚠️ A purchase's share is weighed by **everything the charge collected on it**: the
	// goods AND the shipping, which Stripe taxed with its own code. Weighing by `amount`
	// alone would leave the tax on shipping unallocated and the rows summing short of what
	// the return needs to remit.
	const union = [
		...rows.map((row) => ({
			kind: "purchase" as const,
			row,
			amount: new Decimal(row.amount).plus(row.shippingAmount ?? 0).toFixed(2),
		})),
		...badgesPending.map((row) => ({ kind: "badge" as const, row, amount: row.chargedAmount })),
	];
	const subtotal = union.reduce((acc, e) => acc.plus(new Decimal(e.amount)), new Decimal(0));
	const taxTotal = new Decimal(tax);
	let allocated = new Decimal(0);
	const stampedUnion = union.map((entry, idx) => {
		const isLast = idx === union.length - 1;
		const share = isLast
			? taxTotal.minus(allocated)
			: taxTotal.times(new Decimal(entry.amount)).dividedBy(subtotal).toDecimalPlaces(2);
		if (!isLast) allocated = allocated.plus(share);
		return { ...entry, share };
	});
	const stamped = stampedUnion.filter(
		(e): e is Exclude<(typeof stampedUnion)[number], { kind: "badge" }> => e.kind === "purchase",
	);
	const stampedBadges = stampedUnion.filter(
		(e): e is Extract<(typeof stampedUnion)[number], { kind: "badge" }> => e.kind === "badge",
	);

	for (const { row, share } of stamped) {
		await db
			.update(purchases)
			.set({
				stripePaymentIntentId: intentId,
				salesTax: share.toFixed(2),
				buyerCountry: address.country,
				buyerState: address.state ?? null,
				buyerPostalCode: address.postal_code ?? null,
				buyerAddressLine1: address.line1 ?? null,
				buyerAddressLine2: address.line2 ?? null,
				buyerCity: address.city ?? null,
				updatedAt: new Date(),
			})
			.where(and(eq(purchases.id, row.id), eq(purchases.status, "pending")));
	}
	for (const { row, share } of stampedBadges) {
		await db
			.update(badgeCharges)
			.set({
				stripePaymentIntentId: intentId,
				salesTax: share.toFixed(2),
				status: "completed",
				updatedAt: new Date(),
			})
			.where(and(eq(badgeCharges.id, row.id), eq(badgeCharges.status, "pending")));
	}

	// ── The split, after the rows are keyed to the intent ─────────────────────
	// The platform charge collected everyone's money; now each creator's share moves out,
	// one transfer per creator funded by the charge. The amounts are the rows' pinned
	// earnings, so a failure leaves a row unstamped and the retry job the owner of the
	// debt — `services/purchase-split.ts` carries the whole reasoning, including why a
	// refund in the window must never transfer. Badge lines never transfer: support
	// settles through the cycle distribution, and this split only ever sees purchase rows.
	const latestCharge =
		typeof pi.latest_charge === "string" ? pi.latest_charge : (pi.latest_charge?.id ?? null);
	await splitChargeToCreators(
		{ id: pi.id, latestCharge },
		stamped.map(({ row }) => row),
	);

	// ── Link the checkout's Customer, after the rows are stamped ─────────────
	// Under the 2026-10-11 posture a session without a saved customer carries one only
	// when Stripe created it (`if_required`); linking it here is what makes the buyer's
	// NEXT purchase reuse that one instead of leaving a second customer object behind.
	// No-op when the session carries no customer (the ordinary opted-out buyer) and
	// never overwrites the id `billingAccounts` already holds. The buyer's own id rides
	// the intent's metadata, which every purchase surface stamps. A Badge's recurrence
	// needs this link done BEFORE the support half below runs — it looks the customer id
	// up through the same column.
	const linkCustomerId =
		typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
	// The buyer's own id rides the intent's metadata, which every purchase surface stamps.
	// The session's copy is the fallback: Stripe's own copy of the intent metadata is the
	// ordinary source, but a PI built outside our checkout (a fixture, a hand-rolled call)
	// may carry only the session's.
	const buyerUserId = Number(pi.metadata?.buyerId ?? session.metadata?.buyerId ?? NaN);
	if (linkCustomerId && Number.isFinite(buyerUserId)) {
		await linkCheckoutCustomer(buyerUserId, linkCustomerId);
	}

	// ── The basket's bought lines leave with the money ───────────────────────
	// This is the ONLY place a purchase empties part of the basket (Parker, 2026-10-19):
	// the checkout route builds a session on every visit to the basket page and must not
	// spend the buyer's intent, so the rows leave here, once the charge has actually
	// completed. Exactly the ids this charge carried — `stamped` and `stampedBadges` are
	// its completed rows — so a Work the buyer added in another tab while the webhook was
	// in flight is theirs to keep. Idempotent: a redelivery finds the rows already gone.
	if (Number.isFinite(buyerUserId)) {
		const boughtWorkIds = stamped
			.map(({ row }) => row.workId)
			.filter((id): id is number => id != null);
		const boughtBadgeIds = stampedBadges
			.map(({ row }) => row.badgeId)
			.filter((id): id is number => id != null);
		await clearPurchasedBasketItems(buyerUserId, boughtWorkIds, boughtBadgeIds);
	}

	// ── A physical purchase opens a shipment ─────────────────────────────────
	// The delivery half of a paid good: the clock that says whether it should have left
	// the creator's hands yet, and the state every later step reads. Idempotent on the
	// purchase, so a redelivered event is a no-op — one purchase owes one shipment.
	for (const { row } of stamped) {
		if (row.type !== "physical") continue;
		// The handling time the buyer was quoted at checkout, not the listing's current
		// one: a creator who shortened it since must not move a deadline somebody has.
		await createShipmentForPurchase({
			purchaseId: row.id,
			handlingBusinessDays:
				row.handlingBusinessDays == null ? undefined : clampHandlingDays(row.handlingBusinessDays),
		});
	}

	// ── The Badge half — the support side of a completed first transaction ────
	// The holding (find-or-create rung, one per issuer, the pick replaces —
	// `applyDirectedSupport`, which rides the follow along), the recurrence line (no
	// charge today — the checkout carried the first transaction), and the day-exact
	// missed-days reduction on the next renewal. The money never transfers here; the
	// cycle's settlement reads these rows beside the invoices. A redelivered event finds
	// no pending rows and is a no-op by the same latch.
	if (stampedBadges.length > 0 && Number.isFinite(buyerUserId)) {
		const completable = stampedBadges.filter(({ row }) => row.creatorId != null);
		const orphans = stampedBadges.length - completable.length;
		if (orphans > 0)
			console.error(
				`badge completion: ${orphans} row(s) on charge ${pi.id} lost their issuer — settled by hand`,
			);
		if (completable.length > 0) {
			await applyDirectedSupport(
				buyerUserId,
				completable.map(({ row }) => ({
					creatorId: row.creatorId as number,
					amount: Number(row.threshold),
				})),
			);
			// The recurrence lines, with each rung's own Product; a row whose rung was
			// deleted between checkout and completion bills against the issuer's
			// per-creator Product instead (the rung's tax-code subtlety is gone with the
			// rung — the buyer paid, and the line exists to recur).
			const products: string[] = [];
			for (const { row } of completable) {
				const [issuer] = await db
					.select({ handle: users.atprotoHandle })
					.from(users)
					.where(eq(users.id, row.creatorId as number))
					.limit(1);
				const handle = issuer?.handle ?? "unknown";
				if (row.badgeId != null) {
					const product = await ensureBadgeProduct(
						row.badgeId,
						row.badgeLabel ?? `$${row.threshold}`,
						handle,
					);
					if (product) products.push(product);
					continue;
				}
				const product = await ensureCreatorProduct(row.creatorId as number, handle);
				if (product) products.push(product);
			}
			await applyBadgeRecurrence(
				buyerUserId,
				completable
					.map(({ row }, idx) => ({
						issuerId: row.creatorId as number,
						product: products[idx],
						threshold: Number(row.threshold),
					}))
					// A rung that produced no Product (Stripe unconfigured) is skipped —
					// the holding stands, the line joins on a later pass of the same job.
					.filter((pick) => Boolean(pick.product)),
				// The confirmed payment method — what a no-subscription buyer's new
				// subscription bills with. Null when the charge carried none (the buyer
				// already had a subscription): the existing-sub branch needs nothing, and
				// the fresh creation falls back to the honest failed-renewal path.
				typeof pi.payment_method === "string" ? pi.payment_method : null,
			);
			// The day-exact missed-days reduction — a Badge's first transaction charged a
			// full rung today through the charge, so the days before today come off the
			// next renewal exactly as a subscription-side raise records them.
			await recordReductions(
				buyerUserId,
				new Date(),
				completable.map(({ row }) => ({
					creatorId: row.creatorId as number,
					amount: Number(row.chargedAmount),
				})),
			);
		}
	}
}

// ─── Basket storage: the shared read the storage routes answer with ─────────

/**
 * The account's basket, each row resolved to what the buyer could actually buy — Works
 * and Badge lines alike, each with the money the checkout would charge.
 *
 * 🚨 **A stale row answers by absence, never by error.** The table may hold an item that
 * stopped being buyable after it was added (a Work withdrawn, owned, or priced out; a
 * rung deleted, re-priced past the buyer, or fallen behind the ratchet; a buyer's
 * subscription gone past due) — this read is where it stops being visible. Returning it
 * with an error flag would make every subscriber (the badge first) into a place that has
 * to know the rules; the basket page rendering only what a checkout could charge is the
 * honest shape, and the refusals keep firing where money is at stake — at quote and
 * checkout. See `resolveBadgePurchase` and `resolvePurchase`.
 */
export interface ResolvedBasketItem {
	kind: "work" | "badge";
	/** The Work's id, when this is a Work row. */
	workId?: number;
	/** The rung's id, when this is a Badge row. */
	badgeId?: number;
	slug?: string;
	/** The Work's title, or the rung's own label. */
	title: string | null;
	/** The first transaction's price — the full threshold, or an upgrade's delta. */
	price: string;
	/** The monthly price this line begins — the rung's threshold, null for a Work. */
	recurring: string | null;
	creatorHandle: string;
	thumbnail: string | null;
	/** How many of a physical good this line means to buy. One for everything else. */
	quantity: number;
	/** A physical line's chosen values, and the flat shipping the line carries. */
	options?: Array<{ name: string; label: string }> | null;
	shipping?: string;
	/**
	 * Why this line cannot be bought as it stands — a count past the shelf, a value that
	 * sold out. Present only on a physical line that failed to resolve.
	 *
	 * 🚨 **A physical line answers by being visible, not by vanishing.** A digital row that
	 * stops being buyable is dropped from the answer silently, because there is nothing the
	 * buyer could change about it; a good's count is theirs to change, so hiding the line
	 * would hide both the problem and the fix. The quote and the checkout refuse while one
	 * of these stands, in this sentence.
	 */
	error?: string;
}

async function resolvedBasketItems(userId: number): Promise<ResolvedBasketItem[]> {
	const rows = await listBasket(userId);
	const items: ResolvedBasketItem[] = [];
	for (const row of rows) {
		if (row.kind === "badge") {
			// Display-only: pricing is the database's read (the holdings), never a
			// processor call — the product step is the session builder's job.
			const b = await resolveBadgePurchase(row.badgeId, userId, { needsProduct: false });
			if (!b.ok) continue;
			items.push({
				kind: "badge",
				badgeId: row.badgeId,
				title: row.label,
				price: b.amount.toFixed(2),
				recurring: b.threshold.toFixed(2),
				creatorHandle: row.issuerHandle ?? "",
				thumbnail: null,
				quantity: 1,
			});
			continue;
		}
		if (!row.slug || !row.creatorHandle) continue;
		// A physical good has no access price to resolve — its money is the listing's and
		// the pick's — so the line is priced the same way the checkout will price it.
		const [maybeWork] = await db
			.select({ type: works.type })
			.from(works)
			.where(eq(works.slug, row.slug))
			.limit(1);
		if (maybeWork?.type === "physical") {
			const sale = await resolvePhysicalSale(row.slug, userId, {
				quantity: row.quantity,
				options: row.options ?? [],
			});
			if (!sale.ok) {
				items.push({
					kind: "work",
					workId: row.workId,
					slug: row.slug,
					title: row.title,
					price: "0.00",
					recurring: null,
					creatorHandle: row.creatorHandle,
					thumbnail: row.thumbnail,
					quantity: row.quantity,
					options: row.options ?? null,
					error: sale.error,
				});
				continue;
			}
			items.push({
				kind: "work",
				workId: row.workId,
				slug: row.slug,
				title: row.title,
				price: sale.goodsPrice.toFixed(2),
				recurring: null,
				creatorHandle: row.creatorHandle,
				thumbnail: row.thumbnail,
				quantity: sale.quantity,
				options: sale.picks,
				shipping: sale.shippingPrice.toFixed(2),
			});
			continue;
		}
		const q = await resolvePurchase(row.slug, userId);
		if (!q.ok) continue;
		items.push({
			kind: "work",
			workId: row.workId,
			slug: row.slug,
			title: row.title,
			price: q.amount.toFixed(2),
			recurring: null,
			creatorHandle: row.creatorHandle,
			thumbnail: row.thumbnail,
			quantity: 1,
		});
	}
	return items;
}

/**
 * The content identity of a resolved basket — every line's id, plus a physical line's count
 * and chosen values.
 *
 * 🚨 **The picks are part of the identity, not a detail of the line.** A buyer who opens the
 * checkout as a medium and then switches to a large has a different basket, and handing
 * back the session built for the medium would charge them for the wrong shirt. The count
 * rides for the same reason: two mugs are not one mug.
 */
function basketPicksKey(
	workLines: Array<Extract<ResolvedLine, { kind: "work" }>>,
	badgeLines: Array<Extract<ResolvedLine, { kind: "badge" }>>,
): string {
	const workKeys = workLines.map((line) => {
		const picks = (line.physical?.picks ?? [])
			.map((pick) => `${pick.name}=${pick.label}`)
			.sort()
			.join("&");
		const quantity = line.physical?.quantity ?? 1;
		return quantity === 1 && !picks ? `w${line.work.id}` : `w${line.work.id}q${quantity}[${picks}]`;
	});
	const badgeKeys = badgeLines.map((line) => `b${line.badge.id}`);
	return [...workKeys, ...badgeKeys].sort().join(",");
}

/** The content identity a basket Checkout Session was built for, read off its metadata. */
function sessionBasketContentKey(metadata: Stripe.Metadata | null): string {
	const ids = (value: string | undefined, prefix: "w" | "b") =>
		(value ?? "")
			.split(",")
			.filter(Boolean)
			.map((id) => `${prefix}${id}`);
	return [...ids(metadata?.workIds, "w"), ...ids(metadata?.badgeIds, "b")].sort().join(",");
}

/**
 * Settle a checkout session's still-pending ledger rows as failed.
 *
 * A session that expired, or one this visit expired because the basket it carried is no
 * longer the basket the buyer is looking at, will never be paid — its rows are dead
 * weight in the purchases ledger and in any later reconciliation. A `complete` session is
 * deliberately NOT passed here: its payment succeeded and the webhook owns those rows,
 * which may simply not have landed yet.
 */
async function failPendingBasketRows(sessionId: string): Promise<void> {
	const failed = await db
		.update(purchases)
		.set({ status: "failed", updatedAt: new Date() })
		.where(and(eq(purchases.stripePaymentIntentId, sessionId), eq(purchases.status, "pending")))
		.returning();
	// A session that will never be paid gives its goods back to the shelf now rather than
	// at the sweep's horizon — the buyer is not going to pay for them, and somebody else
	// may want the last one this afternoon.
	const physical = failed.filter(
		(row) => row.type === "physical" && row.workId != null && !row.stockReleasedAt,
	);
	if (physical.length > 0) {
		await releaseStock(
			physical.map((row) => ({
				workId: row.workId as number,
				picks: row.options ?? [],
				quantity: row.quantity ?? 1,
			})),
		);
		await db
			.update(purchases)
			.set({ stockReleasedAt: new Date() })
			.where(
				inArray(
					purchases.id,
					physical.map((row) => row.id),
				),
			);
	}
	await db
		.update(badgeCharges)
		.set({ status: "failed", updatedAt: new Date() })
		.where(
			and(eq(badgeCharges.stripePaymentIntentId, sessionId), eq(badgeCharges.status, "pending")),
		);
}

/**
 * What the account's existing basket sessions mean for a checkout attempt right now.
 *
 * - `resume` — an open session for exactly this basket, whose client secret is handed back.
 * - `confirming` — a session for this basket has already been PAID, and its webhook has not
 *   landed yet. Building a second session here is how a buyer pays twice for one basket,
 *   so the route refuses with a retry-shaped message instead; the completion clears the
 *   basket within moments.
 */
type BasketSessionState =
	| { state: "resume"; session: Stripe.Checkout.Session }
	| { state: "confirming" };

/**
 * The open basket Checkout Session this account already holds for exactly this basket, or
 * null when a fresh one is needed.
 *
 * 🚨 **This is what lets the basket survive an abandoned checkout** (Parker, 2026-10-19).
 * The basket used to be emptied the moment a session was built — which is the moment the
 * basket page loads — so opening the page and leaving without paying erased the buyer's
 * choices. Now the session is the disposable thing: a revisit with the same basket gets
 * the same session back; a session for a basket that has since changed (or one Stripe has
 * already expired) is closed and its pending rows failed, and a new one is built from what
 * the buyer actually holds.
 *
 * A session whose id cannot be read is skipped rather than fatal — an unreachable
 * processor degrades to "build a new one", the same fail-open the checkout already
 * accepts.
 */
async function resumeBasketSession(
	userId: number,
	contentKey: string,
): Promise<BasketSessionState | null> {
	const [workSessions, badgeSessions] = await Promise.all([
		db
			.selectDistinct({ id: purchases.stripePaymentIntentId })
			.from(purchases)
			.where(and(eq(purchases.buyerId, userId), eq(purchases.status, "pending"))),
		db
			.selectDistinct({ id: badgeCharges.stripePaymentIntentId })
			.from(badgeCharges)
			.where(and(eq(badgeCharges.buyerId, userId), eq(badgeCharges.status, "pending"))),
	]);
	const ids = [...new Set([...workSessions, ...badgeSessions].map((row) => row.id))];

	for (const id of ids) {
		const session = await retrieveCheckoutSession(id);
		if (!session) continue;
		// Only a BASKET session may be resumed or refused here — a buy-now Badge charge
		// leaves its own pending rows, and its session is not this basket's even when the
		// ids happen to coincide.
		if (session.metadata?.kind !== "direct_purchase_basket") continue;
		// A session built since goods could be bought carries the whole pick as its key;
		// an older (or digital-only) one is recomputed from the ids it named. Both shapes
		// answer the same question: is this session the basket the buyer is looking at?
		const sameBasket =
			(session.metadata?.contentKey ?? sessionBasketContentKey(session.metadata)) === contentKey;
		if (session.status === "open") {
			if (sameBasket) return { state: "resume", session };
			// The basket changed under it: nobody may pay this one any more, and its
			// ledger rows will never complete.
			await expireCheckoutSession(id);
			await failPendingBasketRows(id);
			continue;
		}
		// A paid session for this very basket is mid-confirmation: its rows are still
		// pending only because the webhook has not landed. Never build a second charge.
		if (sameBasket && session.status === "complete" && session.payment_status === "paid") {
			return { state: "confirming" };
		}
		if (session.status === "expired") await failPendingBasketRows(id);
	}
	return null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const paymentRoutes = new Hono()
	// ── Public config ────────────────────────────────────────────────────────
	// The publishable key is meant to be public (it ships in client JS); serving it
	// keeps the key in one place (server env) with no build-time injection to maintain.
	.get("/stripe/config", (c) => {
		return c.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY?.trim() ?? "" });
	})

	// ── Stripe Connect Onboarding ────────────────────────────────────────────
	.get("/stripe/onboard", requireAuth, async (c) => {
		const user = c.get("user");

		const [account] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, user.id))
			.limit(1);

		if (!account) {
			return c.json({
				hasAccount: false,
				chargesEnabled: false,
				payoutsEnabled: false,
				onboardingComplete: false,
				// An account that does not exist has also not submitted anything.
				detailsSubmitted: false,
			});
		}

		/**
		 * Reconcile-on-read: the `account.updated` webhook is the row's primary writer, and
		 * a missed delivery leaves the row all-false while Stripe's truth is all-true —
		 * which stranded both live onboardings so far. When a row exists but onboarding is
		 * not complete, ask Stripe directly and sync the row exactly as the webhook would
		 * have — through the flag derivation in `services/payouts.ts`, which the webhook now
		 * shares, so the two cannot drift.
		 *
		 * The reconcile IS a Stripe read, and the detail view (the Studio Payments tab, next
		 * block) needs the same read for its requirements/schedule/balance display, so the two
		 * share one retrieval: a reconcile already paid for is a detail view for free, and the
		 * detail view is what justifies the read on the tab (no poller pays it).
		 */
		let liveAcct: Stripe.Account | null = null;
		if (!account.onboardingComplete) {
			liveAcct = await retrieveConnectAccount(account.stripeAccountId);
			if (liveAcct?.details_submitted) {
				const patch = stripeFlagPatchFromAccount(liveAcct);
				await db
					.update(stripeAccounts)
					.set({ ...patch, updatedAt: new Date() })
					.where(eq(stripeAccounts.stripeAccountId, account.stripeAccountId));
				// The row object above is stale the moment the patch writes; respond from the
				// patch so the creator is told Stripe's truth this load, not the pre-sync row.
				// ⚠️ The detail view is NOT preempted by this: a tab load that reconciles is
				// the one load that most needs the full shape, so detail falls through.
				if (c.req.query("detail") !== "1") {
					return c.json({
						hasAccount: true,
						stripeAccountId: account.stripeAccountId,
						chargesEnabled: patch.chargesEnabled,
						payoutsEnabled: patch.payoutsEnabled,
						onboardingComplete: patch.onboardingComplete,
						detailsSubmitted: liveAcct.details_submitted,
					});
				}
			}
		}

		/**
		 * The fuller view the Studio Payments tab renders, when it asks. `?detail` costs one
		 * more Stripe read (`accounts.retrieve` on a complete account, which the reconcile
		 * above may have just done), and every lightweight poller (`usePayoutsReady`, the
		 * settings summary card, the worklist) reads the cheap base shape without it.
		 */
		if (c.req.query("detail") === "1") {
			if (!liveAcct) liveAcct = await retrieveConnectAccount(account.stripeAccountId);
			if (liveAcct) {
				// The bank account carrying the payout: a debit card may ride alongside in
				// `external_accounts`, so the default flag is what names the payout account
				// and the first bank entry stands in when Stripe has not marked one.
				const ext = Array.isArray(liveAcct.external_accounts?.data)
					? liveAcct.external_accounts.data.find((e) => e.object === "bank_account")
					: undefined;
				const balance = await retrieveConnectBalance(account.stripeAccountId);
				return c.json({
					hasAccount: true,
					stripeAccountId: account.stripeAccountId,
					chargesEnabled: liveAcct.charges_enabled,
					payoutsEnabled: liveAcct.payouts_enabled,
					onboardingComplete: liveAcct.details_submitted && liveAcct.charges_enabled,
					/** Stripe's own view of what is missing — the "what" the refusal message promises. */
					requirements: {
						currentlyDue: liveAcct.requirements?.currently_due ?? [],
						pastDue: liveAcct.requirements?.past_due ?? [],
						pendingVerification: liveAcct.requirements?.pending_verification ?? [],
						disabledReason: liveAcct.requirements?.disabled_reason ?? null,
					},
					/** `interval: "manual"` is the decided default posture (the 2026-09-14 decision). */
					schedule: liveAcct.settings?.payouts?.schedule ?? null,
					externalAccount: ext
						? { bankName: ext.bank_name ?? null, last4: ext.last4 ?? null }
						: null,
					/**
					 * The connected account's own balance, in the currency's minor units; null when
					 * Stripe does not answer (unconfigured, or a transient read failure).
					 */
					balance:
						balance == null
							? null
							: {
									available: balance.available.map((b) => ({
										amount: b.amount,
										currency: b.currency,
									})),
									pending: balance.pending.map((b) => ({ amount: b.amount, currency: b.currency })),
								},
					detailsSubmitted: liveAcct.details_submitted,
				});
			}
		}

		return c.json({
			hasAccount: true,
			stripeAccountId: account.stripeAccountId,
			chargesEnabled: account.chargesEnabled,
			payoutsEnabled: account.payoutsEnabled,
			onboardingComplete: account.onboardingComplete,
			// The base shape answers from the row the webhook keeps; where the reconcile above
			// already asked Stripe this load, Stripe's answer is the fresher one.
			detailsSubmitted: liveAcct?.details_submitted ?? account.onboardingComplete,
		});
	})

	.post("/stripe/onboard", requireAuth, async (c) => {
		const user = c.get("user");
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// Check for existing Stripe account
		const [existing] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, user.id))
			.limit(1);

		if (existing?.onboardingComplete) {
			return c.json({ error: "Stripe account already onboarded" }, 400);
		}

		// Reuse an in-progress account; otherwise create a payouts-only Express account
		// (destination charges route money to it — it needs `transfers`, not to accept cards).
		let accountId = existing?.stripeAccountId;
		if (!accountId) {
			const account = await createConnectAccount({
				type: "express",
				email: user.email ?? undefined,
				capabilities: { transfers: { requested: true } },
				// Creator-chosen payouts (the 2026-09-14 decision) mean NO schedule until the
				// creator picks one; Stripe's Express default is daily, which would silently
				// enroll every creator here into an automatic payout posture Anthers did not
				// choose. Set at creation because the parameter is otherwise not ours to
				// change later — the Express Dashboard is where the creator adjusts it.
				settings: { payouts: { schedule: { interval: "manual" } } },
				metadata: { userId: String(user.id) },
			});
			// Null only when payments are unconfigured, which the guard above already refused.
			accountId = account?.id ?? "";
			if (!accountId) return c.json({ error: "Payments are not configured." }, 503);
			await db.insert(stripeAccounts).values({ userId: user.id, stripeAccountId: accountId });
		}

		// Return here after the hosted flow; the account.updated webhook syncs enablement.
		//
		// 🚨 **Both legs come from `STRIPE_RETURN_PATHS`, and typing one inline here is the
		// way to get it wrong.** This string is composed, handed to Stripe, and navigated by
		// somebody else's browser minutes later, so our own suite cannot make the request
		// that would find a bad one — a typecheck sees a valid string and every route test
		// passes. What a creator sees is the end of onboarding landing nowhere.
		const base =
			process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000";
		const link = await createAccountOnboardingLink({
			account: accountId,
			refresh_url: `${base}${STRIPE_RETURN_PATHS.connectRefresh}`,
			return_url: `${base}${STRIPE_RETURN_PATHS.connectReturn}`,
			type: "account_onboarding",
		});

		if (!link?.url) return c.json({ error: "Payments are not configured." }, 503);
		return c.json({ url: link.url });
	})
	// ── The Express Dashboard door ───────────────────────────────────────────
	.post("/stripe/dashboard-link", requireAuth, async (c) => {
		const user = c.get("user");
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		const [account] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, user.id))
			.limit(1);
		if (!account) {
			return c.json({ error: "Connect a Stripe account first." }, 409);
		}

		const url = await createAccountLoginLink(account.stripeAccountId);
		if (!url) return c.json({ error: "Payments are not configured." }, 503);
		return c.json({ url });
	})

	// ── Quote (accurate fee preview, no charge) ──────────────────────────────
	/**
	 * The store panel's two reads: what a good offers, and what a pick costs.
	 *
	 * 🚨 **The listing is public and the quote is signed in.** The goods rule is that a
	 * physical Work's page and its panel read without an account — a visitor may look at the
	 * shirt exactly as an account may — and creating an account is required only to buy.
	 * The quote needs a session because its tax estimate is resolved from the buyer's saved
	 * billing address, which is a fact about a person.
	 */
	.get("/physical/:slug", async (c) => {
		const found = await physicalStorefront(c.req.param("slug"), await getOptionalUserId(c));
		if (!found.ok) return c.json({ error: found.error }, found.status);
		return c.json({
			work: found.work,
			listing: found.listing,
			unitPrice: found.unitPrice.toFixed(2),
		});
	})

	.post(
		"/physical/:slug/quote",
		requireAuth,
		zValidator(
			"json",
			z.object({
				quantity: z.number().optional(),
				options: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const body = c.req.valid("json");
			const sale = await resolvePhysicalSale(c.req.param("slug"), user.id, {
				quantity: body.quantity,
				options: body.options,
			});
			if (!sale.ok) {
				return c.json(
					{ error: sale.error, ...("problems" in sale ? { problems: sale.problems } : {}) },
					sale.status,
				);
			}
			const saved = await savedBillingAddress(user.id);
			const { tax, quotedTo } = await quotePhysicalTax(saved, {
				goodsPrice: sale.goodsPrice,
				shippingPrice: sale.shippingPrice,
				taxCategory: sale.taxCategory,
			});
			const total = sale.goodsPrice.plus(sale.shippingPrice).plus(tax ? new Decimal(tax) : 0);
			return c.json({
				quantity: sale.quantity,
				unitPrice: sale.unitPrice.toFixed(2),
				goods: sale.goodsPrice.toFixed(2),
				shipping: sale.shippingPrice.toFixed(2),
				// Null when no saved address exists, or the estimate failed — the panel reads
				// that as "calculated at checkout" rather than inventing a figure.
				salesTax: tax,
				total: tax == null ? null : total.toFixed(2),
				quotedTo,
				picks: sale.picks,
				handlingBusinessDays: sale.handlingBusinessDays,
			});
		},
	)

	.get("/quote/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const q = await resolvePurchase(c.req.param("slug"), user.id);
		if (!q.ok) return c.json({ error: q.error }, q.status);
		const { amount, fees } = q;
		return c.json({
			amount: amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			// Real tax is resolved by Stripe Tax from the buyer's billing address at the
			// Checkout Session — Anthers' arithmetic cannot know the buyer's location, so
			// the quote presents no tax figure at all rather than an illustrative one
			// wearing the clothes of a charge. `null` is the contract: the buy surfaces
			// render "calculated at checkout" from it, and `buyerTotal` is the price.
			salesTax: null,
			buyerTotal: fees.buyerTotal.toFixed(2),
		});
	})

	// ── Checkout ─────────────────────────────────────────────────────────────
	.post("/checkout/:slug", requireAuth, requireVerified, async (c) => {
		const user = c.get("user");
		const q = await resolvePurchase(c.req.param("slug"), user.id);
		if (!q.ok) return c.json({ error: q.error }, q.status);
		const { work, amount, fees } = q;

		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// A connected creator is a HARD PRECONDITION, not a mode switch. Anthers does not
		// sell a creator's work when the money cannot reach them: this route used to fall
		// back to a plain platform-held charge "so the plumbing is testable before Connect
		// onboarding", but the buy UI has always refused to render without
		// `creatorHasStripe`, so that branch was unreachable from the product and would
		// have parked buyers' money in a platform balance nobody reconciles. Failing here
		// is louder and matches what the interface already promises.
		// A withdrawn Work outlives its creator's account, and nobody new may buy one:
		// there is no payee. Existing buyers are unaffected — `resolveAccess` reads
		// purchases, not this.
		if (work.creatorId == null) {
			return c.json({ error: "This work is no longer for sale." }, 409);
		}

		const [creatorAccount] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, work.creatorId))
			.limit(1);
		if (!creatorAccount?.onboardingComplete || !creatorAccount.payoutsEnabled) {
			return c.json({ error: "This creator can't accept payments yet." }, 409);
		}

		const totalCents = Math.round(fees.buyerTotal.toNumber() * 100);
		// The creator's share is not pinned here any more — the completion path reads it
		// off the row's recorded earnings and moves it as a transfer funded by the charge
		// (`completeSessionPurchases`). This route's job ends at the precondition above:
		// Anthers does not sell a creator's work when the money cannot reach them.

		// 🚨 Every line carries the product tax code for what the buyer receives, per the
		// posture's What Gets Taxed table. The connected-creator and type refusals above
		// mean `purchaseTaxCode` cannot return null here — but a future Work type lands
		// unmapped unless the mapping grows with it, so a null is a refusal rather than a
		// fallback to a generic code that would mis-tax the line in both directions.
		const taxCode = purchaseTaxCode(work.type as WorkType);
		if (!taxCode) {
			return c.json({ error: "This work can't be taxed yet, so it can't be sold." }, 400);
		}

		const session = await createCheckoutSession(
			purchaseSession({
				origin:
					process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000",
				lineItems: [workLineItem(work, totalCents, taxCode)],
				customerId: await stripeCustomerIdFor(user.id),
				customerEmail: user.email,
				metadata: {
					kind: "direct_purchase",
					workId: String(work.id),
					buyerId: String(user.id),
				},
			}),
		);
		if (!session?.client_secret) return c.json({ error: "Payments are not configured." }, 503);

		// Record the purchase as pending, keyed by the SESSION — the PaymentIntent does not
		// exist until the buyer confirms inside the session, and the webhook resolves the
		// session from the PaymentIntent's metadata when it does. Stamped with the real tax
		// and the buyer's location at completion, from the session.
		await db.insert(purchases).values({
			buyerId: user.id,
			workId: work.id,
			// Captured at the moment of sale, so the receipt survives the Work being
			// deleted or renamed later — see the schema note on these columns.
			creatorId: work.creatorId,
			workTitle: work.title,
			workType: work.type,
			workPublicId: work.publicId,
			type: "digital",
			amount: amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			// Zero until the webhook stamps what Stripe Tax actually collected — see the
			// schema note on the buyer_* columns.
			salesTax: "0.00",
			creatorEarnings: fees.creatorEarnings.toFixed(2),
			stripePaymentIntentId: session.id,
			status: "pending",
		});

		return c.json({
			amount: amount.toFixed(2), // the all-in list price the buyer was shown
			processingFee: fees.processingFee.toFixed(2), // out of the price, to Stripe
			// No figure: the tax is resolved at the session, from the buyer's address.
			salesTax: null,
			creatorEarnings: fees.creatorEarnings.toFixed(2), // price − processing
			buyerTotal: null, // the total lives in the session, with the tax in it
			// The Checkout Session's client secret — the browser mounts Checkout from it.
			clientSecret: session.client_secret,
		});
	})

	/**
	 * The signed-in buyer's server-side basket.
	 *
	 * 🚨 **These routes are the basket's only writers and users, and `resolveBasket` is
	 * never bypassed.** The table holds ids and nothing more; quote and checkout re-resolve
	 * exactly what the client-supplied list used to be re-resolved against — so a row that
	 * fell out of purchasability (withdrawn, already owned, moved behind a higher gate,
	 * creator unconnected) is refused with the same sentence at the same door it always was.
	 * `list` returns only what resolves, so a badge counts Work the buyer could actually be
	 * charged for and nothing else.
	 *
	 * The basket carries any number of creators (Parker, 2026-10-15): `add` appends in
	 * `services/basket.ts` — the sign-in merge and the Work-page button go through the
	 * same function, so they cannot disagree — and the one charge the checkout builds is
	 * settled per creator at completion (`services/purchase-split.ts`).
	 */
	// What the header badge and the basket page read. Resolved live, per read: a Work
	// that stopped being buyable does not count — the buyer is never teased with a badge
	// for something their money cannot reach. Price and creator handle come off the same
	// resolution, so the receipt's line items and the page's creator line read the
	// server's numbers, exactly as the quote's always did.
	.get("/basket", requireAuth, async (c) => {
		const user = c.get("user");
		const items = await resolvedBasketItems(user.id);
		return c.json({ items, count: items.length });
	})

	.post("/basket/items", requireAuth, async (c) => {
		const user = c.get("user");
		const body = await c.req.json().catch(() => null);
		// A line names a Work or a Badge rung — never both. The Badge add carries its own
		// refusal (nobody buys their own ladder), answered the same moment the click asks.
		const workId = Number(body?.workId);
		const badgeId = Number(body?.badgeId);
		const hasWork = Number.isInteger(workId) && workId > 0;
		const hasBadge = Number.isInteger(badgeId) && badgeId > 0;
		if (hasWork === hasBadge)
			return c.json({ error: "Name exactly one thing: a Work id or a Badge id." }, 400);

		if (hasBadge) {
			const result = await addBasketBadge(user.id, badgeId);
			if (!result.ok) {
				if (result.reason === "at_capacity") {
					return c.json({ error: "Your basket is full.", code: "at_capacity" }, 409);
				}
				if (result.reason === "own_ladder") {
					return c.json({ error: "You cannot hold your own Badge.", code: result.reason }, 400);
				}
				return c.json({ error: "Badge not found", code: result.reason }, 404);
			}
		} else {
			// A physical line carries what the buyer chose and how many — the same body a
			// second press of Add sends, so a buyer who opens the picker again replaces the
			// line rather than being told it is already there.
			const quantity = Number(body?.quantity);
			const options = Array.isArray(body?.options)
				? (body.options as Array<{ name?: unknown; label?: unknown }>)
						.map((entry) => ({
							name: String(entry?.name ?? ""),
							label: String(entry?.label ?? ""),
						}))
						.filter((entry) => entry.name && entry.label)
				: null;
			const result = await addBasketItem(
				user.id,
				workId,
				options || Number.isInteger(quantity)
					? {
							quantity: Number.isInteger(quantity) && quantity > 0 ? quantity : undefined,
							options,
						}
					: undefined,
			);
			if (!result.ok) {
				// 404 names the Work (gone before it could be held); 409 names the basket (full).
				// Both are refusals the buyer can act on at the moment of the click, which is
				// the whole courtesy — the alternative was discovering both at checkout.
				if (result.reason === "at_capacity") {
					return c.json({ error: "Your basket is full.", code: "at_capacity" }, 409);
				}
				return c.json({ error: "Work not found", code: result.reason }, 404);
			}
		}
		// Answer with the post-add basket so the client's optimistic update can reconcile
		// against the truth in one round trip — each item resolved exactly as `/basket`
		// resolves it.
		const items = await resolvedBasketItems(user.id);
		return c.json({ items });
	})

	/**
	 * Change what a basket line asks for — the basket page's quantity stepper and picker.
	 *
	 * The same validation the checkout runs is NOT repeated here: the line is intent, and
	 * a count somebody may no longer have is the quote's refusal to give, in its own words,
	 * where the money is. This route only refuses a Work that is not in the basket.
	 */
	.put(
		"/basket/items/:workId",
		requireAuth,
		zValidator(
			"json",
			z.object({
				quantity: z.number().optional(),
				options: z.array(z.object({ name: z.string(), label: z.string() })).optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const workId = Number(c.req.param("workId"));
			if (!Number.isInteger(workId) || workId <= 0) return c.json({ error: "Work not found" }, 404);
			const body = c.req.valid("json");
			const quantity = Number(body?.quantity);
			const options = Array.isArray(body?.options)
				? (body.options as Array<{ name?: unknown; label?: unknown }>)
						.map((entry) => ({
							name: String(entry?.name ?? ""),
							label: String(entry?.label ?? ""),
						}))
						.filter((entry) => entry.name && entry.label)
				: undefined;
			const result = await updateBasketItem(user.id, workId, {
				...(Number.isInteger(quantity) && quantity > 0 ? { quantity } : {}),
				...(options !== undefined ? { options } : {}),
			});
			if (!result.ok) return c.json({ error: "That Work isn't in your basket." }, 404);
			return c.json({ items: await resolvedBasketItems(user.id) });
		},
	)

	.delete("/basket/items/:workId", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("workId"));
		if (!Number.isInteger(workId) || workId <= 0) return c.json({ error: "Work not found" }, 404);
		await removeBasketItem(user.id, workId);
		return c.json({ items: await resolvedBasketItems(user.id) });
	})

	.delete("/basket/badges/:badgeId", requireAuth, async (c) => {
		const user = c.get("user");
		const badgeId = Number(c.req.param("badgeId"));
		if (!Number.isInteger(badgeId) || badgeId <= 0)
			return c.json({ error: "Badge not found" }, 404);
		await removeBasketBadge(user.id, badgeId);
		return c.json({ items: await resolvedBasketItems(user.id) });
	})

	.delete("/basket", requireAuth, async (c) => {
		const user = c.get("user");
		await clearBasket(user.id);
		return c.json({ items: [] });
	})

	/**
	 * What a basket would cost, without creating anything. The buy UI quotes from here so
	 * the saving is visible *before* the decision, which is the whole reason a basket is
	 * worth building rather than a convenience.
	 */
	.post("/basket/quote", requireAuth, async (c) => {
		const user = c.get("user");
		// 🚨 **The resolved basket is the source of the ids; the request body never was.**
		// The account's table is asked through the SAME resolution `/basket` answers with —
		// so a row that stopped being buyable is excluded here exactly as the badge
		// excluded it, and the buyer is never failed by an item they cannot see or remove.
		// What remains is then re-resolved by `resolveStoredBasket` below, whose refusal
		// paths (the cap, the per-item rules, the ratchet) keep firing.
		const stored = await resolvedBasketItems(user.id);
		const rows = stored.map(
			(item): StoredBasketRow =>
				item.kind === "badge"
					? { kind: "badge", badgeId: item.badgeId as number }
					: {
							kind: "work",
							workId: item.workId as number,
							slug: item.slug as string,
							quantity: item.quantity,
							options: item.options ?? null,
						},
		);
		// A line the buyer can fix (a count past the shelf) is refused here, in its own
		// words, rather than priced around: a basket total that quietly omits what the page
		// is showing is the one number a buyer must never be given.
		const blocked = stored.find((item) => item.error);
		if (blocked?.error) return c.json({ error: blocked.error }, 400);

		const q = await resolveStoredBasket(rows, user.id, { needsProduct: false });
		if (!q.ok) return c.json({ error: q.error, code: "code" in q ? q.code : undefined }, q.status);

		// What the same items would have cost bought one at a time. Not decoration: it is
		// the number that makes the basket legible, and it is derived rather than typed —
		// `cardFee` per item, summed, against one `cardFee` on the subtotal. Badge lines
		// count identically: a Badge's first Month bought beside a Work shares the flat
		// fee, which is the saving Parker's batching decision priced.
		const separately = q.items.reduce(
			(acc, i) => acc.plus(calculateFees(i.amount, { type: "digital" }).processingFee),
			new Decimal(0),
		);

		// The creator groups the basket page renders — one per distinct creator, each with
		// a receives figure summed from that creator's own lines (price less the line's
		// pinned fee share), so the groups reconstruct the whole basket's take exactly: the
		// last line's rounding remainder lands wherever the last line's issuer is, and the
		// per-group sums still add up. The line shares are pinned IN the resolution now, so
		// the quote, the checkout's rows and the badge rows all read the same figures. Badge
		// lines carry their issuer's receives figure too — the money settles through the
		// cycle distribution rather than a transfer, and it is the same arithmetic either way.
		const byCreator = new Map<number, { receives: Decimal; itemCount: number }>();
		q.items.forEach((i) => {
			const cid = i.kind === "work" ? (i.work.creatorId as number) : i.issuer.id;
			const group = byCreator.get(cid) ?? { receives: new Decimal(0), itemCount: 0 };
			// The creator pays the carrier, so the shipping on their line is theirs — it
			// rides their receives figure and their row's earnings, never Anthers'.
			const shipping = i.kind === "work" && i.physical ? i.physical.shippingOnLine : new Decimal(0);
			group.receives = group.receives.plus(i.amount).plus(shipping).minus(i.lineFee);
			group.itemCount += 1;
			byCreator.set(cid, group);
		});
		const creatorIdList = [...byCreator.keys()];
		const handleRows = creatorIdList.length
			? await db
					.select({ id: users.id, handle: users.atprotoHandle })
					.from(users)
					.where(inArray(users.id, creatorIdList))
			: [];

		return c.json({
			items: q.items.map((i) =>
				i.kind === "work"
					? {
							kind: "work" as const,
							workId: i.work.id,
							slug: i.work.slug,
							title: i.work.title,
							type: i.work.type,
							thumbnail: i.work.thumbnail,
							// This line's own share of the basket's ONE card fee — pro-rata by value,
							// the same apportionment the purchase rows are written with. The
							// receipt's creator group reads it, so the receives line's tooltip can
							// name what was taken out of this creator's part of the basket.
							processingFee: i.lineFee.toFixed(2),
							price: i.amount.toFixed(2),
							recurring: null,
							// A physical line's count and the shipping charged on it — the
							// basket page's quantity control and its shipping row read these.
							quantity: i.physical?.quantity ?? 1,
							options: i.physical?.picks ?? null,
							shipping: (i.physical?.shippingOnLine ?? new Decimal(0)).toFixed(2),
						}
					: {
							kind: "badge" as const,
							badgeId: i.badge.id,
							title: i.badge.label,
							thumbnail: null,
							processingFee: i.lineFee.toFixed(2),
							price: i.amount.toFixed(2),
							// The monthly price this line begins — the rung's threshold — beside
							// the first transaction's price, so an upgrade line reads as the
							// upgrade it is rather than a discount.
							recurring: i.threshold.toFixed(2),
							quantity: 1,
						},
			),
			// One entry per creator the charge covers, in the order the basket named them.
			creators: creatorIdList.map((cid) => ({
				handle: handleRows.find((r) => r.id === cid)?.handle ?? null,
				itemCount: byCreator.get(cid)!.itemCount,
				receives: byCreator.get(cid)!.receives.toFixed(2),
			})),
			subtotal: q.subtotal.toFixed(2),
			processingFee: q.fees.processingFee.toFixed(2),
			salesTax: q.fees.salesTax.toFixed(2),
			creatorEarnings: q.fees.creatorEarnings.toFixed(2),
			buyerTotal: q.fees.buyerTotal.toFixed(2),
			/** Card fees if these were bought separately, and what the basket saves. */
			feeSeparately: separately.toFixed(2),
			creatorGains: separately.minus(q.fees.processingFee).toFixed(2),
		});
	})

	/**
	 * Buy a basket on one charge — one Checkout Session, one card fee, one row per item.
	 *
	 * Deliberately a sibling of `/checkout/:slug` rather than a replacement: a single
	 * purchase is the overwhelming case and there is no reason to make it travel through
	 * a list. What the two must share is the *money*, and they do — both quote
	 * `calculateFees`, both charge through a Checkout Session with automatic tax. The
	 * creator's money does not ride the session any more: it moves out per creator at
	 * completion, funded by the charge (the platform-charge split).
	 */
	.post("/basket/checkout", requireAuth, requireVerified, async (c) => {
		const user = c.get("user");
		// Same rule as quote: the account's resolved basket is what's bought — an item
		// that stopped being buyable is excluded by the same resolution the page showed,
		// and what remains is re-resolved by `resolveStoredBasket` below, whose refusal
		// paths keep firing on it. Nothing trusts the table further than the client's old
		// word was trusted.
		const stored = await resolvedBasketItems(user.id);
		const rows = stored.map(
			(item): StoredBasketRow =>
				item.kind === "badge"
					? { kind: "badge", badgeId: item.badgeId as number }
					: {
							kind: "work",
							workId: item.workId as number,
							slug: item.slug as string,
							quantity: item.quantity,
							options: item.options ?? null,
						},
		);
		const blocked = stored.find((item) => item.error);
		if (blocked?.error) return c.json({ error: blocked.error }, 400);

		// The resolution runs BEFORE the processor guard — the refusals are the database's
		// business and must fire without Stripe — and the rung's Product, the one
		// processor-dependent piece, is priced only when a session could be built at all.
		const q = await resolveStoredBasket(rows, user.id, {
			atCheckout: true,
			needsProduct: paymentsConfigured(),
		});
		if (!q.ok) return c.json({ error: q.error, code: "code" in q ? q.code : undefined }, q.status);

		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// Same hard precondition as a single purchase, now per issuer: Anthers does not
		// sell a creator's work when the money cannot reach them — and a basket can ask
		// for several creators' money to move at once, so every one of them must be
		// reachable before the buyer is charged. A Badge issuer's reachability matters just
		// as much (their share moves at the cycle's settlement) — the one exception is
		// Anthers' own ladder, whose money is already platform-side by construction and for
		// whom no transfer exists to be blocked.
		const anthersId = await anthersUserId();
		if (q.creatorIds.some((id) => id == null))
			return c.json({ error: "This work is no longer for sale." }, 409);
		// The null case is refused above; the type guard is what keeps the Stripe read's
		// array honest rather than the check doing it silently.
		const creatorsToCheck = q.creatorIds.filter(
			(id): id is number => id != null && id !== anthersId,
		);
		const accounts = creatorsToCheck.length
			? await db
					.select()
					.from(stripeAccounts)
					.where(inArray(stripeAccounts.userId, creatorsToCheck))
			: [];
		for (const creatorId of creatorsToCheck) {
			const account = accounts.find((a) => a.userId === creatorId);
			if (!account?.onboardingComplete || !account.payoutsEnabled) {
				return c.json({ error: "This creator can't accept payments yet." }, 409);
			}
		}

		// 🚨 **A basket the buyer already has a live session for is not charged twice, and
		// the intent is not spent until the money moves** (Parker, 2026-10-19). The basket
		// used to be emptied the moment this route built a session — which is the moment
		// the basket page loads — so opening the page and leaving without paying erased
		// what the buyer had chosen. Now a revisit with the same basket gets the same open
		// session back; a session built for a basket that has since changed is expired, its
		// pending rows failed, and a fresh one is built below.
		const workLinesForSession = q.items.filter(
			(i): i is Extract<typeof i, { kind: "work" }> => i.kind === "work",
		);
		const badgeLinesForSession = q.items.filter(
			(i): i is Extract<typeof i, { kind: "badge" }> => i.kind === "badge",
		);
		const known = await resumeBasketSession(
			user.id,
			basketPicksKey(workLinesForSession, badgeLinesForSession),
		);
		if (known?.state === "confirming") {
			// The payment for this basket already went through and its webhook has not
			// landed yet. A second session here is a second charge for the same basket.
			return c.json(
				{ error: "Your payment is being confirmed — this basket clears in a moment." },
				409,
			);
		}
		if (known?.state === "resume" && known.session.client_secret) {
			return c.json({
				subtotal: q.subtotal.toFixed(2),
				processingFee: q.fees.processingFee.toFixed(2),
				salesTax: null,
				creatorEarnings: q.fees.creatorEarnings.toFixed(2),
				buyerTotal: null,
				itemCount: q.items.length,
				clientSecret: known.session.client_secret,
			});
		}

		/**
		 * 🚨 **A physical good's count comes off the shelf before the session is built.** A
		 * reservation made after the charge would let two buyers win the last one; one made
		 * at session build is the only moment early enough to refuse the second buyer in
		 * their own checkout. The reservation is released if anything below fails, and a
		 * session the buyer walks away from has its count returned by the sweep
		 * (`releaseAbandonedStock`) once it expires.
		 */
		const physicalLines = q.items.filter(
			(i): i is Extract<typeof i, { kind: "work" }> => i.kind === "work" && Boolean(i.physical),
		);
		const reserve = physicalLines.map((line) => ({
			workId: line.work.id,
			picks: line.physical?.picks ?? [],
			quantity: line.physical?.quantity ?? 1,
		}));
		const reserved = await reserveStock(reserve);
		if (!reserved.ok) {
			return c.json(
				{
					error: reserved.problems[0]?.message ?? "That choice sold out while you were looking.",
					problems: reserved.problems,
				},
				409,
			);
		}
		/** Return every reservation this route made — the one undo for the whole block. */
		const undoReservation = async () => {
			await releaseStock(reserve).catch((err) => {
				// A failed release leaves stock held for the sweep, which is the safe
				// direction; it must not mask the checkout's own refusal.
				console.error("physical stock release failed after a refused checkout", err);
			});
		};

		// One line per Work, each with its own tax code — a basket can span media, and a
		// video and an image are not taxed as the same thing in every jurisdiction. A
		// Badge line names its rung's own Product, whose tax code the rung's own kinds
		// stamped (`ensureBadgeProduct`).
		const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
		for (const item of q.items) {
			if (item.kind === "work") {
				const { work, amount } = item;
				const taxCode = purchaseTaxCode(work.type as WorkType);
				// `resolvePurchase` already refused the types with no code, so this is the
				// belt on a door the single-purchase path refuses at.
				if (!taxCode) {
					await undoReservation();
					return c.json({ error: "This work can't be taxed yet, so it can't be sold." }, 400);
				}
				lineItems.push(
					workLineItem(work, Math.round(amount.toNumber() * 100), taxCode, {
						// The count on the receipt is the count the creator packs.
						quantity: item.physical?.quantity ?? 1,
						// The choices read on the receipt line, because "T-shirt" alone does
						// not tell a creator which shirt to pick off the shelf.
						variant: item.physical?.picks.map((pick) => `${pick.name}: ${pick.label}`),
					}),
				);
			} else {
				// The product was priced when the processor was configured (the guard above
				// runs before the resolution, with `needsProduct` on its answer); the belt
				// refuses rather than building a session with an unnamed product.
				if (!item.product) return c.json({ error: "Payments are not configured." }, 503);
				lineItems.push(badgeLineItem(item.product, Math.round(item.amount.toNumber() * 100)));
			}
		}

		/**
		 * One shipping line per creator, charged once for their parcel(s).
		 *
		 * ⚠️ **A line item, not the session's `shipping_cost`.** Checkout carries exactly one
		 * `shipping_cost`, and a basket can hold goods from several creators who each post a
		 * box; naming the charge as its own line is what lets each one be taxed with
		 * `SHIPPING_TAX_CODE` and appear on the receipt as the delivery it is.
		 */
		const shippingByCreator = new Map<number, { handle: string; cents: number }>();
		for (const line of physicalLines) {
			const shipping = line.physical?.shippingOnLine ?? new Decimal(0);
			if (shipping.lte(0) || line.work.creatorId == null) continue;
			const [creator] = await db
				.select({ handle: users.atprotoHandle })
				.from(users)
				.where(eq(users.id, line.work.creatorId))
				.limit(1);
			shippingByCreator.set(line.work.creatorId, {
				handle: creator?.handle ?? "the creator",
				cents: Math.round(shipping.toNumber() * 100),
			});
		}
		for (const shipping of shippingByCreator.values()) {
			lineItems.push(shippingLineItem(shipping.handle, shipping.cents));
		}

		// 🚨 **The card rides only when a Badge's recurrence needs it.** A charge that carries
		// a Badge starts a monthly subscription's line at the next 1st, and a buyer without
		// a support subscription has nothing on file to bill it with — purchase checkouts
		// never save a card for a plain purchase (2026-10-06), and they keep not saving one
		// where no recurrence awaits. When a Badge rides and no active subscription exists,
		// the session saves the payment method; the completion links it to the subscription
		// it builds. Probe the consent block at implementation (the 2026-10-06 Link incident
		// lives exactly here).
		const saveCard =
			q.items.some((i) => i.kind === "badge") && !(await hasActiveSupportSubscription(user.id));

		const workLines = workLinesForSession;
		const badgeLines = badgeLinesForSession;

		const session = await createCheckoutSession(
			purchaseSession({
				origin:
					process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000",
				lineItems,
				customerId: await stripeCustomerIdFor(user.id),
				customerEmail: user.email,
				saveCard,
				// A charge carrying goods needs somewhere to send them, and the address the
				// buyer confirms is what the creator ships to. Checkout collects it in its own
				// step; the completion stamps it onto the purchase rows, which is where the
				// creator's order list reads it from.
				shippingAddress: physicalLines.length > 0 ? "us" : undefined,
				metadata: {
					kind: "direct_purchase_basket",
					workIds: workLines.map((i) => i.work.id).join(","),
					badgeIds: badgeLines.map((i) => i.badge.id).join(","),
					buyerId: String(user.id),
					// What the buyer asked for, not merely which Works: a count or a size
					// changed between two visits is a different basket, and a session built
					// for the old one must not be handed back (see `resumeBasketSession`).
					contentKey: basketPicksKey(workLines, badgeLines),
				},
			}),
		);
		if (!session?.client_secret) {
			await undoReservation();
			return c.json({ error: "Payments are not configured." }, 503);
		}

		/**
		 * One row per Work, all sharing the PaymentIntent — because access, refunds and
		 * the buyer's Library are all **per Work** and must stay that way. The basket is a
		 * property of the *charge*, not of the entitlement.
		 *
		 * 🚨 The per-item money is the resolution's PINNED line share, not a recomputation —
		 * `calculateFees` on a $1 item would attach a fresh $0.30 to it, so the rows would
		 * sum to far more than was charged and every downstream user — earnings, the tax
		 * remittance record, refunds — would be wrong. The fee is split **pro-rata by item
		 * value across every line of the charge** (Works and Badges alike), with the last
		 * row absorbing the rounding remainder so the parts sum to the whole exactly.
		 */
		const purchaseRows = workLines.map(({ work, amount, lineFee, physical }) => {
			// The session's tax is stamped per charge at completion and apportioned across
			// the rows then; at checkout every row is zero, because Anthers' arithmetic
			// knows no buyer location. The apportioning still runs so the shape of the
			// row building is unchanged, and a zero total apportions to zero exactly.
			//
			// A good's row carries three things no digital row does — the count, the
			// choices, and the shipping the creator receives — and its earnings include
			// that shipping, because the creator is the one paying the carrier.
			const shipping = physical?.shippingOnLine ?? new Decimal(0);
			return {
				buyerId: user.id,
				workId: work.id,
				creatorId: work.creatorId,
				workTitle: work.title,
				workType: work.type,
				workPublicId: work.publicId,
				type: (physical ? "physical" : "digital") as "physical" | "digital",
				amount: amount.toFixed(2),
				processingFee: lineFee.toFixed(2),
				salesTax: "0.00",
				creatorEarnings: amount.plus(shipping).minus(lineFee).toFixed(2),
				quantity: physical?.quantity ?? 1,
				options: physical?.picks ?? null,
				shippingAmount: shipping.toFixed(2),
				handlingBusinessDays: physical?.handlingBusinessDays ?? null,
				// The session id, as on the single-purchase path — the PaymentIntent is
				// resolved from the session at completion and the rows re-keyed to it.
				stripePaymentIntentId: session.id,
				status: "pending" as const,
			};
		});
		if (purchaseRows.length > 0) await db.insert(purchases).values(purchaseRows);

		/**
		 * One row per Badge — the first transaction's money record, `badge_charges`. The
		 * line share is the resolution's pinned figure, the cycle is the one the first
		 * Month covers (today's — a checkout left pending past a cycle turn is the
		 * webbhook's problem, rows keyed `pending` waiting for it), and status rides the
		 * same pending latch the purchase rows use: the completion owns every stamp.
		 */
		const badgeChargeRows = badgeLines.map((item) => ({
			buyerId: user.id,
			badgeId: item.badge.id,
			creatorId: item.issuer.id,
			badgeLabel: item.badge.label,
			threshold: item.threshold.toFixed(2),
			chargedAmount: item.amount.toFixed(2),
			processingFee: item.lineFee.toFixed(2),
			billingCycle: currentCycleKey(),
			stripePaymentIntentId: session.id,
			status: "pending" as const,
		}));
		if (badgeChargeRows.length > 0) await db.insert(badgeCharges).values(badgeChargeRows);

		// 🚨 **The basket is NOT cleared here** (Parker, 2026-10-19). This route runs the
		// moment the basket page mounts — it is how the embedded checkout gets its client
		// secret — so clearing here meant opening the basket and walking away erased it.
		// The rows now leave when the charge completes (`completeSessionPurchases` clears
		// exactly the ids the session carried), or when the buyer empties the basket
		// themselves. The purchase and Badge-charge rows above are the money's record and
		// are already keyed to this session; abandoning it leaves them pending, and the
		// next `/basket/checkout` either resumes this session or fails them.
		return c.json({
			subtotal: q.subtotal.toFixed(2),
			processingFee: q.fees.processingFee.toFixed(2),
			// No figure — the tax is resolved at the session, from the buyer's address.
			salesTax: null,
			creatorEarnings: q.fees.creatorEarnings.toFixed(2),
			buyerTotal: null,
			itemCount: q.items.length,
			// The Checkout Session's client secret — the browser mounts Checkout from it.
			clientSecret: session.client_secret,
		});
	})

	/**
	 * **Buy a Badge now** — the rung's first Month, on its own charge, bypassing the
	 * basket. Same money as a basket checkout of one Badge line: the rung's Product, the
	 * delta-first-transaction pricing, the same rows, the same completion. The basket the
	 * buyer already carries is untouched — buy-now is the one item the buyer pointed at,
	 * not a replacement of what they were assembling.
	 */
	.post("/badges/checkout", requireAuth, requireVerified, async (c) => {
		const user = c.get("user");
		const body = await c.req.json().catch(() => null);
		const badgeId = Number(body?.badgeId);
		if (!Number.isInteger(badgeId) || badgeId <= 0)
			return c.json({ error: "Badge not found" }, 404);

		// Same discipline as the basket checkout: the resolution (and its refusals) is the
		// database's business and never needs the processor; the rung's Product is priced
		// only when a session could be built at all, and the guard below answers for the
		// unconfigured case after the refusals had their word.
		const one = await resolveBadgePurchase(badgeId, user.id, {
			atCheckout: true,
			needsProduct: paymentsConfigured(),
		});
		if (!one.ok) return c.json({ error: one.error, code: one.code }, one.status);
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// The Issuer's connected account — the Anthers ladder takes no transfer (its money
		// is already platform-side), so it is the one issuer this precondition skips; the
		// basket checkout's loop carries the same exception with the same reason.
		if (one.issuer.id !== (await anthersUserId())) {
			const [account] = await db
				.select()
				.from(stripeAccounts)
				.where(eq(stripeAccounts.userId, one.issuer.id))
				.limit(1);
			if (!account?.onboardingComplete || !account.payoutsEnabled)
				return c.json({ error: "This creator can't accept payments yet." }, 409);
		}

		// One line, the whole charge — the fee's full share is its line share, the same
		// worst case a lone monthly support charge bears ($3.00 gross → $2.61 to the
		// creator, and the arithmetic says so below without a second opinion). The
		// product is priced when the processor is configured — the guard above — so a
		// null can no longer reach here; the belt refuses rather than building a session
		// with an unnamed product.
		if (!one.product) return c.json({ error: "Payments are not configured." }, 503);
		const fees = calculateFees(one.amount, { type: "digital" });
		const lineItems = [badgeLineItem(one.product, Math.round(one.amount.toNumber() * 100))];

		// The card rides when the recurrence needs it — see the basket checkout's note; a
		// Badge bought now must recur for the same reason one saved to a basket must.
		const saveCard = !(await hasActiveSupportSubscription(user.id));

		const session = await createCheckoutSession(
			purchaseSession({
				origin:
					process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000",
				lineItems,
				customerId: await stripeCustomerIdFor(user.id),
				customerEmail: user.email,
				saveCard,
				metadata: {
					kind: "direct_purchase_badge",
					badgeIds: String(one.badge.id),
					buyerId: String(user.id),
				},
			}),
		);
		if (!session?.client_secret) return c.json({ error: "Payments are not configured." }, 503);

		await db.insert(badgeCharges).values({
			buyerId: user.id,
			badgeId: one.badge.id,
			creatorId: one.issuer.id,
			badgeLabel: one.badge.label,
			threshold: one.threshold.toFixed(2),
			chargedAmount: one.amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			billingCycle: currentCycleKey(),
			stripePaymentIntentId: session.id,
			status: "pending",
		});

		return c.json({
			subtotal: one.amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			salesTax: null,
			buyerTotal: null,
			// The Checkout Session's client secret — the browser mounts Checkout from it.
			clientSecret: session.client_secret,
		});
	})

	// ── Ownership Check ──────────────────────────────────────────────────────
	.get("/owns/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [work] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		// "Owns" = can consume it now: creator, free, a prior purchase, or an
		// entitlement grant (a gate their monthly support clears). resolveAccess unifies all four.
		const access = await resolveAccess(work, user.id);
		return c.json({ owns: access.canAccess });
	})

	// ── Purchase History ─────────────────────────────────────────────────────
	.get("/purchases", requireAuth, async (c) => {
		const user = c.get("user");
		const month = c.req.query("month"); // optional YYYY-MM filter

		const conditions = [eq(purchases.buyerId, user.id), eq(purchases.status, "completed")];

		if (month) {
			// `new Date("YYYY-MM-01T00:00:00")` with no zone is parsed as LOCAL midnight, so
			// this window was offset from the UTC timestamps it filters by.
			const start = cycleStart(`${month}-01`);
			const end = cycleEnd(`${month}-01`);
			conditions.push(gte(purchases.createdAt, start));
			conditions.push(lte(purchases.createdAt, end));
		}

		// Both joins are LEFT joins, and the creator side hangs off `purchases.creatorId`
		// rather than `works.creatorId` (`0016`). As inner joins through `works` this
		// endpoint dropped a purchase entirely once its Work was deleted — the buyer's
		// own receipt vanished from their history, which is the one place it has to
		// remain. A support top-up (no Work at all) was never listed here for the same reason.
		const result = await db
			.select({
				purchase: purchases,
				workSlug: works.slug,
				// The LIVE publicId, not the snapshot one on the purchase row. Both exist and
				// they answer different questions: the snapshot says *which Work this receipt
				// is for* and survives the Work's removal, while this one says *whether there
				// is still a page to open* — so it must go null with the Work, exactly as slug
				// and cover do. Sending the snapshot here would hand the buyer a link to a 404.
				workLivePublicId: works.publicId,
				workVisibility: works.visibility,
				// Stamped by `0017` when a purchased Work is withdrawn rather than
				// destroyed. The Library counts the rescue window from it, and the
				// buyer's card is the only surface that can tell them the clock exists.
				workWithdrawnAt: works.withdrawnAt,
				workThumbnail: works.thumbnail,
				creatorHandle: users.atprotoHandle,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(purchases)
			.leftJoin(works, eq(purchases.workId, works.id))
			.leftJoin(users, eq(purchases.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(purchases.createdAt));

		return c.json({
			purchases: result.map((r) => ({
				...r.purchase,
				work: {
					// Title and type come from the stored snapshot, not the join, so they
					// still read correctly for a Work that no longer exists. Slug, publicId,
					// visibility and thumbnail deliberately do NOT: they only exist to link and
					// illustrate, and a deleted Work has no page to link to — null is the
					// honest answer.
					title: r.purchase.workTitle,
					slug: r.workSlug,
					publicId: r.workLivePublicId,
					// `withdrawn` means the creator pulled it from circulation and the buyer
					// keeps it (`0017`). They can still open it, but it is no longer public,
					// and their Library is the only place that can tell them so.
					visibility: r.workVisibility,
					withdrawnAt: r.workWithdrawnAt,
					thumbnail: r.workThumbnail,
					type: r.purchase.workType,
				},
				creator: {
					handle: r.creatorHandle,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
			})),
		});
	})

	// ── Refund ───────────────────────────────────────────────────────────────
	// Buyer-initiated. "Ask us and we will refund you" — no justification is
	// required and none is asked for, so `reason` is optional and free text kept
	// for our own reading, never a condition of the refund (Terms of Service § Refunds).
	.post("/purchases/:id/refund", requireAuth, async (c) => {
		const user = c.get("user");
		const id = Number(c.req.param("id"));
		if (!Number.isInteger(id)) return c.json({ error: "Purchase not found" }, 404);

		const body = await c.req.json().catch(() => ({}) as { reason?: unknown });
		const reason = typeof body.reason === "string" ? body.reason.slice(0, 500).trim() : undefined;

		// Scoped to the caller's own purchases: a buyer may only refund what they
		// bought, and a stranger must not learn whether a purchase id exists.
		const [purchase] = await db
			.select()
			.from(purchases)
			.where(and(eq(purchases.id, id), eq(purchases.buyerId, user.id)))
			.limit(1);
		if (!purchase) return c.json({ error: "Purchase not found" }, 404);

		const result = await refundPurchase(purchase, { initiator: "buyer", reason });
		if (!result.ok) {
			// 409 for the cap, because the request is well-formed and the purchase is
			// real — it just needs a person. 503 keeps parity with every other route
			// here when Stripe isn't configured.
			const status =
				result.code === "review_required"
					? (409 as const)
					: result.code === "not_configured"
						? (503 as const)
						: result.code === "not_refundable"
							? (400 as const)
							: (502 as const);
			return c.json({ error: result.message, code: result.code }, status);
		}

		// The route refund's own receipt. Stripe reports a per-item refund as a partial
		// charge refund, which the webhook's guard passes over, so this is where the
		// buyer (and creator) are emailed; the Stripe event that the action provokes
		// arrives at the webhook's wholly-refunded branch for single-item purchases and
		// latches on the same refund id, mailing nobody twice. A settled row carries the
		// refund id; an `alreadyRefunded` result settled nothing and is not re-mailed.
		if (!result.alreadyRefunded) {
			await sendRefundReceipts([result.purchase]);
		}

		return c.json({
			refunded: true,
			alreadyRefunded: result.alreadyRefunded,
			amount: new Decimal(purchase.amount).plus(purchase.salesTax).toFixed(2),
			refundsRemaining: Math.max(
				0,
				REFUND_AUTO_CAP - (await refundsAfterDownloadInWindow(user.id)),
			),
		});
	})

	// ── Stripe Webhook ───────────────────────────────────────────────────────
	.post("/stripe/webhook", async (c) => {
		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		const sig = c.req.header("stripe-signature");

		/**
		 * TWO signing secrets, because Stripe scopes event destinations and gives each its
		 * own — and this one URL serves both.
		 *
		 * `STRIPE_WEBHOOK_SECRET` signs the *your account* destination: purchases,
		 * subscriptions, refunds. `STRIPE_CONNECT_WEBHOOK_SECRET` signs the *connected
		 * accounts* destination, which is the only way `account.updated` for a creator's
		 * Connect account is ever delivered. A single-secret handler cannot serve both: one
		 * destination's deliveries would fail verification, which is indistinguishable from
		 * the endpoint being misconfigured — the exact failure that left production with no
		 * working webhook at all until 2026-08-15.
		 *
		 * Trying each is not a weakening. Both secrets are ours, each is a legitimate signer
		 * for its own destination, and a forged request still has to match one of them.
		 * Stripe itself relies on this shape: rolling an endpoint's secret leaves the old and
		 * new both active for up to 24 hours, signing one signature per secret.
		 *
		 * The connect secret is optional — with only the primary set this behaves exactly as
		 * it did before, which is what keeps dev and any half-configured environment working.
		 */
		const secrets = [
			process.env.STRIPE_WEBHOOK_SECRET?.trim(),
			process.env.STRIPE_CONNECT_WEBHOOK_SECRET?.trim(),
		].filter((s): s is string => !!s);
		if (!sig || !secrets.length)
			return c.json({ error: "Missing signature or webhook secret." }, 400);

		// Verify against the raw body — constructEvent recomputes the HMAC, so the bytes
		// must be untouched (no c.req.json() before this).
		const raw = await c.req.text();
		let event: Stripe.Event | undefined;
		for (const secret of secrets) {
			try {
				event = (await verifyWebhookSignature(raw, sig, secret)) ?? undefined;
				break;
			} catch {
				// Try the next one. Falling through every secret is the failure.
			}
		}
		if (!event) return c.json({ error: "Signature verification failed." }, 400);

		if (event.type === "payment_intent.succeeded") {
			const pi = event.data.object as Stripe.PaymentIntent;
			// A purchase charged through a Checkout Session is keyed by the session id at
			// checkout, because the PaymentIntent does not exist until the buyer confirms.
			// This re-keys those rows onto the PaymentIntent, stamping the collected tax and
			// the buyer's address, so the generic completion below — which matches by
			// PaymentIntent id — finds them and does the rest. A session that billed outside
			// the US leaves its rows `pending` and is refunded by hand; see the helper.
			await completeSessionPurchases(pi);
			// Idempotent: only a still-pending row flips, so redelivered events are no-ops.
			//
			// 🚨 **Every** row, not the first. This destructured a single `[completed]`
			// until baskets existed, which was correct while one charge meant one purchase
			// and silently wrong the moment it didn't: the update flips all the rows (the
			// predicate matches them all) but only the first got its ledger entry or its
			// Seed credit. The buyer would have been charged for five Works, unlocked all
			// five, and had one booked.
			const completedRows = await db
				.update(purchases)
				.set({ status: "completed", updatedAt: new Date() })
				.where(and(eq(purchases.stripePaymentIntentId, pi.id), eq(purchases.status, "pending")))
				.returning();
			for (const completed of completedRows) {
				// What you bought lands in your Library, and stays there. This is the ONLY
				// place a purchase completes, which is why the hook belongs here rather
				// than at checkout: a card that never clears must not put anything in a
				// Library. Note the Library entry is a *consequence* of the purchase and
				// never the proof of it — `services/library.ts` derives permanence by
				// reading `purchases` back, so a failure here costs a row on a page, not
				// an entitlement.
				await saveOnPurchase(completed);

				// ⚠️ The ledger row this block used to write (the retired purchase fee,
				// always $0, read off `purchases.crf_fee`) is gone with the column — the
				// accounts-split pass dropped it, and a ledger row whose amount is always
				// zero is noise in the books rather than a record. A `type === "seeds"`
				// branch also sat here and credited the one-off support top-up; nothing
				// creates a row of that type since the top-up retired on 2026-09-15, so
				// a completed purchase is always a Work purchase now. Rows of the old
				// type can still be read — `services/refunds.ts` and `services/dmca.ts`
				// still know the value; nothing can still be written.
			}

			// The receipt, after the books have moved: buyer's itemized receipt for the
			// charge, creator's sale receipt when another account bought the work. One
			// email per charge (a basket's rows arrive together), latched on the
			// PaymentIntent id, so a redelivered event mails nobody twice. A receipt
			// built from rows that had not yet settled would show the transaction at
			// the wrong moment, which is why this sits after the loop above.
			await sendPurchaseReceipts(completedRows);

			// What the reader's own space is owed: one signed receipt per purchase row.
			// 🚨 Read back by intent rather than reused from `completedRows`, because a
			// redelivery has no newly-completed rows — that is what makes an insert that
			// failed last time get repaired this time. The insert is idempotent either way.
			const settled = await db
				.select({ id: purchases.id })
				.from(purchases)
				.where(and(eq(purchases.stripePaymentIntentId, pi.id), eq(purchases.status, "completed")));
			for (const row of settled) await oweAccessReceipt(row.id, "purchase");
		} else if (event.type === "payment_intent.payment_failed") {
			const pi = event.data.object as Stripe.PaymentIntent;
			await db
				.update(purchases)
				.set({ status: "failed", updatedAt: new Date() })
				.where(and(eq(purchases.stripePaymentIntentId, pi.id), eq(purchases.status, "pending")));
		} else if (event.type === "charge.refunded") {
			const charge = event.data.object as Stripe.Charge;
			// Only a FULL refund unwinds the purchase. `charge.refunded` also fires for
			// partials, where `refunded` stays false — and a partial refund must not
			// revoke access, because the buyer still paid for part of what they hold.
			// Partial refunds aren't a thing this model issues; ignoring them here is
			// deliberate rather than an omission.
			if (charge.refunded && charge.payment_intent) {
				const intentId =
					typeof charge.payment_intent === "string"
						? charge.payment_intent
						: charge.payment_intent.id;
				// A support charge refunded in full is never credited, or is netted if it already was.
				await markInvoiceMoneyReturned(intentId, "refunded");
				// 🚨 Every purchase on the charge, not the first — the `.limit(1)` here was
				// correct only while a charge could carry one purchase.
				//
				// This branch runs only when the charge is **wholly** refunded, so on a
				// basket it means every item is gone and every row must be settled. Our own
				// per-item refunds arrive here as *partial* refunds (`refunded: false`) and
				// are skipped by the guard above, having already settled their own row.
				//
				// ⚠️ **A partial refund issued from the Stripe DASHBOARD is still not
				// handled**, and baskets make that reachable where it wasn't before: the
				// money goes back and the row stays `completed`, so the buyer keeps access.
				// Nothing in a charge says *which* item an operator meant, so this cannot be
				// inferred — operator refunds have to go through the app. Worth a real fix
				// once there is a takedown path that issues them.
				const refundedRows = await db
					.select()
					.from(purchases)
					.where(eq(purchases.stripePaymentIntentId, intentId));
				// The refund our own route just made arrives back here as an event; the
				// row is already `refunded` by then and `settleRefundedPurchase` no-ops on
				// it. What this branch really exists for is the refund issued from the
				// Stripe dashboard, which reaches us no other way — and that is an
				// operator action, so it books as platform-initiated and does not spend
				// the buyer's automatic allowance.
				//
				// The two facts below read off the event's refund objects. **The live API
				// version's event snapshot omits the `refunds` list entirely** — found
				// 2026-10-14 by the first live dashboard-path refund, when the settle
				// stamped no refund id and read the reversal as absent, and the netting
				// ledger's no-identity guard skipped the netting row (`services/netting.ts`):
				// the harmless direction here, because the transfer really was reversed,
				// but the same shape in the paid-out-creator case silently loses the
				// recovery row. When the snapshot carries no refund objects, read Stripe's
				// truth instead — the charge's own refund list, through the processor
				// boundary. That read carries no `.catch` on purpose: an API failure fails
				// this webhook delivery, Stripe redelivers, and the settle runs on
				// recovered facts rather than on the event's degraded shape.
				let refundObjects = charge.refunds?.data ?? [];
				if (refundObjects.length === 0 && typeof charge.id === "string") {
					refundObjects = (await listRefundsForCharge(charge.id))?.data ?? [];
				}
				const firstRefund = refundObjects[0];
				for (const purchase of refundedRows) {
					// The dashboard refund reversed nothing on its own — a platform charge's
					// per-creator transfers are Anthers' calls to make (`services/purchase-split.ts`)
					// — so the clawback is attempted here, per row, through the same
					// `reverseCreatorShare` the refund route uses, and the outcome feeds the
					// settle: recovered needs nothing further; unrecovered-but-paid hands the
					// share to the netting ledger; never-transferred owes nobody anything.
					const clawback = await reverseCreatorShare(purchase);
					await settleRefundedPurchase(purchase, {
						initiator: "platform",
						reason: "Refunded at Stripe",
						stripeRefundId: typeof firstRefund?.id === "string" ? firstRefund.id : null,
						transferReversed: clawback.reversed,
						creatorWasPaid: clawback.creatorWasPaid,
					});
				}

				// The dashboard refund reached nobody in the routes, so the receipts go out
				// here. The rows are RE-READ rather than reused: a refund issued by our own
				// route arrives at this branch too (a single-item route refund refunds the
				// whole charge), the route has already mailed its receipt and stamped the
				// refund id, and a receipt built from the stale in-memory rows would latch
				// on a different key and mail a second time. Re-reading hands this the
				// settled rows whoever settled them, and the dedupe key does the rest.
				// Re-read hands this the settled rows whoever settled them; the status
				// filter keeps the receipt naming only what this refund actually took
				// back, and the dedupe key does the rest.
				const settledRows = await db
					.select()
					.from(purchases)
					.where(
						and(eq(purchases.stripePaymentIntentId, intentId), eq(purchases.status, "refunded")),
					);
				await sendRefundReceipts(settledRows);
			}
		} else if (event.type === "charge.dispute.created") {
			/**
			 * A chargeback. Anthers does not contest one, so the money is treated as gone from
			 * the moment it is disputed rather than when the dispute closes.
			 *
			 * The whole flow lives in `services/disputes.ts` (the one writer of `disputes`
			 * rows): it records the dispute, links it to the purchase or invoice the charge
			 * belonged to, and on the purchase path flips the row to `disputed` — which is
			 * the buyer's access being revoked, since `resolveAccess` counts only `completed`
			 * purchases. The invoice half stays here, because monthly support has no access
			 * to revoke and the money-record flip already lived in `markInvoiceMoneyReturned`.
			 *
			 * The netting half is `services/netting.ts`'s (the one writer of the netting
			 * ledger): on the PURCHASE path a dispute debits the platform balance and
			 * reverses nothing on the creator's transfer, so the creator's share is
			 * unrecovered the moment the dispute lands — a netting row records it for
			 * recovery from future earnings. The invoice path nets nothing here: support
			 * money that came back is the reversal half's (`markInvoiceMoneyReturned` plus
			 * the transfer job's negative-sum handling).
			 */
			const dispute = event.data.object as Stripe.Dispute;
			const intentId =
				typeof dispute.payment_intent === "string"
					? dispute.payment_intent
					: (dispute.payment_intent?.id ?? null);
			if (intentId) await markInvoiceMoneyReturned(intentId, "disputed");
			await recordDisputeCreated(dispute);

			// The netting row, on the purchase path only. The dispute row was just written,
			// so it is read back by Stripe id — the purchase it names was already flipped to
			// `disputed`, and the netting amount is read off the row the receipt kept.
			if (dispute.id) {
				const [disputeRow] = await db
					.select()
					.from(disputes)
					.where(eq(disputes.stripeDisputeId, dispute.id))
					.limit(1);
				if (disputeRow?.purchaseId != null) {
					const [purchaseRow] = await db
						.select()
						.from(purchases)
						.where(eq(purchases.id, disputeRow.purchaseId))
						.limit(1);
					await recordNettingForDispute(disputeRow, purchaseRow ?? null, new Date());
				}
			}
		} else if (event.type === "charge.dispute.closed") {
			/**
			 * The dispute's outcome. Stripe sends `charge.dispute.closed` with
			 * `status: "won" | "lost"`; the row's `status`/`outcome` columns are updated and,
			 * on a win, the purchase is restored to `completed` — the money came back, so the
			 * buyer keeps the Work. On a loss the purchase stays `disputed` (access stays
			 * revoked: Anthers never contested, the buyer has their money back and not the
			 * Work).
			 *
			 * On a win the CREATOR's netting is reversed too, by the same rule: the money
			 * came back to Anthers, so whatever of the creator's share was recovered goes
			 * back to them (`reverseNettingForWonDispute` — the none-applied case cancels the
			 * row, the some-applied case also writes the compensating credit).
			 *
			 * `charge.dispute.updated` is deliberately NOT handled: it carries the same dispute
			 * object but fires for every status transition, and the transitions that matter to
			 * Anthers are the landing (`created`) and the closing (`closed`) — the middle of a
			 * contest Anthers does not participate in is noise.
			 */
			await recordDisputeClosed(event.data.object as Stripe.Dispute);
			const closed = event.data.object as Stripe.Dispute;
			if (closed.status === "won" && closed.id) {
				const [disputeRow] = await db
					.select()
					.from(disputes)
					.where(eq(disputes.stripeDisputeId, closed.id))
					.limit(1);
				if (disputeRow) await reverseNettingForWonDispute(disputeRow.id, new Date());
			}
		} else if (event.type === "account.updated") {
			// The flags come from the shared derivation in `services/payouts.ts`, so this
			// writer and the reconcile-on-read in the GET route cannot drift apart.
			const acct = event.data.object as Stripe.Account;
			await db
				.update(stripeAccounts)
				.set({ ...stripeFlagPatchFromAccount(acct), updatedAt: new Date() })
				.where(eq(stripeAccounts.stripeAccountId, acct.id));
		} else if (
			event.type === "customer.subscription.created" ||
			event.type === "customer.subscription.updated" ||
			event.type === "customer.subscription.deleted"
		) {
			await syncSubscriptionToAccount(event.data.object as Stripe.Subscription);
		} else if (event.type === "invoice.created") {
			/**
			 * 🚨 **The one window in which a renewal invoice can still be changed.** Stripe
			 * creates it as a draft and finalizes it about an hour later, and the day-exact
			 * reduction owed to anybody who started or raised mid-month is applied in between —
			 * as a one-off coupon per line, from rows Anthers recorded itself.
			 *
			 * ⚠️ **A coupon attached to the subscription in advance does not work**, which is
			 * why this handler exists rather than something simpler: it is consumed by whichever
			 * invoice comes next, and for a mid-month raise that is the immediate invoice — so
			 * the discount would land on the very charge it exists to compensate for.
			 *
			 * The handler is deliberately narrow and everything it does not recognize is a
			 * silent no-op: `applyReductionsToInvoice` refuses anything that is not a draft
			 * renewal, and refuses an account with nothing owed, which is nearly every invoice.
			 */
			const applied = await applyReductionsToInvoice(event.data.object as Stripe.Invoice);
			if (applied > 0) {
				console.info(`support reductions: discounted ${applied} line(s) on a renewal invoice`);
			}
			// The storage top-up, added beside the reductions — the two mutators are
			// independent on purpose (a month can carry either, neither, or both). A run
			// that added nothing answers 0, which is nearly every invoice.
			const topUp = await addTopUpToInvoice(event.data.object as Stripe.Invoice);
			if (topUp > 0) {
				console.info(`storage top-up: added $${topUp.toFixed(2)} at cost to a renewal invoice`);
			}
		} else if (event.type === "invoice.paid") {
			/**
			 * 🚨 **The moment money is known to have arrived, and the only thing that creates a
			 * creditable record.** Nothing is credited to a creator from an invoice that has not
			 * been paid — the defect this replaces had `distribute-pool` crediting a whole
			 * period's Time Pool from its first night whether or not the renewal was ever
			 * collected, and nothing recorded an invoice at all.
			 *
			 * ⚠️ **A renewal in Stripe's retry window deliberately produces nothing here**, and
			 * that is what lets a late payment be credited against the month it paid for rather
			 * than the month it arrived in.
			 */
			const invoice = event.data.object as Stripe.Invoice;
			const invoiceRowId = await recordPaidInvoice(invoice);
			// The supporter's receipt rides the recorded row: sent only when the invoice was
			// actually recorded (a redelivered event returns null there, so nobody is mailed
			// twice), and only for a `paid` status, which `recordPaidInvoice` already guards.
			if (invoiceRowId != null) {
				const [invoiceRow] = await db
					.select()
					.from(invoices)
					.where(eq(invoices.id, invoiceRowId))
					.limit(1);
				if (invoiceRow) await sendSupportReceipt(invoiceRow);
			}
		}

		return c.json({ received: true });
	});

export { paymentRoutes };
