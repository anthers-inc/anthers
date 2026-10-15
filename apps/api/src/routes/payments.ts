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
	crfLedger,
	crfSubsidies,
	disputes,
	invoices,
	purchases,
	stripeAccounts,
	users,
	works,
} from "@anthers/db/schema";
import { cycleEnd, cycleStart } from "@anthers/shared/billing-cycle";
import type { Badge } from "@anthers/shared/constants";
import {
	CLOTHING_TAX_CODE,
	heldBadgeName,
	isChargeableAmount,
	MAX_BASKET_ITEMS,
	MERCH_BADGE_DISCOUNT,
	REFUND_AUTO_CAP,
} from "@anthers/shared/constants";
import { calculateFees, MERCH_BADGE_DISCOUNT_RATE } from "@anthers/shared/fees";
import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import type { WorkType } from "@anthers/shared/tax-codes";
import { purchaseTaxCode } from "@anthers/shared/tax-codes";
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
	listCheckoutSessions,
	listRefundsForCharge,
	paymentsConfigured,
	retrieveConnectAccount,
	retrieveConnectBalance,
	verifyWebhookSignature,
} from "../lib/processor.js";
import { getOptionalUserId, requireAuth, requireVerified } from "../middleware/auth.js";
import { invalidBody } from "../middleware/validate.js";
import { resolveAccess } from "../services/access.js";
import { heldAnthersBadgeAmount } from "../services/anthers-badges.js";
import { addBasketItem, clearBasket, listBasket, removeBasketItem } from "../services/basket.js";
import {
	linkCheckoutCustomer,
	stripeCustomerIdFor,
	syncSubscriptionToAccount,
} from "../services/billing.js";
import { recordDisputeClosed, recordDisputeCreated } from "../services/disputes.js";
import { markInvoiceMoneyReturned, recordPaidInvoice } from "../services/invoices.js";
import { saveOnPurchase } from "../services/library.js";
import { recordNettingForDispute, reverseNettingForWonDispute } from "../services/netting.js";
import { stripeFlagPatchFromAccount } from "../services/payouts.js";
import { getShippingRates, printfulConfigured } from "../services/printful.js";
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
import { addTopUpToInvoice } from "../services/storage-topup.js";
import { applyReductionsToInvoice } from "../services/support-reductions.js";

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

	// 🚨 **A physical or service Work is refused on the generic paths, because nothing
	// generic fulfills it — and the goods-works rule prices them here as null (the
	// store prices the goods), so this refusal has to come BEFORE the priced-row
	// checks or a merch Work's generic refusal would read as a data error rather
	// than the posture's sentence.** There is no shipping lane behind
	// `resolvePurchase` and no fulfillment mechanism for a service one — a merch
	// Work (a physical Work owned by the official account with merch variants
	// mapped) is sold by the *merch* routes (`/merch/:slug/variants` and
	// `/merch/checkout/:slug` below), which call this for everything except this
	// refusal. This is the posture's refusal rather than a judgment about the
	// types: selling them arrives when the fulfillment behind them arrives, and
	// until then checkout is the one door that has to say no.
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
 * The same resolution for a **basket** of Works bought on one charge.
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
 * carries the reasoning and the accepted cost. What the basket buys is the **fixed
 * $0.30**, which is per *charge* and not per item: five $1 tracks pay $1.65 in card fees
 * separately and $0.45 together, and the whole $1.20 goes to the creator because Anthers
 * keeps nothing either way. Same mechanism as batching a month's support onto one
 * transaction (the wiki's *How Money Moves*).
 */
async function resolveBasket(workIds: number[], userId: number) {
	const unique = [...new Set(workIds)];
	if (unique.length === 0)
		return { ok: false as const, status: 400 as const, error: "Your basket is empty" };
	if (unique.length > MAX_BASKET_ITEMS)
		return {
			ok: false as const,
			status: 400 as const,
			error: `A basket holds at most ${MAX_BASKET_ITEMS} items`,
		};

	const rows = await db.select().from(works).where(inArray(works.id, unique));
	if (rows.length !== unique.length)
		return { ok: false as const, status: 404 as const, error: "Work not found" };

	// Resolved per Work, through the same path a single purchase takes — the basket
	// changes who pays the flat fee, never who may buy what.
	const items: { work: (typeof rows)[number]; amount: Decimal }[] = [];
	for (const work of rows) {
		const one = await resolvePurchase(work.slug, userId);
		if (!one.ok) return { ...one, workId: work.id };
		items.push({ work: one.work, amount: one.amount });
	}

	// 🚨 Fees on the SUM, once — computing per item and adding would charge the flat
	// $0.30 per Work and defeat the entire point of the basket.
	const subtotal = items.reduce((acc, i) => acc.plus(i.amount), new Decimal(0));
	const fees = calculateFees(subtotal, { type: "digital" });
	// The distinct creators the charge covers — the checkout's connected-account
	// precondition and the completion path's transfer step both read this.
	const creatorIds = [...new Set(items.map((i) => i.work.creatorId))];
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
	metadata: Record<string, string>;
}): Stripe.Checkout.SessionCreateParams {
	return {
		mode: "payment",
		ui_mode: "elements",
		// 🚨 **The email is what confirms the session.** Stripe requires a valid customer
		// email before a session may be confirmed — `canConfirm` stays false without one —
		// and none of the purchase surfaces collect one: no Contact Details Element, no
		// email field on the address form, and no `customer_email` here. Every buyer is a
		// verified account (`requireVerified`), so the email is already held, already
		// proven, and simply belongs on the session — the receipt and the Customer record
		// both want it anyway. Found as the disabled Pay button (2026-10-06): all three
		// address fields resolved a real tax, the card was filled, and the button never
		// un-greyed.
		customer_email: params.customerEmail,
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
		...(params.customerId
			? { customer: params.customerId }
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
		// 🚨 **No payment-method saves are offered on this flow.** Anthers never stores a
		// card for reuse (`setup_future_usage` is nowhere in this route), so the session
		// does not ask to save — and Checkout renders Link's consent block ("Save my
		// information for faster checkout", an email + MOBILE NUMBER sub-form, checkbox
		// checked by default) whenever a Customer rides the session: a saved one passed
		// in, or one Stripe created. A buyer who ignores the block left the phone field
		// empty and Stripe held `canConfirm` false forever: the fully-filled form with
		// a greyed Pay button (2026-10-06, live payment_method collection blocked all
		// day; the client-side `savedPaymentMethod.enableSave: "never"` below removes
		// the sub-form from its side too). The suppression stays regardless of which
		// way a Customer got there.
		saved_payment_method_options: {
			payment_method_save: "disabled",
			payment_method_remove: "disabled",
		},
		line_items: params.lineItems,
		automatic_tax: { enabled: true },
		payment_intent_data: {
			metadata: params.metadata,
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
): Stripe.Checkout.SessionCreateParams.LineItem {
	return {
		price_data: {
			currency: "usd",
			// US prices are tax-exclusive: the buyer's total varies with their location,
			// which is the point of automatic tax.
			tax_behavior: "exclusive",
			unit_amount: amountCents,
			product_data: {
				// A Work's title is nullable in the database; the Work's slug-anchored page
				// is what names it publicly, but a receipt line needs something, and a
				// fallback reads better on a card statement than an empty string.
				name: work.title || `Work #${work.id}`,
				tax_code: taxCode,
			},
		},
		quantity: 1,
	};
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
 *
 * ⚠️ **US billing only, enforced here as the backstop.** The buy surfaces collect the
 * address through Anthers' own US-only form — there is no country field to enter
 * anything else into, so a browser-built session carries a US address by construction.
 * This refusal is the defense in depth for what that cannot see: a hand-rolled API
 * call, a modified client, a form skipped. A non-US address is a hard failure that
 * leaves the rows `pending` and the money to be returned by hand. Refusing loudly beats
 * collecting tax Anthers is not registered to collect.
 *
 * Idempotent by the same latch the rest of the webhook uses: only `pending` rows move.
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
	const address = session.customer_details?.address ?? null;
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
	// PI-keyed branch below relies on.
	const rows = await db
		.select()
		.from(purchases)
		.where(and(eq(purchases.stripePaymentIntentId, session.id), eq(purchases.status, "pending")));
	if (rows.length === 0) return;

	// A basket splits the whole charge's tax pro-rata by item value, the same split the
	// card fee gets at checkout, so the rows sum to what Stripe collected exactly. The
	// last row absorbs the rounding remainder, for the same reason it does there.
	const subtotal = rows.reduce((acc, r) => acc.plus(new Decimal(r.amount)), new Decimal(0));
	const taxTotal = new Decimal(tax);
	let allocated = new Decimal(0);
	const stamped = rows.map((row, idx) => {
		const isLast = idx === rows.length - 1;
		const share = isLast
			? taxTotal.minus(allocated)
			: taxTotal.times(new Decimal(row.amount)).dividedBy(subtotal).toDecimalPlaces(2);
		if (!isLast) allocated = allocated.plus(share);
		return { row, share };
	});

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

	// ── The split, after the rows are keyed to the intent ─────────────────────
	// The platform charge collected everyone's money; now each creator's share moves out,
	// one transfer per creator funded by the charge. The amounts are the rows' pinned
	// earnings, so a failure leaves a row unstamped and the retry job the owner of the
	// debt — `services/purchase-split.ts` carries the whole reasoning, including why a
	// refund in the window must never transfer.
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
	// the intent's metadata, which every purchase surface stamps.
	const linkCustomerId =
		typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
	const buyerUserId = Number(pi.metadata?.buyerId ?? NaN);
	if (linkCustomerId && Number.isFinite(buyerUserId)) {
		await linkCheckoutCustomer(buyerUserId, linkCustomerId);
	}

	// ── Merch fulfillment, after the money has moved ──────────────────────────
	// A merch charge carries exactly one completed row (one goods line + a shipping line
	// priced into the same charge), so a `physical` row here means the whole session was
	// merch. The order is placed against the session's SHIPPING address — the delivery
	// destination, which is also the address tax resolved from on this session — and a
	// failure never undoes the buyer's completed purchase: it is recorded on the
	// fulfillment row for the placement sweep to retry. See `services/printful.ts`.
	// (This Stripe version moved the session's collected address under
	// `collected_information`; the billing read above still reads `customer_details`.)
	const shipping = session.collected_information?.shipping_details ?? null;
	const merchRows = stamped.filter(({ row }) => row.type === "physical");
	if (shipping && merchRows.length > 0) {
		const addr = shipping.address;
		// The checkout's metadata — where the placement facts were resolved and stashed
		// (see `resolveMerchCheckout`): merchandise goods price, shipping method, and
		// Printful's Sync Variant id.
		const meta = pi.metadata ?? {};
		for (const { row } of merchRows) {
			if (!row.workId) continue;
			// The purchase recorded the size at checkout; the fulfillment is placed from
			// the metadata's resolved facts and the session's shipping address.
			const fulfillment = await resolveMerchCheckout(row, meta as Record<string, string>, {
				name: shipping.name ?? "",
				address1: addr.line1 ?? "",
				address2: addr.line2 ?? undefined,
				city: addr.city ?? "",
				state_code: addr.state ?? "",
				country_code: addr.country ?? "US",
				zip: addr.postal_code ?? "",
			});
			// `placedAt` null means the placement failed and the sweep owns the retry —
			// logged here so a broken token or a refused order is visible in the logs
			// rather than only in a table.
			if (!fulfillment?.placedAt) {
				console.error(
					`merch placement for purchase ${row.id} not placed: ${fulfillment?.placementError ?? "no fulfillment row"}`,
				);
			}
		}
	}
}

/**
 * The merch half of a completed purchase, resolved from the database (the size chosen at
 * checkout, the Printful variant that size maps to) — then the order placed through
 * `services/printful.ts`. Null when the row is not a fulfillable merch purchase.
 */
async function resolveMerchCheckout(
	row: typeof purchases.$inferSelect,
	metadata: Record<string, string>,
	recipient: NonNullable<
		Awaited<ReturnType<typeof import("../services/printful.js").placeOrder>>
	> extends never
		? never
		: {
				name: string;
				address1: string;
				address2?: string;
				city: string;
				state_code: string;
				country_code: string;
				zip: string;
			},
) {
	// Imported inside to keep the route's top imports Stripe-shaped; this whole block
	// moves to its own route module when the merch checkout splits out of payments.ts.
	const { placeMerchOrder, printfulConfigured } = await import("../services/printful.js");
	if (!printfulConfigured()) return null;
	if (!row.merchSize) return null;
	// The placement facts were resolved at checkout and ride the PaymentIntent's
	// metadata: the shipping method the session actually charged, the discounted goods
	// figure for the packing slip, and Printful's Sync Variant id the order names.
	// Re-deriving any of them here could disagree with the charge (the 2026-10-09
	// probe showed Printful returning two shipping rates — a re-quote's first entry
	// is not guaranteed to be the one the buyer accepted).
	const goodsPrice = metadata.merchGoodsPrice;
	const syncVariantId = Number(metadata.merchSyncVariantId);
	const shippingMethod = metadata.shippingMethod;
	if (!goodsPrice || !Number.isFinite(syncVariantId) || syncVariantId <= 0 || !shippingMethod)
		return null;
	return placeMerchOrder({
		purchaseId: row.id,
		syncVariantId,
		quantity: 1,
		retailPrice: goodsPrice,
		shippingMethod,
		recipient,
	});
}

// ─── Basket storage: the shared read the storage routes answer with ─────────

/** The basket item shape every storage route answers with — the resolution `/basket` returns. */
interface ResolvedBasketItem {
	workId: number;
	slug: string;
	title: string | null;
	price: string;
	creatorHandle: string;
	thumbnail: string | null;
}

/**
 * The account's basket, each row resolved to what the buyer could actually buy.
 *
 * 🚨 **A stale row answers by absence, never by error.** The table may hold a Work that
 * stopped being buyable after it was added (withdrawn, already owned, moved behind a
 * higher gate, creator unconnected, deleted from the catalog outright) — this read is
 * where it stops being visible. Returning it with an error flag would make every
 * subscriber (the badge first) into a place that has to know the rules; the basket page
 * rendering only what a checkout could charge is the honest shape, and the refusals keep
 * firing where money is at stake — at quote and checkout. See `resolveBasket`.
 */
async function resolvedBasketItems(userId: number): Promise<ResolvedBasketItem[]> {
	const rows = await listBasket(userId);
	const items: ResolvedBasketItem[] = [];
	for (const row of rows) {
		if (!row.slug || !row.creatorHandle) continue;
		const q = await resolvePurchase(row.slug, userId);
		if (!q.ok) continue;
		items.push({
			workId: row.workId,
			slug: row.slug,
			title: row.title,
			price: q.amount.toFixed(2),
			creatorHandle: row.creatorHandle,
			thumbnail: row.thumbnail,
		});
	}
	return items;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * The merch-flavored purchase resolution: everything `resolvePurchase` checks except the
 * physical-type refusal (this IS the fulfillment path) and the price read (a merch Work's
 * price is derived, not stored — `access.price` is ignored). Returns the Work alone.
 */
/**
 * The merch door, shared by the checkout (buying) and the variants read (the picker).
 *
 * `userId` is null for a signed-out visitor reading the picker — page viewing needs no
 * account (the goods-works rule in `resolveAccessSync`), so the read stands. Buying still
 * requires one upstream (`requireAuth` on the checkout route), so null never reaches a
 * purchase here.
 *
 * `opts.read` is the variants route's mode: the one `canAccess` refusal below is a
 * CHECKOUT's refusal ("you already have access", which a buyer's repeat purchase would
 * otherwise need), and a reading call — the only way a `canAccess: true` verdict arrives
 * here is the WORK OWNER checking their own store — must see the panel, not that refusal.
 */
async function resolveMerchPurchase(
	slug: string,
	userId: number | null,
	opts?: { read?: boolean },
) {
	const [work] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
	if (!work) return { ok: false as const, status: 404 as const, error: "Work not found" };
	if (work.visibility !== "released" && work.creatorId !== userId)
		return { ok: false as const, status: 404 as const, error: "Work not found" };
	const access = await resolveAccess(work, userId);
	if (access.canAccess && !(opts?.read && access.reason === "owner"))
		return {
			ok: false as const,
			status: 400 as const,
			error: "You already have access to this work",
		};
	if (!access.requiresPurchase)
		return {
			ok: false as const,
			status: 400 as const,
			error: "This work is not available for direct purchase",
		};
	// 🚨 A merch Work is the official account's, and the official account has no
	// connected Stripe account to require — the merch sale pays nobody's transfer. A
	// physical Work that is NOT the official account's stays refused: no fulfillment
	// exists behind a creator's own physical good yet (the Future/ task), and this
	// resolution is the merch path's front door.
	const { anthersUserId } = await import("../services/anthers-badges.js");
	let isMerch = false;
	try {
		isMerch = work.type === "physical" && work.creatorId === (await anthersUserId());
	} catch {
		isMerch = false; // unseeded database — no official account, so no merch exists
	}
	if (!isMerch)
		return {
			ok: false as const,
			status: 400 as const,
			error: "This kind of work can't be bought yet — there's nothing to deliver it.",
		};
	return { ok: true as const, work };
}

/** The body a merch checkout names: the size label, and nothing else. */
const merchCheckoutSchema = z.object({
	color: z.string().trim().min(1).max(40),
	size: z.string().trim().min(1).max(10),
});

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

	// ── The creator's receipt-email preference ───────────────────────────────
	// GET answers even with no Stripe account row (on, the default), because the
	// toggle lives on the Studio Settings page a pre-onboarding creator also reads;
	// PATCH writes through to the row, creating it with a placeholder account id is
	// NOT done — an unbuilt row is a real state (the onboarding route owns it), so
	// PATCH is refused with the same 409 the other Stripe routes give, and the page
	// hides the toggle until payouts exist (the toggle's own reasoning below).
	.get("/stripe/receipt-emails", requireAuth, async (c) => {
		const [account] = await db
			.select({ wants: stripeAccounts.creatorReceiptEmails })
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, c.get("user").id))
			.limit(1);
		return c.json({ enabled: account?.wants !== false });
	})
	.patch("/stripe/receipt-emails", requireAuth, async (c) => {
		const body = await c.req.json().catch(() => null);
		const enabled = (body as { enabled?: unknown } | null)?.enabled;
		if (typeof enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);

		const [account] = await db
			.select({ id: stripeAccounts.id })
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, c.get("user").id))
			.limit(1);
		if (!account) return c.json({ error: "Connect a Stripe account first." }, 409);

		await db
			.update(stripeAccounts)
			.set({ creatorReceiptEmails: enabled, updatedAt: new Date() })
			.where(eq(stripeAccounts.id, account.id));
		return c.json({ enabled });
	})

	// ── Quote (accurate fee preview, no charge) ──────────────────────────────
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

	// ── Merch: the sellable sizes of one merch Work ──────────────────────────
	// Read by the Work page's size picker. A Work without merch rows is a physical
	// Work the setup script has not pointed at a Printful product yet — it is not
	// buyable, and the picker's absence is the honest answer (the checkout below
	// refuses it with the same sentence the generic physical refusal gave).
	//
	// ⚠️ **The picker answers the buyer's OWN prices** — the list price each size
	// carries, and, when this buyer holds a Badge, the discounted figure beside it.
	// Never the print cost: that is the transparency prose's basis (never an exact
	// published figure — Printful reprices), and the picker is a buyer surface.
	//
	// Optional auth, deliberately: a signed-out visitor reads the page and the
	// picker like any account (the goods-works rule in `resolveAccessSync`) — the
	// list price is theirs to see. A Badge discount needs an account by
	// construction (the Badge is held BY an account), so signed out every row
	// prices undiscounted, and the panel's buy door asks for the account.
	.get("/merch/:slug/variants", async (c) => {
		const userId = await getOptionalUserId(c);
		const q = await resolveMerchPurchase(c.req.param("slug") ?? "", userId, { read: true });
		if (!q.ok) return c.json({ error: q.error }, q.status);
		const { work } = q;
		const { merchVariants } = await import("@anthers/db/schema");
		const rows = await db
			.select()
			.from(merchVariants)
			.where(eq(merchVariants.workId, work.id))
			.orderBy(merchVariants.id);
		// The Badge resolves once — for a signed-in buyer only; every row prices
		// against it. `free` holds no discount — only Badge keys index the ladder.
		let heldBadge: Badge | null = null;
		if (userId != null) {
			try {
				const badge = heldBadgeName(await heldAnthersBadgeAmount(userId));
				if (badge !== "free") heldBadge = badge;
			} catch {
				heldBadge = null; // unseeded ladder — prices answer undiscounted
			}
		}
		const price = (v: typeof merchVariants.$inferSelect) => {
			const list = new Decimal(v.listPrice);
			const discountRate = heldBadge ? MERCH_BADGE_DISCOUNT_RATE[heldBadge] : "0";
			const amount = list.minus(list.times(discountRate)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
			return {
				listPrice: list.toFixed(2),
				amount: amount.toFixed(2),
				// The whole percent for copy ("25"), rendered "25% off" client-side.
				discount: heldBadge ? MERCH_BADGE_DISCOUNT[heldBadge] : null,
				inStock: true, // stock state is Printful's; the order creation reports it
			};
		};
		// Group the (color, size) rows into the picker's shape: one row per color,
		// its sizes in setup order. Sizes repeat across colors with no shared state —
		// a 3XL can sell out in one color while another keeps selling — so each row
		// carries its own priced list rather than a Work-wide one. The color's mockup
		// rides the first row carrying one (the dashboard stamps the same URL on every
		// size of a color; a row that stamps none is cosmetic, not a gap in the row).
		const colorGroups = [...new Set(rows.map((r) => r.color))].map((color) => ({
			color,
			mockupUrl: rows.find((r) => r.color === color && r.mockupUrl != null)?.mockupUrl ?? null,
			sizes: rows.filter((r) => r.color === color).map((r) => ({ size: r.size, ...price(r) })),
		}));
		return c.json({
			// Color is a dimension, not a label: the store's shirts each carry two —
			// grouped for the picker as `{ color, sizes[] }` rows (Parker, 2026-10-09:
			// one Work per shirt, a color picker beside the size picker).
			colors: colorGroups,
			merchConfigured: printfulConfigured(),
		});
	})

	// ── Merch checkout ───────────────────────────────────────────────────────
	/**
	 * Buy one merch Work in one size, on one charge: a goods line (print cost + margin,
	 * `txcd_30011000`) and a shipping line (Printful's live rate, `txcd_92010001`).
	 *
	 * The session differs from a digital purchase session in exactly three ways, all of
	 * them consequences of the goods being physical:
	 * - `shipping_address_collection` is set (US only) — the delivery address is what
	 *   tax resolves from and what Printful ships to.
	 * - No `transfer_data` — there is no creator destination; Anthers sells its own
	 *   goods and keeps the margin on the platform side by construction.
	 * - The buyer records the size at checkout (`merchSize`), and the fulfillment row
	 *   exists from completion onward — placed from the session's own shipping details.
	 *
	 * 🚨 **The size and the Printful variant are resolved HERE, never trusted from the
	 * client.** The body names a `size` label only; the variant row that maps it to a
	 * Printful catalog id is re-read server-side, so a tampered size buys nothing that
	 * does not exist. The list price is derived from Printful's catalog price + the
	 * margin constant at this moment, so a Printful price change is reflected before a
	 * buyer is charged rather than discovered by them.
	 */
	.post(
		"/merch/checkout/:slug",
		requireAuth,
		requireVerified,
		zValidator("json", merchCheckoutSchema, invalidBody),
		async (c) => {
			const user = c.get("user");
			const q = await resolveMerchPurchase(c.req.param("slug") ?? "", user.id);
			if (!q.ok) return c.json({ error: q.error }, q.status);
			const { work } = q;

			if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);
			if (!printfulConfigured()) return c.json({ error: "Merch isn't available right now." }, 503);

			// The buyer's Customer on file, for the session's reuse-or-as-needed posture.
			const customerId = await stripeCustomerIdFor(user.id);

			// The body names only the color and size labels — never a price, never a
			// variant id. The (color, size) pair must name exactly one row; a Work's
			// picker shows a size per color, so two rows matching would be a data error
			// refused here rather than an arbitrary pick.
			const { color, size } = c.req.valid("json");

			const { merchVariants } = await import("@anthers/db/schema");
			const matches = await db
				.select()
				.from(merchVariants)
				.where(
					and(
						eq(merchVariants.workId, work.id),
						eq(merchVariants.color, color),
						eq(merchVariants.size, size),
					),
				)
				.limit(2);
			if (matches.length === 0) return c.json({ error: "Choose a color and size first." }, 400);
			if (matches.length > 1) return c.json({ error: "Merch isn't available right now." }, 503);
			const [variant] = matches;

			// The live shipping rate — quoted now, priced into the session as a fixed
			// shipping option. Printful's US rates are flat per product category, so the
			// figure is real without the buyer's ZIP yet. **The offset rate is The
			// choice** (Parker, 2026-10-09: "always do the co2 offset") — picked by id,
			// falling back to the first rate only if Printful stops offering one, so a
			// rate-list change degrades to shipping without the offset rather than
			// failing the store.
			const rates = await getShippingRates({ country_code: "US" }, [
				{ catalogVariantId: variant.catalogVariantId, quantity: 1 },
			]);
			const rate = rates?.find((r) => r.id === "STANDARD_CARBON_OFFSET") ?? rates?.[0];
			if (!rate) return c.json({ error: "Shipping is not available right now." }, 503);

			// 🚨 **The list price is Printful's own retail price, stamped at setup** (Parker,
			// 2026-10-08: the store uses what Printful carries — one pricing source, edited
			// on the Printful side and restamped by the setup script's re-run). Printing
			// costs nothing here. The Badge discount is the one adjustment the checkout
			// makes to it, on the goods line alone: shipping is Printful's charge, which
			// Anthers does not control and never discounts (the decision's own rule).
			// The Badge held this cycle resolves via its threshold — the same read the
			// subscription routes take (`heldAnthersBadgeAmount` → `heldBadgeName`).
			// An unseeded ladder throws inside the service, so the discount resolution
			// is guarded: no ladder, no discount, and the 503 the store deserves.
			// `free` holds no discount — only Badge keys index the ladder.
			let discountRate = "0";
			let heldBadge: Badge | null = null;
			try {
				const badge = heldBadgeName(await heldAnthersBadgeAmount(user.id));
				if (badge !== "free") {
					heldBadge = badge;
					discountRate = MERCH_BADGE_DISCOUNT_RATE[badge];
				}
			} catch {
				return c.json({ error: "Merch isn't available right now." }, 503);
			}
			const listPrice = new Decimal(variant.listPrice);
			const goodsPrice = listPrice
				.minus(listPrice.times(discountRate))
				.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

			// The buyer's visible figure before tax: discounted goods + Printful's shipping.
			const shipping = new Decimal(rate.rate);
			const amount = goodsPrice.plus(shipping); // tax on top at the session

			// The same sub-floor guard the generic checkout keeps, on the whole charge.
			if (!isChargeableAmount(amount.toNumber())) {
				return c.json(
					{
						error:
							"This item is priced below what a card payment can process, so it can't be bought right now.",
					},
					409,
				);
			}

			// The goods line's tax code is `CLOTHING_TAX_CODE`, set inline below where the
			// line is built. The shipping option's own line tax code is not carried by this
			// API version's shipping_rate_data — the delivery line is taxed through the
			// session's automatic tax as part of the tangible-goods sale, which is the
			// documented behavior for shipping charges in conjunction with goods.

			const session = await createCheckoutSession({
				mode: "payment",
				ui_mode: "elements",
				customer_email: user.email,
				billing_address_collection: "required",
				// The 2026-10-11 customer posture, same as every purchase surface: a buyer
				// with a Customer on file pays on it; no Customer, no created one unless
				// `if_required` requires it and the webhook links it.
				...(customerId ? { customer: customerId } : { customer_creation: "if_required" as const }),
				saved_payment_method_options: {
					payment_method_save: "disabled",
					payment_method_remove: "disabled",
				},
				line_items: [
					{
						price_data: {
							currency: "usd",
							tax_behavior: "exclusive",
							unit_amount: Math.round(goodsPrice.toNumber() * 100),
							product_data: {
								name: work.title || `Work #${work.id}`,
								tax_code: CLOTHING_TAX_CODE,
							},
						},
						quantity: 1,
					},
				],
				// US only — the merch flow ships domestically at launch, matching the
				// billing posture.
				shipping_address_collection: { allowed_countries: ["US"] },
				// Printful's rate as the only shipping option, priced before the buyer sees
				// the total.
				shipping_options: [
					{
						shipping_rate_data: {
							type: "fixed_amount",
							fixed_amount: {
								amount: Math.round(new Decimal(rate.rate).toNumber() * 100),
								currency: "usd",
							},
							display_name: rate.name,
							// The tax code rides the delivery estimate's own param set where the
							// API version allows it; where it does not, the session's tax note
							// below covers the posture.
							...(!Number.isNaN(Number(rate.minDeliveryDays)) &&
							Number.isFinite(rate.minDeliveryDays)
								? {
										delivery_estimate: {
											minimum: { unit: "business_day", value: rate.minDeliveryDays },
											maximum: { unit: "business_day", value: rate.maxDeliveryDays },
										},
									}
								: {}),
						},
					},
				],
				automatic_tax: { enabled: true },
				payment_intent_data: {
					metadata: {
						kind: "merch_purchase",
						workId: String(work.id),
						buyerId: String(user.id),
						merchVariantId: String(variant.id),
						// The placement facts ride the metadata rather than being re-derived
						// at completion: the session's own shipping option id is what the
						// buyer was charged (re-quoting can diverge — Printful returned two
						// rates in the 2026-10-09 probe), the discounted goods figure is
						// what the packing slip's retail price names, and the Sync Variant
						// id is what the Printful order's item must reference (`sync_variant_id`
						// is Printful's id, not our row's — 2026-10-09's probe caught the
						// mismatch before a real order could).
						shippingMethod: rate.id,
						merchGoodsPrice: goodsPrice.toFixed(2),
						merchSyncVariantId: String(variant.syncVariantId),
						// The offsetting posture (Parker, 2026-10-09: "always do the co2
						// offset") is enforced at quote time below; no metadata for it.
					},
				},
				// Where a redirect-based payment method sends the buyer back; cards don't
				// use it, but the session requires it when one is enabled.
				return_url: `${process.env.PUBLIC_WEB_URL?.trim() || "http://localhost:3000"}${STRIPE_RETURN_PATHS.checkoutReturn}`,
			});
			if (!session?.client_secret) return c.json({ error: "Payments are not configured." }, 503);

			// Record the purchase pending, exactly as a digital one — completed by the
			// webhook, which places the Printful order from the session's shipping details.
			// The goods line's money is what the buyer was shown: the discounted price.
			// Printful's costs are NOT known figures yet — stamped at completion from the
			// order's own costs object.
			//
			// 🚨 **The earnings-shaped column carries the discount-adjusted margin** — the
			// seller's share on a platform-side sale, charged on the goods line. The buyer
			// sees the discount; the books record what Anthers actually kept, and Printful's
			// stamped costs at completion are what the realized figure is computed from.
			await db.insert(purchases).values({
				buyerId: user.id,
				workId: work.id,
				// Anthers sells its own goods: the creator columns are Anthers' own account.
				creatorId: null,
				workTitle: work.title,
				workType: work.type,
				workPublicId: work.publicId,
				type: "physical",
				amount: amount.toFixed(2),
				processingFee: calculateFees(amount, { type: "physical" }).processingFee.toFixed(2),
				salesTax: "0.00",
				// The margin on the goods line: discounted price less Printful's wholesale
				// cost snapshot. The order's own costs object refines this at completion.
				creatorEarnings: goodsPrice.minus(variant.catalogPrice).toFixed(2),
				stripePaymentIntentId: session.id,
				status: "pending",
				merchSize: size,
				// The Badge the discount resolved from — the receipt's discount line names it.
				...(heldBadge ? { merchDiscountBadge: heldBadge } : {}),
			});

			return c.json({
				amount: amount.toFixed(2),
				listPrice: listPrice.toFixed(2),
				goodsPrice: goodsPrice.toFixed(2),
				discount: heldBadge
					? {
							badge: heldBadge,
							percent: MERCH_BADGE_DISCOUNT[heldBadge],
							saved: listPrice.minus(goodsPrice).toFixed(2),
						}
					: null,
				shipping: shipping.toFixed(2),
				size,
				salesTax: null,
				buyerTotal: null,
				clientSecret: session.client_secret,
			});
		},
	)

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
		const workId = Number(body?.workId);
		if (!Number.isInteger(workId) || workId <= 0)
			return c.json({ error: "A Work id is required." }, 400);

		const result = await addBasketItem(user.id, workId);
		if (!result.ok) {
			// 404 names the Work (gone before it could be held); 409 names the basket (full).
			// Both are refusals the buyer can act on at the moment of the click, which is
			// the whole courtesy — the alternative was discovering both at checkout.
			if (result.reason === "at_capacity") {
				return c.json({ error: "Your basket is full.", code: "at_capacity" }, 409);
			}
			return c.json({ error: "Work not found", code: result.reason }, 404);
		}
		// Answer with the post-add basket so the client's optimistic update can reconcile
		// against the truth in one round trip — each item resolved exactly as `/basket`
		// resolves it.
		const items = await resolvedBasketItems(user.id);
		return c.json({ items });
	})

	.delete("/basket/items/:workId", requireAuth, async (c) => {
		const user = c.get("user");
		const workId = Number(c.req.param("workId"));
		if (!Number.isInteger(workId) || workId <= 0) return c.json({ error: "Work not found" }, 404);
		await removeBasketItem(user.id, workId);
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
		// 🚨 **The resolved basket is the source of `workIds`; the request body never was.**
		// The account's table is asked for its ids through the SAME resolution `/basket`
		// answers with — so a row that stopped being buyable is excluded here exactly as
		// the badge excluded it, and the buyer is never failed by an item they cannot see
		// or remove. What remains is then re-resolved by `resolveBasket` below, whose
		// refusal paths (mixed creators, the cap, the per-Work rules) keep firing.
		const stored = await resolvedBasketItems(user.id);
		const workIds = stored.map((row) => row.workId);
		const q = await resolveBasket(workIds.map(Number).filter(Number.isFinite), user.id);
		if (!q.ok) return c.json({ error: q.error, code: "code" in q ? q.code : undefined }, q.status);

		// What the same items would have cost bought one at a time. Not decoration: it is
		// the number that makes the basket legible, and it is derived rather than typed —
		// `cardFee` per item, summed, against one `cardFee` on the subtotal.
		const separately = q.items.reduce(
			(acc, i) => acc.plus(calculateFees(i.amount, { type: "digital" }).processingFee),
			new Decimal(0),
		);

		// 🚨 The per-line fee shares are APPORTIONED, not recomputed — the same split the
		// purchase rows are written with: pro-rata by item value, the last line absorbing
		// the rounding remainder, so the parts always reconstruct the whole exactly. A
		// simple per-line `times(...).div(...)` rounds each line independently and a
		// three-evenly-split $0.59 fee summed to $0.60 (found by this suite).
		let allocatedFee = new Decimal(0);
		const lineFees = q.items.map((i, idx) => {
			if (idx === q.items.length - 1) return q.fees.processingFee.minus(allocatedFee);
			const share = q.fees.processingFee.times(i.amount).dividedBy(q.subtotal).toDecimalPlaces(2);
			allocatedFee = allocatedFee.plus(share);
			return share;
		});

		// The creator groups the basket page renders — one per distinct creator, each with
		// a receives figure summed from that creator's own lines (price less the line's
		// fee share), so the groups reconstruct the whole basket's `creatorEarnings`
		// exactly: the last line's rounding remainder lands wherever the last line's
		// creator is, and the per-group sums still add up. A basket carries any number of
		// creators (2026-10-15), and the page renders these server figures rather than
		// deriving its own — a receipt that computes its own totals stops reconciling the
		// moment a dial moves.
		const byCreator = new Map<number, { receives: Decimal; itemCount: number }>();
		q.items.forEach((i, idx) => {
			const cid = i.work.creatorId as number;
			const group = byCreator.get(cid) ?? { receives: new Decimal(0), itemCount: 0 };
			group.receives = group.receives.plus(i.amount).minus(lineFees[idx]);
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
			items: q.items.map((i, idx) => ({
				workId: i.work.id,
				slug: i.work.slug,
				title: i.work.title,
				type: i.work.type,
				thumbnail: i.work.thumbnail,
				// This line's own share of the basket's ONE card fee — pro-rata by value,
				// the same apportionment the purchase rows are written with. The receipt's
				// creator group reads it, so the receives line's tooltip can name what was
				// taken out of this creator's part of the basket.
				processingFee: lineFees[idx].toFixed(2),
				price: i.amount.toFixed(2),
			})),
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
	 * Buy a basket on one charge — one Checkout Session, one card fee, one row per Work.
	 *
	 * Deliberately a sibling of `/checkout/:slug` rather than a replacement: a single
	 * purchase is the overwhelming case and there is no reason to make it travel through
	 * a list. What the two must share is the *money*, and they do — both quote
	 * `calculateFees`, both charge through a Checkout Session with automatic tax, and
	 * both pin the creator's transfer to their earnings via `transfer_data[amount]`.
	 */
	.post("/basket/checkout", requireAuth, requireVerified, async (c) => {
		const user = c.get("user");
		// Same rule as quote: the account's resolved basket is what's bought — an item
		// that stopped being buyable is excluded by the same resolution the page showed,
		// and what remains is re-resolved by `resolveBasket` below, whose refusal paths
		// keep firing on it. Nothing trusts the table further than the client's old word
		// was trusted.
		const stored = await resolvedBasketItems(user.id);
		const workIds = stored.map((row) => row.workId);
		const q = await resolveBasket(workIds.map(Number).filter(Number.isFinite), user.id);
		if (!q.ok) return c.json({ error: q.error, code: "code" in q ? q.code : undefined }, q.status);

		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// Same hard precondition as a single purchase, now per creator: Anthers does not
		// sell a creator's work when the money cannot reach them — and a basket can ask
		// for several creators' money to move at once, so every one of them must be
		// reachable before the buyer is charged.
		if (q.creatorIds.some((id) => id == null))
			return c.json({ error: "This work is no longer for sale." }, 409);
		const accounts = await db
			.select()
			.from(stripeAccounts)
			.where(inArray(stripeAccounts.userId, q.creatorIds as number[]));
		for (const creatorId of q.creatorIds as number[]) {
			const account = accounts.find((a) => a.userId === creatorId);
			if (!account?.onboardingComplete || !account.payoutsEnabled) {
				return c.json({ error: "This creator can't accept payments yet." }, 409);
			}
		}

		// One line per Work, each with its own tax code — a basket can span media, and a
		// video and an image are not taxed as the same thing in every jurisdiction.
		const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
		for (const { work, amount } of q.items) {
			const taxCode = purchaseTaxCode(work.type as WorkType);
			// `resolvePurchase` already refused the types with no code, so this is the
			// belt on a door the single-purchase path refuses at.
			if (!taxCode)
				return c.json({ error: "This work can't be taxed yet, so it can't be sold." }, 400);
			lineItems.push(workLineItem(work, Math.round(amount.toNumber() * 100), taxCode));
		}

		const session = await createCheckoutSession(
			purchaseSession({
				origin:
					process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000",
				lineItems,
				customerId: await stripeCustomerIdFor(user.id),
				customerEmail: user.email,
				metadata: {
					kind: "direct_purchase_basket",
					workIds: q.items.map((i) => i.work.id).join(","),
					buyerId: String(user.id),
				},
			}),
		);
		if (!session?.client_secret) return c.json({ error: "Payments are not configured." }, 503);

		/**
		 * One row per Work, all sharing the PaymentIntent — because access, refunds and
		 * the buyer's Library are all **per Work** and must stay that way. The basket is a
		 * property of the *charge*, not of the entitlement.
		 *
		 * 🚨 The per-item money is apportioned, not recomputed. `calculateFees` on a $1
		 * item would attach a fresh $0.30 to it, so the rows would sum to far more than
		 * was charged and every downstream user — earnings, the tax remittance record,
		 * refunds — would be wrong. The fee is split **pro-rata by item value**, with the
		 * last row absorbing the rounding remainder so the parts sum to the whole exactly.
		 */
		const rows = q.items.map(({ work, amount }, idx) => {
			const isLast = idx === q.items.length - 1;
			const share = (total: Decimal) =>
				isLast
					? total.minus(
							q.items
								.slice(0, -1)
								.reduce(
									(acc, it) =>
										acc.plus(total.times(it.amount).dividedBy(q.subtotal).toDecimalPlaces(2)),
									new Decimal(0),
								),
						)
					: total.times(amount).dividedBy(q.subtotal).toDecimalPlaces(2);
			const processing = share(q.fees.processingFee);
			// The session's tax is stamped per charge at completion and apportioned across
			// the rows then; at checkout every row is zero, because Anthers' arithmetic
			// knows no buyer location. The apportioning still runs so the shape of the
			// row building is unchanged, and a zero total apportions to zero exactly.
			const tax = share(q.fees.salesTax);
			return {
				buyerId: user.id,
				workId: work.id,
				creatorId: work.creatorId,
				workTitle: work.title,
				workType: work.type,
				workPublicId: work.publicId,
				type: "digital" as const,
				amount: amount.toFixed(2),
				processingFee: processing.toFixed(2),
				salesTax: tax.toFixed(2),
				creatorEarnings: amount.minus(processing).toFixed(2),
				// The session id, as on the single-purchase path — the PaymentIntent is
				// resolved from the session at completion and the rows re-keyed to it.
				stripePaymentIntentId: session.id,
				status: "pending" as const,
			};
		});
		await db.insert(purchases).values(rows);

		// The basket has been bought — emptied now, at the moment the charge exists, rather
		// than waiting on the webhook: a buyer who closes the tab at the Pay screen holds a
		// session they can come back and confirm, and the basket's ids are already spent.
		// (The webhook completing is what grants access; this only stops the badge counting
		// what they have just paid for.)
		await clearBasket(user.id);

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
				workCoverImage: works.thumbnail,
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
					// visibility and cover deliberately do NOT: they only exist to link and
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
					coverImage: r.workCoverImage,
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

	// ── Subsidy Status ────────────────────────────────────────────────────
	.get("/crf/status", requireAuth, async (c) => {
		const user = c.get("user");

		// Total charitable balance
		const [balance] = await db
			.select({ total: sql<string>`COALESCE(SUM(amount), '0.00')` })
			.from(crfLedger);

		// User's subsidies (last 6)
		const subsidies = await db
			.select()
			.from(crfSubsidies)
			.where(eq(crfSubsidies.creatorId, user.id))
			.orderBy(desc(crfSubsidies.billingCycle))
			.limit(6);

		return c.json({
			balance: balance.total,
			subsidies,
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
				// What you bought lands on your shelf, and stays there. This is the ONLY
				// place a purchase completes, which is why the hook belongs here rather
				// than at checkout: a card that never clears must not put anything in a
				// Library. Note the shelf entry is a *consequence* of the purchase and
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
