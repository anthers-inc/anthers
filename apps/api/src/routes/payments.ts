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
	postContents,
	posts,
	purchases,
	stripeAccounts,
	users,
} from "@anthers/db/schema";
import { calculateFees } from "@anthers/shared/fees";
import Decimal from "decimal.js";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import type Stripe from "stripe";
import { stripe } from "../lib/stripe.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";
import { applyCreditForPurchase, syncSubscriptionToAccount } from "../services/billing.js";

/**
 * Shared purchase resolution for checkout and quote: find the post, confirm it's
 * purchasable by this viewer, and compute the fee breakdown — so both endpoints
 * quote identical numbers. Returns an error shape (with an HTTP status) or the
 * resolved post + amount + fees.
 */
async function resolvePurchase(slug: string, userId: number) {
	const [post] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
	if (!post) return { ok: false as const, status: 404 as const, error: "Post not found" };

	// resolveAccess is the source of truth: owner / free / entitled / already-purchased
	// all mean "nothing to buy"; a hard gate with no price path isn't purchasable.
	const access = await resolveAccess(post, userId);
	if (access.canAccess)
		return {
			ok: false as const,
			status: 400 as const,
			error: "You already have access to this post",
		};
	if (!access.requiresPurchase || !access.price)
		return {
			ok: false as const,
			status: 400 as const,
			error: "This post is not available for direct purchase",
		};

	const amount = new Decimal(access.price);
	if (amount.lte(0))
		return { ok: false as const, status: 400 as const, error: "This post is free" };

	// Delivery (bandwidth) scales with the total size of the downloadable assets on the
	// content items this post references (assets now belong to items, not the post).
	const [assetSize] = await db
		.select({ bytes: sql<number>`COALESCE(SUM(${assets.fileSize}), 0)` })
		.from(assets)
		.innerJoin(postContents, eq(postContents.contentItemId, assets.contentItemId))
		.where(eq(postContents.postId, post.id));

	// Pass-through model: the creator receives the full listed price; the Foundation Fee,
	// delivery bandwidth, and card + tax are added on top and paid by the buyer.
	// Digital download → Digital AFF (50% of the download's bandwidth).
	const fees = calculateFees(amount, { deliveryBytes: assetSize?.bytes ?? 0, type: "digital" });
	return { ok: true as const, post, amount, fees };
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
		const { post, amount, fees } = q;

		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		// Route 100% of the listed price to the creator when they're set up to receive it;
		// the application fee is everything else the buyer pays (Foundation Fee + at-cost
		// bandwidth + processing + sales tax). No connected account yet → a plain charge
		// held on the platform, so the plumbing is testable before Connect onboarding.
		const [creatorAccount] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, post.creatorId))
			.limit(1);
		const creatorConnected =
			!!creatorAccount?.onboardingComplete && !!creatorAccount.payoutsEnabled;

		const totalCents = Math.round(fees.buyerTotal.toNumber() * 100);
		const applicationFeeCents = Math.round(fees.buyerTotal.minus(amount).toNumber() * 100);

		const params: Stripe.PaymentIntentCreateParams = {
			amount: totalCents,
			currency: "usd",
			payment_method_types: ["card"],
			metadata: { kind: "direct_purchase", postId: String(post.id), buyerId: String(user.id) },
		};
		if (creatorConnected && applicationFeeCents < totalCents) {
			params.application_fee_amount = applicationFeeCents;
			params.transfer_data = { destination: creatorAccount.stripeAccountId };
		}

		const paymentIntent = await stripe.paymentIntents.create(params);

		// Record the purchase as pending; the webhook flips it to completed on success,
		// and access unlocks the moment a completed row exists.
		await db.insert(purchases).values({
			buyerId: user.id,
			postId: post.id,
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
			amount: amount.toFixed(2), // listed price — what the creator receives
			processingFee: fees.processingFee.toFixed(2),
			deliveryFee: fees.deliveryFee.toFixed(2), // download bandwidth (at cost)
			crfFee: fees.crfFee.toFixed(2), // Legacy field name for the Anthers Foundation Fee (AFF)
			salesTax: fees.salesTax.toFixed(2),
			creatorEarnings: fees.creatorEarnings.toFixed(2), // == amount (pass-through)
			buyerTotal: fees.buyerTotal.toFixed(2), // price + fees + tax — what the buyer is charged
			clientSecret: paymentIntent.client_secret,
		});
	})

	// ── Ownership Check ──────────────────────────────────────────────────────
	.get("/owns/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [post] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		// "Owns" = can consume it now: creator, free, a prior purchase, or an
		// entitlement grant (subscriber/Seed). resolveAccess unifies all four.
		const access = await resolveAccess(post, user.id);
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
				postTitle: posts.title,
				postSlug: posts.slug,
				postCoverImage: posts.thumbnail,
				postContentType: posts.contentType,
				creatorId: posts.creatorId,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(purchases)
			.innerJoin(posts, eq(purchases.postId, posts.id))
			.innerJoin(users, eq(posts.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(purchases.createdAt));

		return c.json({
			purchases: result.map((r) => ({
				...r.purchase,
				post: {
					title: r.postTitle,
					slug: r.postSlug,
					coverImage: r.postCoverImage,
					contentType: r.postContentType,
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
				if (completed.type === "wallet" || completed.type === "seeds") {
					// Wallet top-up / Seed buy → credit the account (not a post purchase).
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
