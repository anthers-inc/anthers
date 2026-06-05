// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Payment routes — Stripe Connect onboarding, checkout, purchases, Foundation Fee.
 *
 * Note: Actual Stripe API calls are stubbed with TODO markers.
 * Stripe SDK will be integrated when payment processing is fully wired up.
 */

import { db } from "@anthers/db/client";
import {
	crfLedger,
	crfSubsidies,
	projects,
	purchases,
	stripeAccounts,
	users,
} from "@anthers/db/schema";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const FOUNDATION_FEE_PERCENTAGE = 0.03; // Anthers Foundation Fee: 3%
const PROCESSING_FEE_PERCENTAGE = 0.029; // 2.9%
const PROCESSING_FEE_FIXED = 0.3; // $0.30

function calculateFees(amount: number) {
	const processingFee = Number(
		(amount * PROCESSING_FEE_PERCENTAGE + PROCESSING_FEE_FIXED).toFixed(2),
	);
	const foundationFee = Number((amount * FOUNDATION_FEE_PERCENTAGE).toFixed(2));
	const creatorEarnings = Number((amount - processingFee - foundationFee).toFixed(2));
	// crfFee: legacy field name for Anthers Foundation Fee
	return { processingFee, crfFee: foundationFee, creatorEarnings };
}

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
	.post("/checkout/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [project] = await db.select().from(projects).where(eq(projects.slug, slug)).limit(1);

		if (!project) return c.json({ error: "Project not found" }, 404);

		if (project.pricingType === "free") {
			return c.json({ error: "This project is free" }, 400);
		}

		// Check if already purchased
		const [existingPurchase] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, user.id),
					eq(purchases.projectId, project.id),
					eq(purchases.status, "completed"),
				),
			)
			.limit(1);

		if (existingPurchase) {
			return c.json({ error: "Already purchased" }, 400);
		}

		const amount = Number(project.price ?? project.minPrice ?? "0");
		if (amount <= 0) {
			return c.json({ error: "Invalid price" }, 400);
		}

		const fees = calculateFees(amount);

		// TODO: Create Stripe PaymentIntent
		// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
		// const paymentIntent = await stripe.paymentIntents.create({
		//   amount: Math.round(amount * 100),
		//   currency: "usd",
		//   application_fee_amount: Math.round((fees.processingFee + fees.crfFee) * 100), // crfFee = Foundation Fee
		//   transfer_data: { destination: creatorStripeAccountId },
		// });

		return c.json({
			amount: amount.toFixed(2),
			processingFee: fees.processingFee.toFixed(2),
			crfFee: fees.crfFee.toFixed(2), // Legacy field name for Foundation Fee
			creatorEarnings: fees.creatorEarnings.toFixed(2),
			clientSecret: "placeholder_client_secret",
			message: "Stripe checkout not yet fully implemented",
		});
	})

	// ── Ownership Check ──────────────────────────────────────────────────────
	.get("/owns/:slug", requireAuth, async (c) => {
		const user = c.get("user");
		const { slug } = c.req.param();

		const [project] = await db
			.select({ id: projects.id, creatorId: projects.creatorId, pricingType: projects.pricingType })
			.from(projects)
			.where(eq(projects.slug, slug))
			.limit(1);

		if (!project) return c.json({ error: "Project not found" }, 404);

		// Free projects: everyone "owns" them
		if (project.pricingType === "free") {
			return c.json({ owns: true });
		}

		// Creator always owns their own project
		if (project.creatorId === user.id) {
			return c.json({ owns: true });
		}

		// Check purchase
		const [purchase] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, user.id),
					eq(purchases.projectId, project.id),
					eq(purchases.status, "completed"),
				),
			)
			.limit(1);

		return c.json({ owns: !!purchase });
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
				projectTitle: projects.title,
				projectSlug: projects.slug,
				projectCoverImage: projects.coverImage,
				projectMediaType: projects.mediaType,
				creatorId: projects.creatorId,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(purchases)
			.innerJoin(projects, eq(purchases.projectId, projects.id))
			.innerJoin(users, eq(projects.creatorId, users.id))
			.where(and(...conditions))
			.orderBy(desc(purchases.createdAt));

		return c.json({
			purchases: result.map((r) => ({
				...r.purchase,
				project: {
					title: r.projectTitle,
					slug: r.projectSlug,
					coverImage: r.projectCoverImage,
					mediaType: r.projectMediaType,
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

		const body = await c.req.text();
		const sig = c.req.header("Stripe-Signature");

		// Placeholder — will be implemented with Stripe SDK
		return c.json({ received: true });
	});

export { paymentRoutes };
