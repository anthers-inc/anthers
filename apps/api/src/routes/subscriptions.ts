// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Subscription routes — tiers, subscribe, cancel, attention tracking,
 * pool distributions, boosts, creator gates, content access.
 *
 * Tiers are thresholds on a continuous funding level. Users can fund at any
 * $1 increment. The boost budget is computed from the funding level, not
 * looked up by tier name.
 *
 * Note: Stripe subscription management is stubbed with TODO markers.
 */

import { db } from "@anthers/db/client";
import {
	attentionEvents,
	boostAllocations,
	creatorGates,
	poolDistributions,
	posts,
	subscriptions,
	users,
} from "@anthers/db/schema";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { resolveAccess } from "../services/access.js";
import { validateSession } from "../services/auth.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const TIERS = [
	{
		id: "free",
		name: "Free",
		price: 0,
		features: ["Browse and discover content", "Rate and comment", "Follow creators"],
	},
	{
		id: "root",
		name: "Root",
		price: 3,
		features: [
			"Support the platform",
			"Access subscriber-only content",
			"Pool distribution to creators",
			"Boost pool available at funding levels above $3",
		],
	},
	{
		id: "sprout",
		name: "Sprout",
		price: 7,
		features: [
			"Everything in Root",
			"Boost allocation (varies by funding level, $3.68+ at threshold)",
			"Gate access for boosted creators",
		],
	},
	{
		id: "petal",
		name: "Petal",
		price: 15,
		features: [
			"Everything in Sprout",
			"Boost allocation (varies by funding level, $11.04+ at threshold)",
			"Priority support",
		],
	},
	{
		id: "bloom",
		name: "Bloom",
		price: 30,
		features: [
			"Everything in Petal",
			"Boost allocation (varies by funding level, $24.84+ at threshold)",
			"Creator analytics insights",
		],
	},
];

/**
 * V2 economics: Boost Pool = ceil(fundingLevel × 0.5), in $1 increments.
 * Time Pool = (fundingLevel × 0.92) − boostPool.
 * Unallocated boost flows back to the Time Pool.
 */
function computeBoostBudget(fundingLevel: number): number {
	if (fundingLevel < 3) return 0;
	return Math.ceil(fundingLevel * 0.5);
}

function computeTimePool(fundingLevel: number): number {
	if (fundingLevel < 3) return 0;
	const creatorShare = Number((fundingLevel * 0.92).toFixed(2));
	const boostPool = computeBoostBudget(fundingLevel);
	return Math.max(0, Number((creatorShare - boostPool).toFixed(2)));
}

function getCurrentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

