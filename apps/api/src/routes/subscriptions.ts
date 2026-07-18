// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account & economics routes — V4 (the "Big Rethink" badge-plan model).
 *
 * A user holds an account and *chooses* a Badge plan (free/root/sprout/petal/
 * blossom). The plan's price decomposes into Time Pool + Seeds + Community Share.
 * Bandwidth is a separate at-cost wallet with a per-tier free monthly allowance.
 * This file also serves time (attention) tracking, pool distributions, Seed
 * allocation, the bandwidth wallet, creator gates, and content access.
 *
 * Note: Stripe payment movement is stubbed with TODO markers — the endpoints set
 * plans/balances directly until Stripe is wired.
 */

import { db } from "@anthers/db/client";
import {
	accounts,
	attentionEvents,
	creatorGates,
	poolDistributions,
	posts,
	seedAllocations,
	users,
} from "@anthers/db/schema";
import { BADGE_PLANS, type Badge, badgeRank, SEED_PRICE } from "@anthers/shared/constants";
import { badgePlanViews } from "@anthers/shared/fees";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type Stripe from "stripe";
import { z } from "zod";
import { stripe } from "../lib/stripe.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { heldBadge, resolveAccess } from "../services/access.js";
import { validateSession } from "../services/auth.js";
import {
	createOneTimeCharge,
	ensureStripeCustomer,
	priceIdForBadge,
	savedCardFor,
} from "../services/billing.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BADGE_IDS = ["free", "root", "sprout", "petal", "blossom"] as const;

/** The Badge plans, each with its price decomposition + what's included. Shared
 *  with the Subscribe page via `badgePlanViews()` so the two never drift. */
const PLANS = badgePlanViews();

/** Minimum wallet top-up — a few dollars so the card fee isn't outsized. */
const MIN_WALLET_TOPUP = 2;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCurrentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function currentPeriod() {
	const now = new Date();
	return {
		start: new Date(now.getFullYear(), now.getMonth(), 1),
		end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
	};
}

function money(n: number): string {
	return (Math.round(n * 100) / 100).toFixed(2);
}

async function getAccount(userId: number) {
	const [acct] = await db.select().from(accounts).where(eq(accounts.userId, userId)).limit(1);
	return acct ?? null;
}

/** Ensure an account row exists; returns it. */
async function ensureAccount(userId: number) {
	const existing = await getAccount(userId);
	if (existing) return existing;
	const { start, end } = currentPeriod();
	const [created] = await db
		.insert(accounts)
		.values({ userId, currentPeriodStart: start, currentPeriodEnd: end })
		.returning();
	return created;
}

