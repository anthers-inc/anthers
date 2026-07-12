// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account & economics routes — V3.
 *
 * Users don't subscribe to a tier. They hold an account and make two prepaid,
 * per-cycle choices: a **Usage** level (GiB) and a total **Boost** ($). Their
 * **Anthers Badge** is derived from combined spend across the trailing cycles.
 * This file also serves time (attention) tracking, pool distributions, boost
 * allocation, the re-download wallet, creator gates, and content access.
 *
 * Note: Stripe payment movement is stubbed with TODO markers — the endpoints set
 * levels/balances directly until Stripe is wired.
 */

import { db } from "@anthers/db/client";
import {
	accountCycles,
	accounts,
	attentionEvents,
	boostAllocations,
	creatorGates,
	poolDistributions,
	posts,
	redownloadLedger,
	users,
} from "@anthers/db/schema";
import { BADGE_THRESHOLDS, badgeForSpend, USAGE_PER_GIB } from "@anthers/shared/constants";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { resolveAccess, rollingBadgeSpend } from "../services/access.js";
import { validateSession } from "../services/auth.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** The rolling Anthers Badges and the combined-spend threshold each requires. */
const BADGES = [
	{ id: "root", name: "Root", threshold: BADGE_THRESHOLDS.root },
	{ id: "sprout", name: "Sprout", threshold: BADGE_THRESHOLDS.sprout },
	{ id: "petal", name: "Petal", threshold: BADGE_THRESHOLDS.petal },
	{ id: "blossom", name: "Blossom", threshold: BADGE_THRESHOLDS.blossom },
] as const;

/** Minimum re-download top-up — a few dollars so the card fee isn't outsized. */
const MIN_REDOWNLOAD_TOPUP = 2;

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

