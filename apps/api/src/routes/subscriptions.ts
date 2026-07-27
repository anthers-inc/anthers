// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account & economics routes — the support model.
 *
 * A user's account holds a count of **Anthers-Seeds** (`anthersSeeds`) — that
 * count is their rank and, at $3 each, their Anthers subscription (a single $3
 * Seed price × quantity in Stripe). Directed creator-Seeds are tracked in
 * `seed_allocations`; `creatorSeedTotal` is the balance the user directs.
 * Bandwidth is folded into the Anthers-Seeds — there is no wallet. This file also
 * serves time (attention) tracking, pool distributions, creator gates, and access.
 */

import { db } from "@anthers/db/client";
import {
	accounts,
	attentionEvents,
	contentItems,
	creatorGates,
	poolDistributions,
	postContents,
	posts,
	seedAllocations,
	users,
} from "@anthers/db/schema";
import {
	type AttentionEventType,
	CREDIT_WINDOW_SECONDS,
	clampToWindow,
	eventTypeFor,
	isTimePoolEligible,
} from "@anthers/shared/attention";
import { badgeRank, rankForSeeds, SEED_PRICE, seedsMeet } from "@anthers/shared/constants";
import { rankViews } from "@anthers/shared/fees";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type Stripe from "stripe";
import { z } from "zod";
import { stripe } from "../lib/stripe.js";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import {
	type AccessiblePost,
	buildAccessContext,
	heldAnthersSeeds,
	resolveAccess,
	resolveAccessSync,
	seedsFromDollars,
} from "../services/access.js";
import { validateSession } from "../services/auth.js";
import {
	createOneTimeCharge,
	ensureStripeCustomer,
	savedCardFor,
	seedPriceId,
} from "../services/billing.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Max Anthers-Seeds a single subscription can hold (a sane upper bound; Blossom+ well within). */
/**
 * Operational ceiling on a single subscription-quantity update — a fat-finger and abuse
 * guard, NOT a model bound.
 *
 * `services/billing.ts` describes rank as "unbounded, so Blossom+ works", and both are
 * true: the Badge ladder genuinely has no top rung (benefits keep scaling per Seed), while
 * this caps what one request may set. The two read as contradictory, which is why it was
 * filed as drift; the resolution is that "unbounded" is about the ladder and this is about
 * a request. Note `/seeds/buy` caps quantity at 1000 rather than 100 — a different bound
 * for a different path, left alone here, but worth one number if they should agree.
 */
const MAX_ANTHERS_SEEDS = 100;

/** The rank ladder (free … blossom), each with its Seed count + decomposition. Shared
 *  with the Subscribe page via `rankViews()` so the two never drift. */
const PLANS = rankViews();

/** The plan view for an Anthers-Seed count (rank-capped at blossom for display). */
function planFor(anthersSeeds: number) {
	// Look the rung up by its Badge, never by array position. `badgeRank` returns a
	// THRESHOLD, and a threshold only doubles as an index while Anthers's Badges sit at
	// 1/2/3/4; the moment they don't, indexing returns the wrong rung or undefined.
	const held = rankForSeeds(anthersSeeds);
	return PLANS.find((p) => p.id === held) ?? PLANS[0];
}

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

// ── Attention eligibility (server side) ──────────────────────────────────────

/**
 * What a post can legitimately be credited for, resolved from the database rather
 * than taken on the client's word.
 *
 * `packages/shared/src/attention.ts` owns the *policy* — which content types earn,
 * and under what evidence — and the browser applies it honestly. But a claim is an
 * HTTP request, and `distribute-pool` turns `attention_events.duration_seconds`
 * straight into money, so the policy has to be re-decided here against the real
 * post. The wall-clock clamp downstream bounds *volume*; it has nothing to say
 * about *attribution*, and a hand-written request could otherwise credit `read`
 * seconds against a body-only announcement, or against a creator who had nothing
 * to do with the post.
 */
interface PostEligibility {
	creatorId: number;
	/** Event types the post's own content elements can earn — empty means it earns nothing. */
	earns: Set<AttentionEventType>;
	/** Whether the claiming viewer may actually consume it. */
	accessible: boolean;
}

