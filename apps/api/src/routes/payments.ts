// SPDX-License-Identifier: Apache-2.0
/**
 * Payment routes — Stripe Connect onboarding, checkout, purchases, charitable ledger.
 *
 * ⚠️ **No payment operation is a direct SDK call.** This route goes through
 * `lib/processor.ts`, the processor boundary — see that module's header for why the
 * vendor must stay swappable and why every new payment operation belongs there rather
 * than here as `stripe.<resource>.<op>`.
 *
 * Direct purchases run as Stripe destination charges, through a **Checkout Session in
 * elements mode with automatic tax** — a PaymentIntent cannot carry a product tax code,
 * so it cannot charge real tax, and real tax is what every charge now owes. Since
 * 2026-08-03 the listed price IS the advertised price: card processing comes **out of**
 * it, and sales tax is the only thing added on top — resolved by Stripe Tax from the
 * buyer's billing address at the session, per the product tax code each line carries
 * (the posture's What Gets Taxed table). The creator's connected account receives the
 * price less that at-cost deduction, pinned by `transfer_data[amount]` so it never
 * varies with the buyer's location; the tax lands on the platform side by construction,
 * because Anthers is the marketplace facilitator and the liability. Anthers keeps $0.
 * A creator with no connected account is a hard 409, not a platform-held fallback.
 *
 * A digital sale also carried the first download's bandwidth at cost until
 * 2026-08-12. Delivery is free on R2, so `deliveryFee` is now always $0.00 and every
 * download of a purchased Work is included forever, on any number of devices.
 */

import { db } from "@anthers/db/client";
import {
	crfLedger,
	crfSubsidies,
	purchases,
	stripeAccounts,
	users,
	works,
} from "@anthers/db/schema";
import { cycleEnd, cycleStart } from "@anthers/shared/billing-cycle";
import { isChargeableAmount, MAX_BASKET_ITEMS, REFUND_AUTO_CAP } from "@anthers/shared/constants";
import { calculateFees } from "@anthers/shared/fees";
import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import type { WorkType } from "@anthers/shared/tax-codes";
import { purchaseTaxCode } from "@anthers/shared/tax-codes";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import {
	createAccountOnboardingLink,
	createCheckoutSession,
	createConnectAccount,
	listCheckoutSessions,
	paymentsConfigured,
	verifyWebhookSignature,
} from "../lib/processor.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";
import { syncSubscriptionToAccount } from "../services/billing.js";
import { markInvoiceMoneyReturned, recordPaidInvoice } from "../services/invoices.js";
import { saveOnPurchase } from "../services/library.js";
import {
	refundPurchase,
	refundsAfterDownloadInWindow,
	settleRefundedPurchase,
} from "../services/refunds.js";
import { applyReductionsToInvoice } from "../services/support-reductions.js";