/** Record this cycle's prepaid levels + derived spend (the Badge ledger). */
async function upsertAccountCycle(
	userId: number,
	cycle: string,
	usageGiB: number,
	boostTotal: number,
) {
	const usageSpend = money(usageGiB * USAGE_PER_GIB);
	const boostSpend = money(boostTotal);
	const totalSpend = money(usageGiB * USAGE_PER_GIB + boostTotal);
	await db
		.insert(accountCycles)
		.values({
			userId,
			billingCycle: cycle,
			usageGiB,
			boostTotal: boostSpend,
			usageSpend,
			boostSpend,
			totalSpend,
		})
		.onConflictDoUpdate({
			target: [accountCycles.userId, accountCycles.billingCycle],
			set: {
				usageGiB,
				boostTotal: boostSpend,
				usageSpend,
				boostSpend,
				totalSpend,
				updatedAt: new Date(),
			},
		});
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
	// ── Badge List ────────────────────────────────────────────────────────────
	.get("/badges", (c) => c.json({ badges: BADGES }))

	// ── Current Account ──────────────────────────────────────────────────────
	.get("/me", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		const badgeSpend = await rollingBadgeSpend(user.id);

		if (!acct) {
			return c.json({
				account: {
					usageGiB: 0,
					boostTotal: "0.00",
					redownloadBalance: "0.00",
					isSelfHosting: false,
					isActive: true,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					canceledAt: null,
				},
				badge: badgeForSpend(badgeSpend),
				badgeSpend,
			});
		}

		return c.json({ account: acct, badge: badgeForSpend(badgeSpend), badgeSpend });
	})

	// ── Set Prepaid Levels (Usage + total Boost) ─────────────────────────────
	.post(
		"/account",
		requireAuth,
		requireVerified,
		zValidator(
			"json",
			z.object({
				usageGiB: z.number().int().min(0).optional(),
				boostTotal: z.number().min(0).optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { usageGiB, boostTotal } = c.req.valid("json");
			const cycle = getCurrentBillingCycle();

			// TODO: Charge the prepaid amount (usage + boost delta) via Stripe before applying.
			const existing = await getAccount(user.id);
			const { start, end } = currentPeriod();
			const nextUsage = usageGiB ?? existing?.usageGiB ?? 0;
			const nextBoost = boostTotal ?? Number(existing?.boostTotal ?? 0);

			if (existing) {
				await db
					.update(accounts)
					.set({
						usageGiB: nextUsage,
						boostTotal: money(nextBoost),
						isActive: true,
						canceledAt: null,
						currentPeriodStart: existing.currentPeriodStart ?? start,
						currentPeriodEnd: existing.currentPeriodEnd ?? end,
						updatedAt: new Date(),
					})
					.where(eq(accounts.id, existing.id));
			} else {
				await db.insert(accounts).values({
					userId: user.id,
					usageGiB: nextUsage,
					boostTotal: money(nextBoost),
					currentPeriodStart: start,
					currentPeriodEnd: end,
				});
			}

			await upsertAccountCycle(user.id, cycle, nextUsage, nextBoost);
			const badgeSpend = await rollingBadgeSpend(user.id);
			const acct = await getAccount(user.id);
			return c.json({ account: acct, badge: badgeForSpend(badgeSpend), badgeSpend });
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

	// ── Cancel Account (stop prepaid renewal) ────────────────────────────────
	.post("/cancel", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct || (acct.usageGiB === 0 && Number(acct.boostTotal) === 0)) {
			return c.json({ error: "No active spend to cancel" }, 400);
		}
		// TODO: Cancel any Stripe renewal at period end.
		await db.update(accounts).set({ canceledAt: new Date() }).where(eq(accounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Resume Account ───────────────────────────────────────────────────────
	.post("/resume", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct?.canceledAt) {
			return c.json({ error: "No canceled account to resume" }, 400);
		}
		// TODO: Undo cancellation via Stripe.
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

	// ── Re-download Balance ──────────────────────────────────────────────────
	.get("/redownload/balance", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		return c.json({ balance: acct?.redownloadBalance ?? "0.00" });
	})

	.post(
		"/redownload/topup",
		requireAuth,
		requireVerified,
		zValidator("json", z.object({ amount: z.number().min(MIN_REDOWNLOAD_TOPUP) })),
		async (c) => {
			const user = c.get("user");
			const { amount } = c.req.valid("json");
			// TODO: Charge the top-up via Stripe (min a few dollars so the card fee isn't outsized).
			const acct = await ensureAccount(user.id);
			const next = money(Number(acct.redownloadBalance ?? 0) + amount);
			await db
				.update(accounts)
				.set({ redownloadBalance: next, updatedAt: new Date() })
				.where(eq(accounts.id, acct.id));
			await db
				.insert(redownloadLedger)
				.values({ userId: user.id, delta: money(amount), reason: "topup" });
			return c.json({ balance: next });
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
	// Budget is the total Boost the user has bought this cycle; 100% goes to creators.
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

		const acct = await getAccount(user.id);
		const budget = Number(acct?.boostTotal ?? 0);
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
			const cycleDate = new Date(`${cycle}T00:00:00`);
			const currentDate = new Date(`${currentCycle}T00:00:00`);
			const nextMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1);
			const nextCycle = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, "0")}-01`;

			if (cycle !== currentCycle && cycle !== nextCycle) {
				return c.json({ error: "Can only edit boosts for current or next billing cycle" }, 400);
			}

			const acct = await getAccount(user.id);
			const budget = Number(acct?.boostTotal ?? 0);

			if (budget <= 0) {
				return c.json({ error: "Buy some Boost before allocating it to creators" }, 400);
			}

			// Current month: allocation locks — can only increase a creator, not decrease.
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

			// Check total allocated (excluding the creator being updated) against the budget.
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
				return c.json({ error: "Exceeds the Boost you've bought this cycle" }, 400);
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
				threshold: z.string().regex(/^\d+(\.\d{1,2})?$/),
				label: z.string().min(1).max(100),
				description: z.string().max(1000).optional().default(""),
				gateType: z.enum(["boost", "anthers_badge"]).optional().default("boost"),
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

	// ── Creator Status (for creator page Badge/boost display) ───────────────
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
				badge: "none",
				badgeSpend: 0,
				boostAmount: "0.00",
				gates,
				unlockedGates: [],
			});
		}

		// The viewer's rolling Badge and their boost to this creator this cycle.
		const badgeSpend = await rollingBadgeSpend(currentUserId);
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

		// Determine which gates are unlocked: Anthers Gate by Badge spend, Boost Gate by boost.
		const unlockedGates = gates
			.filter((g) => {
				if (g.gateType === "anthers_badge") {
					return badgeSpend >= Number(g.threshold);
				}
				return Number(boostAmount) >= Number(g.threshold);
			})
			.map((g) => g.id);

		return c.json({
			badge: badgeForSpend(badgeSpend),
			badgeSpend,
			boostAmount,
			gates,
			unlockedGates,
		});
	})

	// ── Payment Webhook ──────────────────────────────────────────────────────
	.post("/webhook", async (c) => {
		// TODO: Verify Stripe webhook signature
		// TODO: Handle checkout.session.completed for usage/boost/re-download top-ups
		// TODO: Handle payment_intent.succeeded/failed

		return c.json({ received: true });
	});

export { subscriptionRoutes };