async function getOptionalUserId(c: any): Promise<number | null> {
	const token = getCookie(c, "session");
	if (!token) return null;
	const result = await validateSession(token);
	return result?.user.id ?? null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const subscriptionRoutes = new Hono()
	// ── Tier List ─────────────────────────────────────────────────────────────
	.get("/tiers", (c) => c.json({ tiers: TIERS }))

	// ── Current Subscription ─────────────────────────────────────────────────
	.get("/me", requireAuth, async (c) => {
		const user = c.get("user");

		const [sub] = await db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.userId, user.id))
			.limit(1);

		if (!sub) {
			return c.json({
				subscription: {
					tier: "free",
					isActive: true,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					canceledAt: null,
				},
			});
		}

		return c.json({ subscription: sub });
	})

	// ── Subscribe / Change Tier ──────────────────────────────────────────────
	.post(
		"/subscribe",
		requireAuth,
		zValidator("json", z.object({ tier: z.enum(["root", "sprout", "petal", "bloom"]) })),
		async (c) => {
			const user = c.get("user");
			const { tier } = c.req.valid("json");

			// TODO: Create Stripe Checkout Session for new subscriptions
			// TODO: Update Stripe subscription for tier changes (proration)

			return c.json({
				checkoutUrl: "https://checkout.stripe.com/placeholder",
				message: "Stripe subscription checkout not yet implemented",
			});
		},
	)

	// ── Cancel Subscription ──────────────────────────────────────────────────
	.post("/cancel", requireAuth, async (c) => {
		const user = c.get("user");

		const [sub] = await db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.userId, user.id))
			.limit(1);

		if (!sub || sub.tier === "free") {
			return c.json({ error: "No active paid subscription" }, 400);
		}

		// TODO: Cancel at period end via Stripe
		await db
			.update(subscriptions)
			.set({ canceledAt: new Date() })
			.where(eq(subscriptions.id, sub.id));

		const [updated] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));

		return c.json({ subscription: updated });
	})

	// ── Resume Subscription ──────────────────────────────────────────────────
	.post("/resume", requireAuth, async (c) => {
		const user = c.get("user");

		const [sub] = await db
			.select()
			.from(subscriptions)
			.where(eq(subscriptions.userId, user.id))
			.limit(1);

		if (!sub?.canceledAt) {
			return c.json({ error: "No canceled subscription to resume" }, 400);
		}

		// TODO: Undo cancellation via Stripe
		await db.update(subscriptions).set({ canceledAt: null }).where(eq(subscriptions.id, sub.id));

		const [updated] = await db.select().from(subscriptions).where(eq(subscriptions.id, sub.id));

		return c.json({ subscription: updated });
	})

	// ── Billing Portal ───────────────────────────────────────────────────────
	.post("/billing-portal", requireAuth, async (c) => {
		// TODO: Create Stripe Billing Portal session
		return c.json({
			portalUrl: "https://billing.stripe.com/placeholder",
			message: "Stripe billing portal not yet implemented",
		});
	})

	// ── Attention Events ─────────────────────────────────────────────────────
	.post(
		"/attention",
		requireAuth,
		zValidator(
			"json",
			z.object({
				events: z
					.array(
						z.object({
							creatorId: z.number().int(),
							eventType: z.enum(["page_view", "play", "watch", "read", "listen"]),
							durationSeconds: z.number().int().min(0).max(300).default(0),
							postId: z.number().int().optional(),
						}),
					)
					.max(50),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { events } = c.req.valid("json");

			if (events.length === 0) {
				return c.json({ recorded: 0 });
			}

			const rows = events.map((e) => ({
				userId: user.id,
				creatorId: e.creatorId,
				eventType: e.eventType,
				durationSeconds: e.durationSeconds,
				postId: e.postId ?? null,
			}));

			await db.insert(attentionEvents).values(rows);

			return c.json({ recorded: rows.length });
		},
	)

	// ── Attention Summary ────────────────────────────────────────────────────
	.get("/attention/summary", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? getCurrentBillingCycle();

		// Compute cycle end (first day of next month)
		const cycleDate = new Date(`${cycle}T00:00:00`);
		const cycleEnd = new Date(cycleDate.getFullYear(), cycleDate.getMonth() + 1, 1);

		const [summary] = await db
			.select({
				totalSeconds: sql<number>`COALESCE(SUM(duration_seconds), 0)::float`,
				eventCount: sql<number>`COUNT(*)::int`,
			})
			.from(attentionEvents)
			.where(
				and(
					eq(attentionEvents.userId, user.id),
					gte(attentionEvents.createdAt, cycleDate),
					lte(attentionEvents.createdAt, cycleEnd),
				),
			);

		return c.json({
			hoursUsed: Number((Number(summary.totalSeconds) / 3600).toFixed(2)),
			eventCount: Number(summary.eventCount),
			cycleStart: cycle,
		});
	})

	// ── Pool Distributions (subscriber view) ─────────────────────────────────
	.get("/distributions", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? getCurrentBillingCycle();

		const result = await db
			.select({
				distribution: poolDistributions,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
				creatorAvatar: users.avatar,
			})
			.from(poolDistributions)
			.innerJoin(users, eq(poolDistributions.creatorId, users.id))
			.where(
				and(eq(poolDistributions.subscriberId, user.id), eq(poolDistributions.billingCycle, cycle)),
			)
			.orderBy(
				desc(
					sql`CAST(${poolDistributions.poolAmount} AS numeric) + CAST(${poolDistributions.boostAmount} AS numeric)`,
				),
			);

		return c.json({
			distributions: result.map((r) => ({
				...r.distribution,
				creator: {
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
					avatar: r.creatorAvatar,
				},
			})),
		});
	})

	// ── Creator Earnings ─────────────────────────────────────────────────────
	.get("/earnings", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? getCurrentBillingCycle();

		const [earnings] = await db
			.select({
				poolTotal: sql<string>`COALESCE(SUM(CAST(pool_amount AS numeric)), 0)`,
				boostTotal: sql<string>`COALESCE(SUM(CAST(boost_amount AS numeric)), 0)`,
				subscriberCount: sql<number>`COUNT(DISTINCT subscriber_id)::int`,
			})
			.from(poolDistributions)
			.where(
				and(eq(poolDistributions.creatorId, user.id), eq(poolDistributions.billingCycle, cycle)),
			);

		const total = (Number(earnings.poolTotal) + Number(earnings.boostTotal)).toFixed(2);

		return c.json({
			poolTotal: earnings.poolTotal,
			boostTotal: earnings.boostTotal,
			total,
			subscriberCount: Number(earnings.subscriberCount),
			cycle,
		});
	})

	// ── Boost Allocations ────────────────────────────────────────────────────
	.get("/boosts", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? getCurrentBillingCycle();

		const result = await db
			.select({
				boost: boostAllocations,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
			})
			.from(boostAllocations)
			.innerJoin(users, eq(boostAllocations.creatorId, users.id))
			.where(and(eq(boostAllocations.userId, user.id), eq(boostAllocations.billingCycle, cycle)));

		const [sub] = await db
			.select({ fundingLevel: subscriptions.fundingLevel })
			.from(subscriptions)
			.where(eq(subscriptions.userId, user.id))
			.limit(1);

		const fundingLevel = sub?.fundingLevel ?? 0;
		const budget = computeBoostBudget(fundingLevel);
		const allocated = result.reduce((sum, r) => sum + Number(r.boost.amount), 0);

		return c.json({
			boosts: result.map((r) => ({
				...r.boost,
				creator: {
					username: r.creatorUsername,
					displayName: r.creatorDisplayName,
				},
			})),
			budget: budget.toFixed(2),
			allocated: allocated.toFixed(2),
			remaining: (budget - allocated).toFixed(2),
		});
	})

	.post(
		"/boosts",
		requireAuth,
		zValidator(
			"json",
			z.object({
				creatorId: z.number().int(),
				amount: z.string().regex(/^\d+\.\d{2}$/, "Amount must be in X.XX format"),
				cycle: z
					.string()
					.regex(/^\d{4}-\d{2}-01$/)
					.optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { creatorId, amount, cycle: requestedCycle } = c.req.valid("json");
			const amountNum = Number(amount);
			const currentCycle = getCurrentBillingCycle();
			const cycle = requestedCycle ?? currentCycle;

			// Only allow editing current or next month
			const cycleDate = new Date(`${cycle}T00:00:00`);
			const currentDate = new Date(`${currentCycle}T00:00:00`);
			const nextMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
			const nextCycle = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

			if (cycle !== currentCycle && cycle !== nextCycle) {
				return c.json({ error: "Can only edit boosts for current or next billing cycle" }, 400);
			}

			const [sub] = await db
				.select({ fundingLevel: subscriptions.fundingLevel })
				.from(subscriptions)
				.where(eq(subscriptions.userId, user.id))
				.limit(1);

			const fundingLevel = sub?.fundingLevel ?? 0;
			const budget = computeBoostBudget(fundingLevel);

			if (budget === 0) {
				return c.json({ error: "Boost allocations require a funding level above $3" }, 400);
			}

			// Current month: can only increase, not decrease
			if (cycle === currentCycle) {
				const [existing] = await db
					.select({ amount: boostAllocations.amount })
					.from(boostAllocations)
					.where(
						and(
							eq(boostAllocations.userId, user.id),
							eq(boostAllocations.creatorId, creatorId),
							eq(boostAllocations.billingCycle, cycle),
						),
					)
					.limit(1);

				if (existing && amountNum < Number(existing.amount)) {
					return c.json({ error: "Cannot decrease boost in the current billing cycle" }, 400);
				}
			}

			// Check total allocated (excluding the creator being updated)
			const [currentAllocated] = await db
				.select({
					total: sql<string>`COALESCE(SUM(CAST(amount AS numeric)), 0)`,
				})
				.from(boostAllocations)
				.where(
					and(
						eq(boostAllocations.userId, user.id),
						eq(boostAllocations.billingCycle, cycle),
						sql`${boostAllocations.creatorId} != ${creatorId}`,
					),
				);

			const otherAllocated = Number(currentAllocated.total);
			if (otherAllocated + amountNum > budget) {
				return c.json({ error: "Exceeds boost budget" }, 400);
			}

			if (amountNum === 0) {
				// Remove allocation (only allowed for next month)
				if (cycle === currentCycle) {
					return c.json({ error: "Cannot remove boost in the current billing cycle" }, 400);
				}
				await db
					.delete(boostAllocations)
					.where(
						and(
							eq(boostAllocations.userId, user.id),
							eq(boostAllocations.creatorId, creatorId),
							eq(boostAllocations.billingCycle, cycle),
						),
					);
				return c.json({ success: true, removed: true });
			}

			// Upsert allocation
			await db
				.insert(boostAllocations)
				.values({
					userId: user.id,
					creatorId,
					amount,
					billingCycle: cycle,
				})
				.onConflictDoUpdate({
					target: [
						boostAllocations.userId,
						boostAllocations.creatorId,
						boostAllocations.billingCycle,
					],
					set: { amount, updatedAt: new Date() },
				});

			return c.json({ success: true });
		},
	)

	// ── Creator Gates ────────────────────────────────────────────────────────
	.get("/gates", async (c) => {
		const creatorUsername = c.req.query("creator");

		if (!creatorUsername) {
			// If no creator specified, require auth and return own gates
			const userId = await getOptionalUserId(c);
			if (!userId) return c.json({ error: "Unauthorized" }, 401);

			const gates = await db
				.select()
				.from(creatorGates)
				.where(eq(creatorGates.creatorId, userId))
				.orderBy(creatorGates.gateType, creatorGates.threshold);

			return c.json({ gates });
		}

		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, creatorUsername))
			.limit(1);
		if (!creator) return c.json({ error: "Creator not found" }, 404);

		const gates = await db
			.select()
			.from(creatorGates)
			.where(eq(creatorGates.creatorId, creator.id))
			.orderBy(creatorGates.gateType, creatorGates.threshold);

		return c.json({ gates });
	})

	.post(
		"/gates",
		requireAuth,
		zValidator(
			"json",
			z.object({
				threshold: z.string().regex(/^\d+\.\d{2}$/),
				label: z.string().min(1).max(100),
				description: z.string().max(1000).optional().default(""),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

			const [gate] = await db
				.insert(creatorGates)
				.values({ creatorId: user.id, ...data })
				.returning();

			return c.json({ gate }, 201);
		},
	)

	.patch(
		"/gates/:id",
		requireAuth,
		zValidator(
			"json",
			z.object({
				threshold: z
					.string()
					.regex(/^\d+\.\d{2}$/)
					.optional(),
				label: z.string().min(1).max(100).optional(),
				description: z.string().max(1000).optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { id } = c.req.param();
			const data = c.req.valid("json");

			const [updated] = await db
				.update(creatorGates)
				.set({ ...data, updatedAt: new Date() })
				.where(and(eq(creatorGates.id, Number(id)), eq(creatorGates.creatorId, user.id)))
				.returning();

			if (!updated) return c.json({ error: "Gate not found" }, 404);
			return c.json({ gate: updated });
		},
	)

	.delete("/gates/:id", requireAuth, async (c) => {
		const user = c.get("user");
		const { id } = c.req.param();

		const deleted = await db
			.delete(creatorGates)
			.where(and(eq(creatorGates.id, Number(id)), eq(creatorGates.creatorId, user.id)))
			.returning({ id: creatorGates.id });

		if (deleted.length === 0) return c.json({ error: "Gate not found" }, 404);
		return c.body(null, 204);
	})

	// ── Content Access Check ─────────────────────────────────────────────────
	// Access now lives on the post itself (price + entitlement columns); resolveAccess
	// is the single source of truth, shared with the content and payment routes.
	.get("/access/:postId", async (c) => {
		const { postId } = c.req.param();
		const currentUserId = await getOptionalUserId(c);

		const [post] = await db.select().from(posts).where(eq(posts.id, Number(postId))).limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const result = await resolveAccess(post, currentUserId);
		return c.json({
			access: result.canAccess,
			reason: result.reason,
			requiresPurchase: result.requiresPurchase,
			price: result.price,
			isEntitled: result.isEntitled,
			entitlementKind: result.entitlementKind,
			entitlementDiscountPct: result.entitlementDiscountPct,
		});
	})

	// ── Creator Status (for creator page tier/boost display) ────────────────
	.get("/creator-status/:username", async (c) => {
		const { username } = c.req.param();
		const currentUserId = await getOptionalUserId(c);

		// Look up the creator
		const [creator] = await db
			.select({ id: users.id })
			.from(users)
			.where(eq(users.username, username))
			.limit(1);
		if (!creator) return c.json({ error: "Creator not found" }, 404);

		// Get the creator's gates
		const gates = await db
			.select()
			.from(creatorGates)
			.where(eq(creatorGates.creatorId, creator.id))
			.orderBy(creatorGates.gateType, creatorGates.threshold);

		if (!currentUserId) {
			return c.json({
				anthersTier: "free",
				fundingLevel: 0,
				boostAmount: "0.00",
				gates,
				unlockedGates: [],
			});
		}

		// Get user's subscription
		const [sub] = await db
			.select({ tier: subscriptions.tier, fundingLevel: subscriptions.fundingLevel })
			.from(subscriptions)
			.where(eq(subscriptions.userId, currentUserId))
			.limit(1);

		const tier = sub?.tier ?? "free";
		const fundingLevel = sub?.fundingLevel ?? 0;

		// Get user's boost allocation to this creator
		const cycle = getCurrentBillingCycle();
		const [boost] = await db
			.select({ amount: boostAllocations.amount })
			.from(boostAllocations)
			.where(
				and(
					eq(boostAllocations.userId, currentUserId),
					eq(boostAllocations.creatorId, creator.id),
					eq(boostAllocations.billingCycle, cycle),
				),
			)
			.limit(1);

		const boostAmount = boost?.amount ?? "0.00";

		// Determine which gates are unlocked
		const unlockedGates = gates
			.filter((g) => {
				if (g.gateType === "anthers_tier") {
					return fundingLevel >= Number(g.threshold);
				}
				return Number(boostAmount) >= Number(g.threshold);
			})
			.map((g) => g.id);

		return c.json({
			anthersTier: tier,
			fundingLevel,
			boostAmount,
			gates,
			unlockedGates,
		});
	})

	// ── Subscription Webhook ─────────────────────────────────────────────────
	.post("/webhook", async (c) => {
		// TODO: Verify Stripe webhook signature
		// TODO: Handle customer.subscription.created/updated/deleted
		// TODO: Handle invoice.payment_succeeded/failed
		// TODO: Handle checkout.session.completed

		return c.json({ received: true });
	});

export { subscriptionRoutes };