/**
 * Shared purchase resolution for checkout and quote: find the Work, confirm it's
 * purchasable by this viewer, and compute the fee breakdown — so both endpoints
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
	if (!access.requiresPurchase || !access.price)
		return {
			ok: false as const,
			status: 400 as const,
			error: "This work is not available for direct purchase",
		};

	const amount = new Decimal(access.price);
	if (amount.lte(0))
		return { ok: false as const, status: 400 as const, error: "This work is free" };

	// 🚨 **A physical or service Work is refused at checkout, because nothing fulfills
	// it yet.** There is no shipping lane for a physical Work and no fulfillment
	// mechanism for a service one, so a buyer would pay for a thing that never arrives —
	// and there is no tax code that honestly describes an undelivered thing either
	// (`purchaseTaxCode` returns null for both). This is the posture's refusal rather
	// than a judgment about the types: selling them arrives with whatever fulfills
	// them, and until then checkout is the one door that has to say no.
	if (work.type === "physical" || work.type === "service")
		return {
			ok: false as const,
			status: 400 as const,
			error: "This kind of work can't be bought yet — there's nothing to deliver it.",
		};

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
 * 🚨 **One creator per basket, and that is forced rather than chosen.** Stripe's
 * `transfer_data.destination` names exactly one connected account, so a basket spanning
 * two creators cannot be a single destination charge. The alternative — separate charges
 * and transfers — parks the buyers' money in a **platform balance** before paying it out,
 * which is precisely what `/checkout/:slug` refuses to do, and it is the *conduit* framing
 * the counsel brief (Payments and Exempt-Purpose Counsel Brief) says makes both the money-transmission answer and the 501(c)(3) story harder.
 * That is a question for counsel, not a thing to decide in a route handler. Until it is
 * answered, a multi-creator basket is refused with `mixed_creators` and the client checks
 * out one creator at a time.
 *
 * What the basket buys is the **fixed $0.30**, which is per *charge* and not per item:
 * five $1 tracks pay $1.65 in card fees separately and $0.45 together, and the whole
 * $1.20 goes to the creator because Anthers keeps nothing either way. Same mechanism as
 * batching a month's support onto one transaction (the wiki's *How Money Moves*).
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

	const creatorIds = new Set(items.map((i) => i.work.creatorId));
	if (creatorIds.size > 1)
		return {
			ok: false as const,
			status: 400 as const,
			error: "A basket can only hold work from one creator at a time",
			code: "mixed_creators" as const,
		};

	// 🚨 Fees on the SUM, once — computing per item and adding would charge the flat
	// $0.30 per Work and defeat the entire point of the basket.
	const subtotal = items.reduce((acc, i) => acc.plus(i.amount), new Decimal(0));
	const fees = calculateFees(subtotal, { type: "digital" });
	return { ok: true as const, items, subtotal, fees, creatorId: items[0].work.creatorId };
}

/**
 * Build the Checkout Session a purchase is charged through — the one charge shape that can
 * carry a product tax code, and so the only path a purchase has been charged through since
 * real tax calculation landed (2026-09-29).
 *
 * 🚨 **`transfer_data[amount]`, not `application_fee_amount` — the destination-charge
 * structure this switch exists for.** A static application fee was workable only while the
 * tax was a flat figure Anthers computed itself, because the fee had to be
 * `buyerTotal − creatorEarnings` and both were known at session creation. Under automatic
 * tax the amount varies with the buyer's address, so nothing static can capture it. Instead
 * the creator's transfer is pinned to their **earnings** — `price − cardFee(price)`, fixed
 * and location-independent — and whatever tax Stripe adds lands on the platform side by
 * construction, because it never entered the transfer. Anthers is the marketplace
 * facilitator and the tax liability (the Creator Terms say so), so `automatic_tax` carries
 * no `liability`: plain `enabled: true` keeps the liability on the platform, where the
 * Creator Terms already put it. `refund_application_fee` in `services/refunds.ts` stays
 * unset for the same reason.
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
	/** The creator's connected account. */
	destination: string;
	/** The creator's earnings in cents — the fixed, location-independent transfer. */
	transferAmountCents: number;
	metadata: Record<string, string>;
}): Stripe.Checkout.SessionCreateParams {
	return {
		mode: "payment",
		ui_mode: "elements",
		// The buyer's billing address is what tax resolves from, and it is required in full
		// because local tax is address-level rather than state-level — the same full street
		// address the return worksheets and the threshold forecast later read off the row.
		billing_address_collection: "required",
		// A Customer is created for every buyer, so the address and email survive the
		// session and are readable at completion.
		customer_creation: "always",
		payment_method_types: ["card"],
		line_items: params.lineItems,
		automatic_tax: { enabled: true },
		payment_intent_data: {
			// The creator's earnings, fixed at session creation — see the header.
			transfer_data: {
				destination: params.destination,
				amount: params.transferAmountCents,
			},
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
			});
		}

		return c.json({
			hasAccount: true,
			stripeAccountId: account.stripeAccountId,
			chargesEnabled: account.chargesEnabled,
			payoutsEnabled: account.payoutsEnabled,
			onboardingComplete: account.onboardingComplete,
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

	// ── Quote (accurate fee preview, no charge) ──────────────────────────────
	.get("/quote/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const q = await resolvePurchase(c.req.param("slug"), user.id);
		if (!q.ok) return c.json({ error: q.error }, q.status);
		const { amount, fees } = q;
		return c.json({
			amount: amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			deliveryFee: fees.deliveryFee.toFixed(2),
			crfFee: fees.crfFee.toFixed(2),
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
		// The creator's transfer: their earnings in cents — the price less the at-cost card
		// processing, FIXED at session creation. This is the destination-charge structure
		// under automatic tax: `transfer_data[amount]` pins what reaches the creator so it
		// never varies with the buyer's location, and whatever tax Stripe adds stays on
		// the platform side by construction. See `purchaseSession`.
		const transferCents = Math.round(fees.creatorEarnings.toNumber() * 100);

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
				destination: creatorAccount.stripeAccountId,
				transferAmountCents: transferCents,
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
			deliveryFee: fees.deliveryFee.toFixed(2),
			crfFee: fees.crfFee.toFixed(2),
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
			deliveryFee: fees.deliveryFee.toFixed(2), // always "0.00" — delivery is free
			crfFee: fees.crfFee.toFixed(2), // always "0.00" — Anthers takes no cut
			// No figure: the tax is resolved at the session, from the buyer's address.
			salesTax: null,
			creatorEarnings: fees.creatorEarnings.toFixed(2), // price − processing
			buyerTotal: null, // the total lives in the session, with the tax in it
			// The Checkout Session's client secret — the browser mounts Checkout from it.
			clientSecret: session.client_secret,
		});
	})

	/**
	 * What a basket would cost, without creating anything. The buy UI quotes from here so
	 * the saving is visible *before* the decision, which is the whole reason a basket is
	 * worth building rather than a convenience.
	 */
	.post("/basket/quote", requireAuth, async (c) => {
		const user = c.get("user");
		const body = await c.req.json().catch(() => null);
		const workIds = Array.isArray(body?.workIds) ? (body.workIds as number[]) : [];
		const q = await resolveBasket(workIds.map(Number).filter(Number.isFinite), user.id);
		if (!q.ok) return c.json({ error: q.error, code: "code" in q ? q.code : undefined }, q.status);

		// What the same items would have cost bought one at a time. Not decoration: it is
		// the number that makes the basket legible, and it is derived rather than typed —
		// `cardFee` per item, summed, against one `cardFee` on the subtotal.
		const separately = q.items.reduce(
			(acc, i) => acc.plus(calculateFees(i.amount, { type: "digital" }).processingFee),
			new Decimal(0),
		);

		return c.json({
			items: q.items.map((i) => ({
				workId: i.work.id,
				slug: i.work.slug,
				title: i.work.title,
				type: i.work.type,
				thumbnail: i.work.thumbnail,
				price: i.amount.toFixed(2),
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
		const body = await c.req.json().catch(() => null);
		const workIds = Array.isArray(body?.workIds) ? (body.workIds as number[]) : [];
		const q = await resolveBasket(workIds.map(Number).filter(Number.isFinite), user.id);
		if (!q.ok) return c.json({ error: q.error, code: "code" in q ? q.code : undefined }, q.status);

		if (!paymentsConfigured()) return c.json({ error: "Payments are not configured." }, 503);

		// Same hard precondition as a single purchase: Anthers does not sell a creator's
		// work when the money cannot reach them.
		if (q.creatorId == null) return c.json({ error: "This work is no longer for sale." }, 409);
		const [creatorAccount] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, q.creatorId))
			.limit(1);
		if (!creatorAccount?.onboardingComplete || !creatorAccount.payoutsEnabled) {
			return c.json({ error: "This creator can't accept payments yet." }, 409);
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
				destination: creatorAccount.stripeAccountId,
				// The whole basket's earnings, on the sum — the fixed $0.30 is per charge,
				// which is the entire point of the basket.
				transferAmountCents: Math.round(q.fees.creatorEarnings.toNumber() * 100),
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
		 * was charged and every downstream reader — earnings, the tax remittance record,
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
				deliveryFee: "0.00",
				crfFee: "0.00",
				salesTax: tax.toFixed(2),
				creatorEarnings: amount.minus(processing).toFixed(2),
				// The session id, as on the single-purchase path — the PaymentIntent is
				// resolved from the session at completion and the rows re-keyed to it.
				stripePaymentIntentId: session.id,
				status: "pending" as const,
			};
		});
		await db.insert(purchases).values(rows);

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

				// Record the (now always zero) purchase fee to the ledger.
				//
				// ⚠️ A `type === "seeds"` branch sat here and credited the one-off support
				// top-up. Nothing creates a row of that type since the top-up retired on
				// 2026-09-15 — support is the subscription and only the subscription — so a
				// completed purchase is always a Work purchase now. Rows of the old type can
				// still be read, which is why `services/refunds.ts` and `services/dmca.ts`
				// still know the value; nothing can still be written.
				await db.insert(crfLedger).values({
					amount: completed.crfFee,
					purchaseId: completed.id,
					description: `Purchase fee (retired, always $0) — purchase #${completed.id}`,
				});
			}
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
				for (const purchase of refundedRows)
					await settleRefundedPurchase(purchase, {
						initiator: "platform",
						reason: "Refunded at Stripe",
						stripeRefundId:
							typeof charge.refunds?.data?.[0]?.id === "string" ? charge.refunds.data[0].id : null,
					});
			}
		} else if (event.type === "charge.dispute.created") {
			/**
			 * A chargeback on a support charge. Anthers does not contest one, so the money is treated
			 * as gone from the moment it is disputed rather than when the dispute closes.
			 */
			const dispute = event.data.object as Stripe.Dispute;
			const intentId =
				typeof dispute.payment_intent === "string"
					? dispute.payment_intent
					: (dispute.payment_intent?.id ?? null);
			if (intentId) await markInvoiceMoneyReturned(intentId, "disputed");
		} else if (event.type === "account.updated") {
			const acct = event.data.object as Stripe.Account;
			await db
				.update(stripeAccounts)
				.set({
					chargesEnabled: acct.charges_enabled,
					payoutsEnabled: acct.payouts_enabled,
					onboardingComplete: acct.details_submitted && acct.charges_enabled,
					updatedAt: new Date(),
				})
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
			await recordPaidInvoice(event.data.object as Stripe.Invoice);
		}

		return c.json({ received: true });
	});

export { paymentRoutes };