async function loadPostEligibility(
	postIds: number[],
	viewerId: number,
): Promise<Map<number, PostEligibility>> {
	const byId = new Map<number, PostEligibility>();
	if (postIds.length === 0) return byId;

	const postRows = await db.select().from(posts).where(inArray(posts.id, postIds));
	if (postRows.length === 0) return byId;

	// Content elements, with the referenced library item's type where there is one.
	// `kind = "text"` is a post-native element and has no item — it earns as "text".
	const entries = await db
		.select({ postId: postContents.postId, kind: postContents.kind, type: contentItems.type })
		.from(postContents)
		.leftJoin(contentItems, eq(postContents.contentItemId, contentItems.id))
		.where(
			inArray(
				postContents.postId,
				postRows.map((p) => p.id),
			),
		);

	const earnsByPost = new Map<number, Set<AttentionEventType>>();
	for (const entry of entries) {
		const contentType = entry.kind === "text" ? "text" : entry.type;
		if (!contentType || !isTimePoolEligible(contentType)) continue;
		const set = earnsByPost.get(entry.postId) ?? new Set<AttentionEventType>();
		set.add(eventTypeFor(contentType));
		earnsByPost.set(entry.postId, set);
	}

	const ctx = await buildAccessContext(viewerId, { postIds: postRows.map((p) => p.id) });
	for (const post of postRows) {
		byId.set(post.id, {
			creatorId: post.creatorId,
			earns: earnsByPost.get(post.id) ?? new Set(),
			accessible: resolveAccessSync(post as AccessiblePost, ctx).canAccess,
		});
	}
	return byId;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const subscriptionRoutes = new Hono()
	// ── Rank ladder ─────────────────────────────────────────────────────────────
	.get("/badges", (c) => c.json({ badges: PLANS }))

	// ── Current Account ──────────────────────────────────────────────────────
	.get("/me", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);

		if (!acct) {
			return c.json({
				account: {
					anthersSeeds: 0,
					creatorSeedTotal: "0.00",
					bandwidthUsedGiB: "0",
					isSelfHosting: false,
					isActive: true,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					canceledAt: null,
				},
				anthersSeeds: 0,
				rank: "free",
				plan: PLANS[0],
			});
		}

		return c.json({
			account: acct,
			anthersSeeds: acct.anthersSeeds,
			rank: rankForSeeds(acct.anthersSeeds),
			plan: planFor(acct.anthersSeeds),
		});
	})

	// ── Preview an Anthers-Seed count (no charge) — powers the confirmation modal ──
	.get("/preview/:seeds", requireAuth, async (c) => {
		const user = c.get("user");
		const target = Number(c.req.param("seeds"));
		if (!Number.isInteger(target) || target < 0 || target > MAX_ANTHERS_SEEDS) {
			return c.json({ error: "Invalid Anthers-Seed count" }, 400);
		}
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		const acct = await ensureAccount(user.id);

		// Cancel preview (→ 0 / Free): what you keep, and until when.
		if (target === 0) {
			if (!acct.stripeSubscriptionId || acct.anthersSeeds === 0) {
				return c.json({ error: "No Anthers-Seeds to cancel" }, 400);
			}
			const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId).catch(() => null);
			return c.json({
				isCancel: true,
				anthersSeeds: 0,
				currentSeeds: acct.anthersSeeds,
				nextBillingUnix: sub?.items.data[0]?.current_period_end ?? null,
			});
		}

		const price = SEED_PRICE * target;

		// The card on file — attached when a subscription's first payment is confirmed.
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
				const priceId = seedPriceId();
				if (priceId) {
					const preview = await stripe.invoices.createPreview({
						customer: acct.stripeCustomerId ?? undefined,
						subscription: sub.id,
						subscription_details: {
							items: [{ id: sub.items.data[0].id, price: priceId, quantity: target }],
							proration_behavior: "always_invoice",
						},
					});
					chargeNow = Math.max(0, preview.amount_due / 100).toFixed(2);
					nextBillingUnix = sub.items.data[0]?.current_period_end ?? null;
				}
			}
		}
		if (!isChange) {
			const next = new Date();
			next.setMonth(next.getMonth() + 1);
			nextBillingUnix = Math.floor(next.getTime() / 1000);
		}

		return c.json({
			isCancel: false,
			anthersSeeds: target,
			isChange,
			recurring: { amount: price.toFixed(2), interval: "month" as const },
			chargeNow,
			nextBillingUnix,
			savedCard,
		});
	})

	// ── Set the Anthers-Seed count (subscribe / change / cancel) ─────────────
	.post(
		"/account",
		requireAuth,
		requireVerified,
		zValidator("json", z.object({ anthersSeeds: z.number().int().min(0).max(MAX_ANTHERS_SEEDS) })),
		async (c) => {
			const user = c.get("user");
			const { anthersSeeds } = c.req.valid("json");
			if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

			const acct = await ensureAccount(user.id);

			// Drop to 0 (Free) → cancel the subscription at period end (webhook reverts).
			if (anthersSeeds === 0) {
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

			const priceId = seedPriceId();
			if (!priceId) return c.json({ error: "No Stripe price configured for Anthers-Seeds" }, 500);
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");

			// Changing the count on an active subscription → set the quantity with proration.
			if (acct.stripeSubscriptionId) {
				const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId);
				if (sub.status === "active" || sub.status === "trialing") {
					await stripe.subscriptions.update(sub.id, {
						items: [{ id: sub.items.data[0].id, price: priceId, quantity: anthersSeeds }],
						proration_behavior: "always_invoice",
						cancel_at_period_end: false,
					});
					return c.json({ pending: false, account: await getAccount(user.id) });
				}
			}

			// New subscription → create it incomplete and hand back the confirmation secret so
			// the user confirms the first payment inline; the webhook applies the count on success.
			const sub = await stripe.subscriptions.create({
				customer: customerId,
				items: [{ price: priceId, quantity: anthersSeeds }],
				payment_behavior: "default_incomplete",
				payment_settings: { save_default_payment_method: "on_subscription" },
				expand: ["latest_invoice.confirmation_secret"],
				metadata: { userId: String(user.id), anthersSeeds: String(anthersSeeds) },
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

	// ── Buy directed creator-Seeds (to give to creators) ─────────────────────
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
			// Charge quantity × $3 (+ card processing on top) via Stripe; the webhook credits on success.
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

	// ── Cancel (revert to 0 / Free at period end) ────────────────────────────
	.post("/cancel", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct || acct.anthersSeeds === 0) {
			return c.json({ error: "No Anthers-Seeds to cancel" }, 400);
		}
		// Refuse outright when payments aren't configured, like the other seven payment
		// routes. This used to be `if (stripe && …)`, which silently SKIPPED Stripe and
		// mutated the DB anyway — recording a cancellation locally that never reached
		// Stripe, so billing would keep charging a user the UI showed as cancelled. That was
		// filed as harmless while prod carried no Stripe config; prod now runs Stripe in
		// test mode, so the guard is doing real work.
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		// Cancel at period end — the Seeds keep working until the cycle ends, then the
		// subscription.deleted webhook reverts to 0. An account with no Stripe subscription
		// (nothing to cancel remotely) still cancels locally: the flag is its whole state.
		if (acct.stripeSubscriptionId) {
			await stripe.subscriptions.update(acct.stripeSubscriptionId, { cancel_at_period_end: true });
		}
		await db.update(accounts).set({ canceledAt: new Date() }).where(eq(accounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Resume ───────────────────────────────────────────────────────────────
	.post("/resume", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct?.canceledAt) {
			return c.json({ error: "No canceled subscription to resume" }, 400);
		}
		// Same guard as cancel — see the note there on why `if (stripe && …)` was wrong.
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		if (acct.stripeSubscriptionId) {
			await stripe.subscriptions.update(acct.stripeSubscriptionId, { cancel_at_period_end: false });
		}
		await db.update(accounts).set({ canceledAt: null }).where(eq(accounts.id, acct.id));
		const updated = await getAccount(user.id);
		return c.json({ account: updated });
	})

	// ── Billing Portal ───────────────────────────────────────────────────────
	.post("/billing-portal", requireAuth, async (c) => {
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);
		const user = c.get("user");
		const customerId = await ensureStripeCustomer(user.id, user.email);
		const base =
			process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000";
		const session = await stripe.billingPortal.sessions.create({
			customer: customerId,
			return_url: `${base}/subscription`,
		});
		return c.json({ portalUrl: session.url });
	})

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
				return c.json({ recorded: 0, granted: 0, refused: 0, ineligible: 0 });
			}

			// Eligibility, re-decided server-side. A zero-duration event carries no time
			// and cannot over-credit, so visit pings pass through untouched — they are
			// deliberately the analytics signal for surfaces that earn nothing. Anything
			// claiming *time* has to earn it, against four checks:
			//
			//   1. It names a post. A claim with no post context is connective tissue by
			//      definition (a profile, discovery) and the model says those earn nothing.
			//   2. That post exists.
			//   3. The claimed creator really is the post's creator — otherwise the
			//      attribution is simply forged.
			//   4. The post carries a content element that earns this event type, and the
			//      viewer can actually access it. Prose in a post BODY earns nothing while
			//      the same prose as a content element earns; that asymmetry is deliberate
			//      and documented, and this is where it becomes true rather than intended.
			const timed = events.filter((e) => e.durationSeconds > 0);
			const eligibility = await loadPostEligibility(
				[...new Set(timed.map((e) => e.postId).filter((id): id is number => id != null))],
				user.id,
			);

			const eligible = events.filter((e) => {
				if (e.durationSeconds <= 0) return true;
				if (e.postId == null) return false;
				const post = eligibility.get(e.postId);
				if (!post) return false;
				if (post.creatorId !== e.creatorId) return false;
				return post.accessible && post.earns.has(e.eventType);
			});

			const ineligible = events.length - eligible.length;
			if (ineligible > 0) {
				console.warn(
					`attention eligibility: user ${user.id} submitted ${ineligible} of ${events.length} events that no post entitles them to — dropped`,
				);
			}

			if (eligible.length === 0) {
				return c.json({ recorded: 0, granted: 0, refused: 0, ineligible });
			}

			// The wall-clock clamp. Everything upstream of here is client-supplied:
			// the browser splits a tick between concurrent claims, but it only sees
			// one tab, and a forged request sees nothing at all. Credited seconds in
			// any rolling window can never exceed the seconds that actually elapsed,
			// so five tabs, five devices, or a hand-written request all land against
			// one budget. Honest use never reaches it — you cannot consume more than
			// an hour of anything within an hour.
			const windowStart = new Date(Date.now() - CREDIT_WINDOW_SECONDS * 1_000);
			const [spent] = await db
				.select({
					total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int`,
				})
				.from(attentionEvents)
				.where(
					and(eq(attentionEvents.userId, user.id), gte(attentionEvents.createdAt, windowStart)),
				);

			// Clamped over the ELIGIBLE set, so a rejected claim never eats another
			// surface's budget on its way to being dropped.
			const { events: allowed, granted, refused } = clampToWindow(eligible, spent?.total ?? 0);

			if (refused > 0) {
				console.warn(
					`attention clamp: user ${user.id} claimed ${granted + refused}s with ${spent?.total ?? 0}s already credited this window — refused ${refused}s`,
				);
			}

			const rows = allowed.map((e) => ({
				userId: user.id,
				creatorId: e.creatorId,
				eventType: e.eventType,
				durationSeconds: e.durationSeconds,
				postId: e.postId ?? null,
			}));

			await db.insert(attentionEvents).values(rows);

			return c.json({ recorded: rows.length, granted, refused, ineligible });
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
	// The budget is the creator-Seed balance the user holds this cycle; 100% goes to
	// creators. Directing a Seed to a creator clears that creator's Seed Gates.
	// Amounts are whole Seeds: a Seed is an indivisible $3 unit, so an allocation is
	// always a multiple of SEED_PRICE — the API rejects anything else rather than
	// silently storing a fraction of a Seed.
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
		const budget = Number(acct?.creatorSeedTotal ?? 0);
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
				amount: z
					.string()
					.regex(/^\d+\.\d{2}$/, "Amount must be in X.XX format")
					.refine((v) => Number(v) % SEED_PRICE === 0, {
						message: `Seeds are $${SEED_PRICE} each — the amount must be a whole number of Seeds`,
					}),
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
			const budget = Number(acct?.creatorSeedTotal ?? 0);

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
				// seed gate: dollars of Seeds ($3 increments). anthers_badge gate: rank (1=root … 4=blossom).
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

	// ── Creator Status (for creator page rank/Seed display) ─────────────────
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

		// The viewer's held Anthers-Seeds (point-in-time) and their Seeds to this creator.
		const anthersSeeds = await heldAnthersSeeds(currentUserId);
		const badge = rankForSeeds(anthersSeeds);
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

		// Both gate types are a whole-Seed threshold (migration `0007`) — the Anthers Gate reads
		// Anthers-Seeds held, the Seed Gate reads Seeds given here. Same comparison, two counts.
		// The dollar ledger is converted once, so no threshold is ever compared against money.
		const givenSeeds = seedsFromDollars(seedAmount);
		const unlockedGates = gates
			.filter((g) =>
				seedsMeet(g.gateType === "anthers_badge" ? anthersSeeds : givenSeeds, Number(g.threshold)),
			)
			.map((g) => g.id);

		return c.json({
			badge,
			seedAmount,
			gates,
			unlockedGates,
		});
	});

export { subscriptionRoutes };
