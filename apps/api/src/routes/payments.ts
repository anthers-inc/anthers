// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Payment routes — Stripe Connect onboarding, checkout, purchases, Foundation Fee.
 *
 * Direct purchases run as Stripe destination charges: the buyer is charged the
 * full total, the creator's connected account receives 100% of the listed price
 * as the transfer destination, and the platform keeps the rest (Foundation Fee,
 * at-cost bandwidth, sales tax) as the application fee. When the creator has no
 * connected account yet, it falls back to a plain charge held on the platform.
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
import { calculateFees } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { getStripe } from "../lib/stripe.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";
import { applyCreditForPurchase, syncSubscriptionToAccount } from "../services/billing.js";

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

	// Pass-through model: the creator receives the full listed price; the Foundation Fee,
	// delivery bandwidth, and card + tax are added on top and paid by the buyer.
	// Digital download → Digital AFF (50% of the download's bandwidth).
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
			type: "digital",
			amount: amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			deliveryFee: fees.deliveryFee.toFixed(2),
			crfFee: fees.crfFee.toFixed(2),
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

		const result = await db
			.select({
				purchase: purchases,
				workTitle: works.title,
				workSlug: works.slug,
				workCoverImage: works.thumbnail,
				workType: works.type,
				creatorId: works.creatorId,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(purchases)
			.innerJoin(works, eq(purchases.workId, works.id))
			.innerJoin(users, eq(works.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(purchases.createdAt));

		return c.json({
			purchases: result.map((r) => ({
				...r.purchase,
				work: {
					title: r.workTitle,
					slug: r.workSlug,
					coverImage: r.workCoverImage,
					type: r.workType,
				},
				creator: {
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
			})),
		});
	})

	// ── Foundation Status ────────────────────────────────────────────────────
	.get("/crf/status", requireAuth, async (c) => {
		const user = c.get("user");

		// Total Foundation balance
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
					// Post purchase → record the Foundation Fee (Digital AFF) to the ledger.
					await db.insert(crfLedger).values({
						amount: completed.crfFee,
						purchaseId: completed.id,
						description: `Digital AFF — purchase #${completed.id}`,
					});
				}
			}
		} else if (event.type === "payment_intent.payment_failed") {
			const pi = event.data.object as Stripe.PaymentIntent;
			await db
				.update(purchases)
				.set({ status: "failed", updatedAt: new Date() })
				.where(and(eq(purchases.stripePaymentIntentId, pi.id), eq(purchases.status, "pending")));
			// NOT HANDLED: `charge.refunded`. There is no refund route and no handler — only a
			// `refunded` value in the purchases.status enum. The rule the implementation must
			// satisfy is settled (51.02 § Refunds) even though the code isn't written:
			//
			//   • Reverse the transfer (`reverse_transfer: true`) so the creator is clawed back
			//     EXACTLY their earnings and never goes negative. A creator is never billed for
			//     a buyer's refund — that would be a cut, just a negative one.
			//   • Stripe does NOT return its processing fee on a refund. That ~$0.88 on a $20
			//     sale, plus any bytes already served, comes out of the Foundation remainder —
			//     the same shock absorber that carries the free floor.
			//   • The 14-day payout hold is what keeps this small: in the ordinary case the
			//     principal has not left yet, so there is nothing to claw back.
			//
			// OPEN, and it needs a policy answer before the storefront takes real money: a
			// buy → download → refund cycle costs the Foundation ~$0.98 each time and returns a
			// working copy. The bytes cannot be un-sent.
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
