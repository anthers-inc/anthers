// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Payment routes — Stripe Connect onboarding, checkout, purchases, Foundation Fee.
 *
 * Note: Actual Stripe API calls are stubbed with TODO markers.
 * Stripe SDK will be integrated when payment processing is fully wired up.
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
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";

// ─── Routes ──────────────────────────────────────────────────────────────────

const paymentRoutes = new Hono()
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

		// Check for existing Stripe account
		const [existing] = await db
			.select()
			.from(stripeAccounts)
			.where(eq(stripeAccounts.userId, user.id))
			.limit(1);

		if (existing?.onboardingComplete) {
			return c.json({ error: "Stripe account already onboarded" }, 400);
		}

		// TODO: Create or retrieve Stripe Connect Express account
		// TODO: Generate AccountLink URL for onboarding
		// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
		// const account = await stripe.accounts.create({ type: "express", ... });
		// const link = await stripe.accountLinks.create({ account: account.id, ... });

		return c.json({
			url: "https://connect.stripe.com/setup/placeholder",
			message: "Stripe Connect onboarding not yet implemented",
		});
	})

	// ── Checkout ─────────────────────────────────────────────────────────────
	.post("/checkout/:slug", requireAuth, requireVerified, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [post] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		// resolveAccess is the source of truth: owner / free / entitled / already-purchased
		// all mean "nothing to buy"; a hard gate with no price path isn't purchasable.
		const access = await resolveAccess(post, user.id);
		if (access.canAccess) {
			return c.json({ error: "You already have access to this post" }, 400);
		}
		if (!access.requiresPurchase || !access.price) {
			return c.json({ error: "This post is not available for direct purchase" }, 400);
		}

		const amount = new Decimal(access.price);
		if (amount.lte(0)) {
			return c.json({ error: "This post is free" }, 400);
		}

		// Delivery (bandwidth) scales with the total size of the downloadable assets on the
		// content items this post references (assets now belong to items, not the post).
		const [assetSize] = await db
			.select({ bytes: sql<number>`COALESCE(SUM(${assets.fileSize}), 0)` })
			.from(assets)
			.innerJoin(postContents, eq(postContents.contentItemId, assets.contentItemId))
			.where(eq(postContents.postId, post.id));

		// Pass-through model: the creator receives the full listed price; processing,
		// the Foundation Fee, and delivery are added on top and paid by the buyer.
		const fees = calculateFees(amount, assetSize?.bytes ?? 0);

		// TODO: Create Stripe PaymentIntent
		// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
		// const paymentIntent = await stripe.paymentIntents.create({
		//   amount: Math.round(fees.buyerTotal.toNumber() * 100), // buyer pays price + fees
		//   currency: "usd",
		//   application_fee_amount: Math.round(fees.processingFee.plus(fees.crfFee).toNumber() * 100), // fees only; creator keeps 100%
		//   transfer_data: { destination: creatorStripeAccountId },
		// });

		return c.json({
			amount: amount.toFixed(2), // listed price — what the creator receives
			processingFee: fees.processingFee.toFixed(2),
			deliveryFee: fees.deliveryFee.toFixed(2), // download bandwidth
			crfFee: fees.crfFee.toFixed(2), // Legacy field name for Foundation Fee
			creatorEarnings: fees.creatorEarnings.toFixed(2), // == amount (pass-through)
			buyerTotal: fees.buyerTotal.toFixed(2), // price + fees — what the buyer is charged
			clientSecret: "placeholder_client_secret",
			message: "Stripe checkout not yet fully implemented",
		});
	})

	// ── Ownership Check ──────────────────────────────────────────────────────
	.get("/owns/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [post] = await db.select().from(posts).where(eq(posts.slug, slug)).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		// "Owns" = can consume it now: creator, free, a prior purchase, or an
		// entitlement grant (subscriber/boost). resolveAccess unifies all four.
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
		// TODO: Verify Stripe webhook signature
		// TODO: Handle payment_intent.succeeded → complete purchase, record Foundation Fee
		// TODO: Handle account.updated → sync onboarding state
		// TODO: read the raw body + Stripe-Signature header to verify the event

		// Placeholder — will be implemented with Stripe SDK
		return c.json({ received: true });
	});

export { paymentRoutes };
