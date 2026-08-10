// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Payment routes — Stripe Connect onboarding, checkout, purchases, charitable ledger.
 *
 * Direct purchases run as Stripe destination charges. Since 2026-08-03 the listed
 * price IS the advertised price: card processing and the first download's bandwidth
 * come **out of** it and sales tax is the only thing added on top, so the buyer is
 * charged price + tax, the creator's connected account receives the price less those
 * at-cost deductions, and the application fee is the remainder — which is tax and
 * delivery, never a cut. Anthers keeps $0. A creator with no connected account is a
 * hard 409, not a platform-held fallback.
 */

import { db } from "@anthers/db/client";
import {
	assets,
	crfLedger,
	crfSubsidies,
	purchases,
	stripeAccounts,
	users,
	works,
} from "@anthers/db/schema";
import { REFUND_AUTO_CAP } from "@anthers/shared/constants";
import { calculateFees } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";
import { applyCreditForPurchase, syncSubscriptionToAccount } from "../services/billing.js";
import {
	refundPurchase,
	refundsAfterDownloadInWindow,
	settleRefundedPurchase,
} from "../services/refunds.js";

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

	// Delivery (bandwidth) scales with the total size of this Work's downloadable assets.
	const [assetSize] = await db
		.select({ bytes: sql<number>`COALESCE(SUM(${assets.fileSize}), 0)` })
		.from(assets)
		.where(eq(assets.workId, work.id));

	// All-in list price: card processing and this delivery come OUT of the price, sales
	// tax is added on top, and Anthers keeps $0 (the purchase fee was removed
	// 2026-08-03). `calculateFees` owns that arithmetic — never restate it at a call site.
	const fees = calculateFees(amount, { deliveryBytes: assetSize?.bytes ?? 0, type: "digital" });
	return { ok: true as const, work, amount, fees };
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
		const stripe = getStripe();
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

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
			const account = await stripe.accounts.create({
				type: "express",
				email: user.email ?? undefined,
				capabilities: { transfers: { requested: true } },
				metadata: { userId: String(user.id) },
			});
			accountId = account.id;
			await db.insert(stripeAccounts).values({ userId: user.id, stripeAccountId: accountId });
		}

		// Return here after the hosted flow; the account.updated webhook syncs enablement.
		const base =
			process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000";
		const link = await stripe.accountLinks.create({
			account: accountId,
			refresh_url: `${base}/studio/payouts?refresh=1`,
			return_url: `${base}/studio/payouts?onboarded=1`,
			type: "account_onboarding",
		});

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
			salesTax: fees.salesTax.toFixed(2),
			buyerTotal: fees.buyerTotal.toFixed(2),
		});
	})

	// ── Checkout ─────────────────────────────────────────────────────────────
	.post("/checkout/:slug", requireAuth, requireVerified, async (c) => {
		const user = c.get("user");
		const q = await resolvePurchase(c.req.param("slug"), user.id);
		if (!q.ok) return c.json({ error: q.error }, q.status);
		const { work, amount, fees } = q;

		const stripe = getStripe();
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		// A connected creator is a HARD PRECONDITION, not a mode switch. Anthers does not
		// sell a creator's work when the money cannot reach them: this route used to fall
		// back to a plain platform-held charge "so the plumbing is testable before Connect
		// onboarding", but the buy UI has always refused to render without
		// `creatorHasStripe`, so that branch was unreachable from the product and would
		// have parked buyers' money in a platform balance nobody reconciles. Failing here
		// is louder and matches what the interface already promises.
		const [creatorAccount] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, work.creatorId))
			.limit(1);
		if (!creatorAccount?.onboardingComplete || !creatorAccount.payoutsEnabled) {
			return c.json({ error: "This creator can't accept payments yet." }, 409);
		}

		const totalCents = Math.round(fees.buyerTotal.toNumber() * 100);
		// What the platform retains from the destination charge: everything the buyer pays
		// that is not the creator's earnings — i.e. sales tax (remitted to the state) and
		// the at-cost delivery. Card processing is Stripe's own cut of the charge and is
		// never part of the application fee, so it must not be counted here.
		const applicationFeeCents = Math.round(
			fees.buyerTotal.minus(fees.creatorEarnings).minus(fees.processingFee).toNumber() * 100,
		);

		const params: Stripe.PaymentIntentCreateParams = {
			amount: totalCents,
			currency: "usd",
			payment_method_types: ["card"],
			metadata: { kind: "direct_purchase", workId: String(work.id), buyerId: String(user.id) },
		};
		// The buyer pays the all-in list price plus sales tax; the creator receives that
		// price less the at-cost card processing and the first download's bandwidth, and
		// Anthers retains $0 of it. Guarded because a fee at or above the total would be
		// rejected by Stripe anyway.
		if (applicationFeeCents < totalCents) {
			params.application_fee_amount = applicationFeeCents;
			params.transfer_data = { destination: creatorAccount.stripeAccountId };
		}

		const paymentIntent = await stripe.paymentIntents.create(params);

		// Record the purchase as pending; the webhook flips it to completed on success,
		// and access unlocks the moment a completed row exists.
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
			// Recorded because it is collected and owed onward — the row is the
			// remittance record. It rides inside `buyerTotal`, so without this column
			// the amount of tax charged could not be recovered from the purchase.
			salesTax: fees.salesTax.toFixed(2),
			creatorEarnings: fees.creatorEarnings.toFixed(2),
			stripePaymentIntentId: paymentIntent.id,
			status: "pending",
		});

		return c.json({
			amount: amount.toFixed(2), // the all-in list price the buyer was shown
			processingFee: fees.processingFee.toFixed(2), // out of the price, to Stripe
			deliveryFee: fees.deliveryFee.toFixed(2), // first download, at cost
			crfFee: fees.crfFee.toFixed(2), // always "0.00" — Anthers takes no cut
			salesTax: fees.salesTax.toFixed(2),
			creatorEarnings: fees.creatorEarnings.toFixed(2), // price − processing − delivery
			buyerTotal: fees.buyerTotal.toFixed(2), // price + tax — what the buyer is charged
			clientSecret: paymentIntent.client_secret,
		});
	})

	// ── Ownership Check ──────────────────────────────────────────────────────
	.get("/owns/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [work] = await db.select().from(works).where(eq(works.slug, slug)).limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		// "Owns" = can consume it now: creator, free, a prior purchase, or an
		// entitlement grant (subscriber/Seed). resolveAccess unifies all four.
		const access = await resolveAccess(work, user.id);
		return c.json({ owns: access.canAccess });
	})

	// ── Purchase History ─────────────────────────────────────────────────────
	.get("/purchases", requireAuth, async (c) => {
		const user = c.get("user");
		const month = c.req.query("month"); // optional YYYY-MM filter

		const conditions = [eq(purchases.buyerId, user.id), eq(purchases.status, "completed")];

		if (month) {
			const start = new Date(`${month}-01T00:00:00`);
			const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
			conditions.push(gte(purchases.createdAt, start));
			conditions.push(lte(purchases.createdAt, end));
		}

		// Both joins are LEFT joins, and the creator side hangs off `purchases.creatorId`
		// rather than `works.creatorId` (`0016`). As inner joins through `works` this
		// endpoint dropped a purchase entirely once its Work was deleted — the buyer's
		// own receipt vanished from their history, which is the one place it has to
		// remain. A Seed buy (no Work at all) was never listed here for the same reason.
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
				creatorUsername: users.username,
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
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
			})),
		});
	})

	// ── Refund ───────────────────────────────────────────────────────────────
	// Buyer-initiated. "Ask us and we will refund you" — no justification is
	// required and none is asked for, so `reason` is optional and free text kept
	// for our own reading, never a condition of the refund (51.06 § Refunds).
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
		const stripe = getStripe();
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		const sig = c.req.header("stripe-signature");
		const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
		if (!sig || !secret) return c.json({ error: "Missing signature or webhook secret." }, 400);

		// Verify against the raw body — constructEvent recomputes the HMAC, so the bytes
		// must be untouched (no c.req.json() before this).
		const raw = await c.req.text();
		let event: Stripe.Event;
		try {
			event = await stripe.webhooks.constructEventAsync(raw, sig, secret);
		} catch {
			return c.json({ error: "Signature verification failed." }, 400);
		}

		if (event.type === "payment_intent.succeeded") {
			const pi = event.data.object as Stripe.PaymentIntent;
			// Idempotent: only a still-pending row flips, so redelivered events are no-ops.
			const [completed] = await db
				.update(purchases)
				.set({ status: "completed", updatedAt: new Date() })
				.where(and(eq(purchases.stripePaymentIntentId, pi.id), eq(purchases.status, "pending")))
				.returning();
			if (completed) {
				if (completed.type === "seeds") {
					// A Seed buy → credit the account (not a post purchase).
					await applyCreditForPurchase(completed);
				} else {
					// Post purchase → record the (now always zero) purchase fee to the ledger.
					await db.insert(crfLedger).values({
						amount: completed.crfFee,
						purchaseId: completed.id,
						description: `Purchase fee (retired, always $0) — purchase #${completed.id}`,
					});
				}
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
				const [purchase] = await db
					.select()
					.from(purchases)
					.where(eq(purchases.stripePaymentIntentId, intentId))
					.limit(1);
				// The refund our own route just made arrives back here as an event; the
				// row is already `refunded` by then and `settleRefundedPurchase` no-ops on
				// it. What this branch really exists for is the refund issued from the
				// Stripe dashboard, which reaches us no other way — and that is an
				// operator action, so it books as platform-initiated and does not spend
				// the buyer's automatic allowance.
				if (purchase)
					await settleRefundedPurchase(purchase, {
						initiator: "platform",
						reason: "Refunded at Stripe",
						stripeRefundId:
							typeof charge.refunds?.data?.[0]?.id === "string" ? charge.refunds.data[0].id : null,
					});
			}
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
		}

		return c.json({ received: true });
	});

export { paymentRoutes };