async function getOptionalUserId(c: any): Promise<number | null> {
	const token = getCookie(c, "session");
	if (!token) return null;
	const result = await validateSession(token);
	return result?.user.id ?? null;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const subscriptionRoutes = new Hono()
	// ── Badge Plans ─────────────────────────────────────────────────────────────
	.get("/badges", (c) => c.json({ badges: PLANS }))

	// ── Current Account ──────────────────────────────────────────────────────
	.get("/me", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		const badge: Badge = (acct?.badge as Badge) ?? "free";

		if (!acct) {
			return c.json({
				account: {
					badge: "free",
					walletBalance: "0.00",
					bandwidthUsedGiB: "0",
					seedTotal: "0.00",
					autoTopupEnabled: false,
					isSelfHosting: false,
					isActive: true,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					canceledAt: null,
				},
				badge: "free",
				plan: PLANS[0],
			});
		}

		return c.json({ account: acct, badge, plan: PLANS[badgeRank(badge)] });
	})

	// ── Preview a plan choice (no charge) — powers the confirmation modal ──────
	.get("/preview/:badge", requireAuth, async (c) => {
		const user = c.get("user");
		const badgeParam = c.req.param("badge");
		if (!BADGE_IDS.includes(badgeParam as (typeof BADGE_IDS)[number])) {
			return c.json({ error: "Invalid plan" }, 400);
		}
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		const acct = await ensureAccount(user.id);

		// Cancel preview (→ Free): what you keep, and until when.
		if (badgeParam === "free") {
			if (!acct.stripeSubscriptionId || acct.badge === "free") {
				return c.json({ error: "No paid plan to cancel" }, 400);
			}
			const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId).catch(() => null);
			return c.json({
				isCancel: true,
				badge: "free",
				currentPlanName: PLANS[badgeRank(acct.badge as Badge)].name,
				nextBillingUnix: sub?.items.data[0]?.current_period_end ?? null,
			});
		}

		const badge = badgeParam as Badge;
		const price = BADGE_PLANS[badge].price;
		const recurring = { amount: price.toFixed(2), interval: "month" as const };

		// The card on file — attached to the customer when a subscription's first
		// payment is confirmed (save_default_payment_method).
		let savedCard: { id: string; brand: string; last4: string } | null = null;
		if (acct.stripeCustomerId) {
			const pms = await stripe.paymentMethods.list({
				customer: acct.stripeCustomerId,
				type: "card",
				limit: 1,
			});
			const pm = pms.data[0];
			if (pm?.card) savedCard = { id: pm.id, brand: pm.card.brand, last4: pm.card.last4 };
		}

		// A change to an active subscription → ask Stripe for the exact proration owed now.
		let isChange = false;
		let chargeNow = price.toFixed(2);
		let nextBillingUnix: number | null = null;
		if (acct.stripeSubscriptionId) {
			const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId).catch(() => null);
			if (sub && (sub.status === "active" || sub.status === "trialing")) {
				isChange = true;
				const priceId = priceIdForBadge(badge);
				if (priceId) {
					const preview = await stripe.invoices.createPreview({
						customer: acct.stripeCustomerId ?? undefined,
						subscription: sub.id,
						subscription_details: {
							items: [{ id: sub.items.data[0].id, price: priceId }],
							proration_behavior: "always_invoice",
						},
					});
					chargeNow = Math.max(0, preview.amount_due / 100).toFixed(2);
					nextBillingUnix = sub.items.data[0]?.current_period_end ?? null;
				}
			}
		}
		if (!isChange) {
			// New subscription: charged now, then again in a month.
			const next = new Date();
			next.setMonth(next.getMonth() + 1);
			nextBillingUnix = Math.floor(next.getTime() / 1000);
		}

		return c.json({
			isCancel: false,
			badge,
			isChange,
			recurring,
			chargeNow,
			nextBillingUnix,
			savedCard,
		});
	})

	// ── Subscribe to a Badge plan ────────────────────────────────────────────
	.post(
		"/account",
		requireAuth,
		requireVerified,
		zValidator("json", z.object({ badge: z.enum(BADGE_IDS) })),
		async (c) => {
			const user = c.get("user");
			const { badge } = c.req.valid("json");
			if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

			const acct = await ensureAccount(user.id);

			// Downgrade to Free → cancel the subscription at period end (webhook reverts).
			if (badge === "free") {
				if (acct.stripeSubscriptionId) {
					await stripe.subscriptions.update(acct.stripeSubscriptionId, {
						cancel_at_period_end: true,
					});
					await db
						.update(accounts)
						.set({ canceledAt: new Date(), updatedAt: new Date() })
						.where(eq(accounts.id, acct.id));
				}
				return c.json({ pending: false, account: await getAccount(user.id) });
			}

			const priceId = priceIdForBadge(badge);
			if (!priceId) return c.json({ error: `No Stripe price configured for ${badge}` }, 500);
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");

			// Changing plans on an active subscription → swap the price with proration; the
			// saved card is charged for the difference and the webhook syncs the new badge.
			if (acct.stripeSubscriptionId) {
				const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId);
				if (sub.status === "active" || sub.status === "trialing") {
					await stripe.subscriptions.update(sub.id, {
						items: [{ id: sub.items.data[0].id, price: priceId }],
						proration_behavior: "always_invoice",
						cancel_at_period_end: false,
					});
					return c.json({ pending: false, account: await getAccount(user.id) });
				}
			}

			// New subscription → create it incomplete and hand back the confirmation secret so
			// the user confirms the first payment inline; the webhook applies the badge on success.
			const sub = await stripe.subscriptions.create({
				customer: customerId,
				items: [{ price: priceId }],
				payment_behavior: "default_incomplete",
				payment_settings: { save_default_payment_method: "on_subscription" },
				expand: ["latest_invoice.confirmation_secret"],
				metadata: { userId: String(user.id), badge },
			});
			await db
				.update(accounts)
				.set({ stripeSubscriptionId: sub.id, updatedAt: new Date() })
				.where(eq(accounts.id, acct.id));

			const invoice = sub.latest_invoice as
				| (Stripe.Invoice & { confirmation_secret?: { client_secret?: string } })
				| null;
			return c.json({
				pending: true,
				subscriptionId: sub.id,
				clientSecret: invoice?.confirmation_secret?.client_secret ?? null,
			});
		},
	)

	// ── Buy additional Seeds (on top of the plan's included Seeds) ────────────
	.post(
		"/seeds/buy",
		requireAuth,
		requireVerified,
		zValidator("json", z.object({ quantity: z.number().int().min(1).max(1000) })),
		async (c) => {
			const user = c.get("user");
			const { quantity } = c.req.valid("json");
			if (!stripe) return c.json({ error: "Payments are not configured." }, 503);
			await ensureAccount(user.id);
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");
			// Charge quantity × $1 (+ card processing) via Stripe; the webhook credits on success.
			const charge = await createOneTimeCharge({
				userId: user.id,
				customerId,
				type: "seeds",
				base: quantity * SEED_PRICE,
			});
			return c.json({ ...charge, savedCard: await savedCardFor(customerId) });
		},
	)

	// ── Self-Hosting Toggle (creators) ───────────────────────────────────────
	.post(
		"/self-hosting",
		requireAuth,
		zValidator("json", z.object({ enabled: z.boolean() })),
		async (c) => {
			const user = c.get("user");
			const { enabled } = c.req.valid("json");
			await ensureAccount(user.id);
			await db
				.update(accounts)
				.set({ isSelfHosting: enabled, updatedAt: new Date() })
				.where(eq(accounts.userId, user.id));
			return c.json({ isSelfHosting: enabled });
		},
	)

	// ── Cancel plan (revert to Free at period end) ───────────────────────────
	.post("/cancel", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct || acct.badge === "free") {
			return c.json({ error: "No paid plan to cancel" }, 400);
		}
		// Cancel at period end — the plan keeps working until the cycle ends, then the
		// subscription.deleted webhook reverts to Free.
		if (stripe && acct.stripeSubscriptionId) {
			await stripe.subscriptions.update(acct.stripeSubscriptionId, { cancel_at_period_end: true });
		}
		await db.update(accounts).set({ canceledAt: new Date() }).where(eq(accounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Resume plan ──────────────────────────────────────────────────────────
	.post("/resume", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct?.canceledAt) {
			return c.json({ error: "No canceled plan to resume" }, 400);
		}
		if (stripe && acct.stripeSubscriptionId) {
			await stripe.subscriptions.update(acct.stripeSubscriptionId, { cancel_at_period_end: false });
		}
		await db.update(accounts).set({ canceledAt: null }).where(eq(accounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Billing Portal ───────────────────────────────────────────────────────
	.post("/billing-portal", requireAuth, async (c) => {
		// TODO: Create Stripe Billing Portal session
		return c.json({
			portalUrl: "https://billing.stripe.com/placeholder",
			message: "Stripe billing portal not yet implemented",
		});
	})

	// ── Bandwidth wallet ─────────────────────────────────────────────────────
	.get("/wallet/balance", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		const badge: Badge = (acct?.badge as Badge) ?? "free";
		return c.json({
			balance: acct?.walletBalance ?? "0.00",
			freeAllowanceGiB: BADGE_PLANS[badge].freeBwGiB,
			usedGiB: acct?.bandwidthUsedGiB ?? "0",
			autoTopupEnabled: acct?.autoTopupEnabled ?? false,
			autoTopupAmount: acct?.autoTopupAmount ?? "5.00",
			autoTopupThreshold: acct?.autoTopupThreshold ?? "2.00",
		});
	})

	.post(
		"/wallet/topup",
		requireAuth,
		requireVerified,
		zValidator("json", z.object({ amount: z.number().min(MIN_WALLET_TOPUP) })),
		async (c) => {
			const user = c.get("user");
			const { amount } = c.req.valid("json");
			if (!stripe) return c.json({ error: "Payments are not configured." }, 503);
			await ensureAccount(user.id);
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");
			// Charge the top-up (+ card processing) via Stripe; the webhook credits on success.
			const charge = await createOneTimeCharge({
				userId: user.id,
				customerId,
				type: "wallet",
				base: amount,
			});
			return c.json({ ...charge, savedCard: await savedCardFor(customerId) });
		},
	)

	.post(
		"/wallet/auto-topup",
		requireAuth,
		zValidator(
			"json",
			z.object({
				enabled: z.boolean(),
				amount: z.number().min(MIN_WALLET_TOPUP).optional(),
				threshold: z.number().min(0).optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { enabled, amount, threshold } = c.req.valid("json");
			const acct = await ensureAccount(user.id);
			await db
				.update(accounts)
				.set({
					autoTopupEnabled: enabled,
					...(amount != null ? { autoTopupAmount: money(amount) } : {}),
					...(threshold != null ? { autoTopupThreshold: money(threshold) } : {}),
					updatedAt: new Date(),
				})
				.where(eq(accounts.id, acct.id));
			const updated = await getAccount(user.id);
			return c.json({
				autoTopupEnabled: updated?.autoTopupEnabled ?? false,
				autoTopupAmount: updated?.autoTopupAmount ?? "5.00",
				autoTopupThreshold: updated?.autoTopupThreshold ?? "2.00",
			});
		},
	)

	// ── Time (Attention) Events ──────────────────────────────────────────────
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

	// ── Time Summary ─────────────────────────────────────────────────────────
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
					sql`CAST(${poolDistributions.poolAmount} AS numeric) + CAST(${poolDistributions.seedAmount} AS numeric)`,
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
				seedTotal: sql<string>`COALESCE(SUM(CAST(seed_amount AS numeric)), 0)`,
				subscriberCount: sql<number>`COUNT(DISTINCT subscriber_id)::int`,
			})
			.from(poolDistributions)
			.where(
				and(eq(poolDistributions.creatorId, user.id), eq(poolDistributions.billingCycle, cycle)),
			);

		const total = (Number(earnings.poolTotal) + Number(earnings.seedTotal)).toFixed(2);

		return c.json({
			poolTotal: earnings.poolTotal,
			seedTotal: earnings.seedTotal,
			total,
			subscriberCount: Number(earnings.subscriberCount),
			cycle,
		});
	})

	// ── Seed Allocations ─────────────────────────────────────────────────────
	// Budget is the total Seeds the user holds this cycle (included + purchased);
	// 100% goes to creators. Included Seeds must be directed here — nothing flows
	// automatically; undirected Seeds are settled to the subsidy pool at cycle end.
	.get("/seeds", requireAuth, async (c) => {
		const user = c.get("user");
		const cycle = c.req.query("cycle") ?? getCurrentBillingCycle();

		const result = await db
			.select({
				seed: seedAllocations,
				creatorUsername: users.username,
				creatorDisplayName: users.displayName,
			})
			.from(seedAllocations)
			.innerJoin(users, eq(seedAllocations.creatorId, users.id))
			.where(and(eq(seedAllocations.userId, user.id), eq(seedAllocations.billingCycle, cycle)));

		const acct = await getAccount(user.id);
		const budget = Number(acct?.seedTotal ?? 0);
		const allocated = result.reduce((sum, r) => sum + Number(r.seed.amount), 0);

		return c.json({
			seeds: result.map((r) => ({
				...r.seed,
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
		"/seeds",
		requireAuth,
		requireVerified,
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
			const currentDate = new Date(`${currentCycle}T00:00:00`);
			const nextMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
			const nextCycle = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

			if (cycle !== currentCycle && cycle !== nextCycle) {
				return c.json(
					{ error: "Can only direct Seeds for the current or next billing cycle" },
					400,
				);
			}

			const acct = await getAccount(user.id);
			const budget = Number(acct?.seedTotal ?? 0);

			if (budget <= 0) {
				return c.json({ error: "You have no Seeds to give this cycle" }, 400);
			}

			// Current month: allocation locks — can only increase a creator, not decrease.
			if (cycle === currentCycle) {
				const [existing] = await db
					.select({ amount: seedAllocations.amount })
					.from(seedAllocations)
					.where(
						and(
							eq(seedAllocations.userId, user.id),
							eq(seedAllocations.creatorId, creatorId),
							eq(seedAllocations.billingCycle, cycle),
						),
					)
					.limit(1);

				if (existing && amountNum < Number(existing.amount)) {
					return c.json({ error: "Cannot reduce Seeds given in the current billing cycle" }, 400);
				}
			}

			// Check total allocated (excluding the creator being updated) against the budget.
			const [currentAllocated] = await db
				.select({
					total: sql<string>`COALESCE(SUM(CAST(amount AS numeric)), 0)`,
				})
				.from(seedAllocations)
				.where(
					and(
						eq(seedAllocations.userId, user.id),
						eq(seedAllocations.billingCycle, cycle),
						sql`${seedAllocations.creatorId} != ${creatorId}`,
					),
				);

			const otherAllocated = Number(currentAllocated.total);
			if (otherAllocated + amountNum > budget) {
				return c.json({ error: "Exceeds the Seeds you hold this cycle" }, 400);
			}

			if (amountNum === 0) {
				// Remove allocation (only allowed for next month)
				if (cycle === currentCycle) {
					return c.json({ error: "Cannot remove Seeds in the current billing cycle" }, 400);
				}
				await db
					.delete(seedAllocations)
					.where(
						and(
							eq(seedAllocations.userId, user.id),
							eq(seedAllocations.creatorId, creatorId),
							eq(seedAllocations.billingCycle, cycle),
						),
					);
				return c.json({ success: true, removed: true });
			}

			// Upsert allocation
			await db
				.insert(seedAllocations)
				.values({
					userId: user.id,
					creatorId,
					amount,
					billingCycle: cycle,
				})
				.onConflictDoUpdate({
					target: [seedAllocations.userId, seedAllocations.creatorId, seedAllocations.billingCycle],
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
				.orderBy(creatorGates.sortOrder, creatorGates.threshold);

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
				// seed gate: dollars of Seeds. anthers_badge gate: badge rank (1=root … 4=blossom).
				threshold: z.string().regex(/^\d+(\.\d{1,2})?$/),
				label: z.string().min(1).max(100),
				description: z.string().max(1000).optional().default(""),
				gateType: z.enum(["seed", "anthers_badge"]).optional().default("seed"),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const data = c.req.valid("json");

			const [maxRow] = await db
				.select({ max: sql<number>`COALESCE(MAX(sort_order), -1)` })
				.from(creatorGates)
				.where(eq(creatorGates.creatorId, user.id));

			const [gate] = await db
				.insert(creatorGates)
				.values({ creatorId: user.id, ...data, sortOrder: Number(maxRow.max) + 1 })
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
					.regex(/^\d+(\.\d{1,2})?$/)
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
	// Access lives on the post itself (the two access tables); resolveAccess is the
	// single source of truth, shared with the content and payment routes.
	.get("/access/:postId", async (c) => {
		const { postId } = c.req.param();
		const currentUserId = await getOptionalUserId(c);

		const [post] = await db
			.select()
			.from(posts)
			.where(eq(posts.id, Number(postId)))
			.limit(1);
		if (!post) return c.json({ error: "Post not found" }, 404);

		const result = await resolveAccess(post, currentUserId);
		return c.json({
			access: result.canAccess,
			reason: result.reason,
			requiresPurchase: result.requiresPurchase,
			price: result.price,
			isEntitled: result.isEntitled,
			isFree: result.isFree,
			streamEnabled: result.streamEnabled,
			downloadEnabled: result.downloadEnabled,
		});
	})

	// ── Creator Status (for creator page Badge/Seed display) ────────────────
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
				badge: "free",
				seedAmount: "0.00",
				gates,
				unlockedGates: [],
			});
		}

		// The viewer's held Badge (point-in-time) and their Seeds to this creator this cycle.
		const badge = await heldBadge(currentUserId);
		const cycle = getCurrentBillingCycle();
		const [seed] = await db
			.select({ amount: seedAllocations.amount })
			.from(seedAllocations)
			.where(
				and(
					eq(seedAllocations.userId, currentUserId),
					eq(seedAllocations.creatorId, creator.id),
					eq(seedAllocations.billingCycle, cycle),
				),
			)
			.limit(1);

		const seedAmount = seed?.amount ?? "0.00";

		// Anthers Gate unlocks when the held badge rank clears the gate's rank; Seed Gate by Seeds given.
		const unlockedGates = gates
			.filter((g) => {
				if (g.gateType === "anthers_badge") {
					return badgeRank(badge) >= Number(g.threshold);
				}
				return Number(seedAmount) >= Number(g.threshold);
			})
			.map((g) => g.id);

		return c.json({
			badge,
			seedAmount,
			gates,
			unlockedGates,
		});
	})

	// ── Payment Webhook ──────────────────────────────────────────────────────
	.post("/webhook", async (c) => {
		// TODO: Verify Stripe webhook signature
		// TODO: Handle checkout.session.completed for plan subscription / Seed / wallet top-ups
		// TODO: Handle payment_intent.succeeded/failed

		return c.json({ received: true });
	});

export { subscriptionRoutes };
