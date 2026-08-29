// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Account & economics routes — the support model.
 *
 * A user's account holds a monthly **amount** given to Anthers (`anthersSupport`) — that
 * amount **is** their Badge, and is their Anthers subscription (one Stripe item per
 * destination, each carrying its own amount). What they direct at creators is tracked in
 * `seed_allocations`; `creatorSupportTotal` is the balance they direct from.
 *
 * ⚠️ This block was left **half-edited** by the retirement until 2026-08-19: the noun
 * became "amount" while the next clause still read "that **count** is their rank … at $3
 * each … a single $3 Seed price × quantity". It also named `creatorSeedTotal`, which does
 * not exist.
 * There is no bandwidth line — delivery is free at any volume. This file also
 * serves time (attention) tracking, pool distributions, creator gates, and access.
 */

import { db } from "@anthers/db/client";
import {
	accounts,
	attentionEvents,
	creatorGates,
	poolDistributions,
	seedAllocations,
	users,
	works,
} from "@anthers/db/schema";
import {
	type AttentionEventType,
	CREDIT_WINDOW_SECONDS,
	clampToWindow,
	eventTypeFor,
	isTimePoolEligible,
} from "@anthers/shared/attention";
import { amountMeets, heldBadgeName, supportAmount } from "@anthers/shared/constants";
import { badgeViews } from "@anthers/shared/fees";
import type { PublicAccessBudget, ShareLinkBudget } from "@anthers/shared/public-access";
import { STRIPE_RETURN_PATHS } from "@anthers/shared/redirect-paths";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type Stripe from "stripe";
import { z } from "zod";
import { getStripe } from "../lib/stripe.js";
import { getOptionalUserId, requireAuth, requireVerified } from "../middleware/auth.js";
import {
	type AccessibleWork,
	buildAccessContext,
	heldAnthersSupport,
	resolveAccess,
	resolveAccessSync,
} from "../services/access.js";
import { validateSession } from "../services/auth.js";
import {
	createOneTimeCharge,
	ensureAnthersProduct,
	ensureCreatorProduct,
	ensureStripeCustomer,
	itemsFromSub,
	periodEndFromSub,
	savedCardFor,
	supportItems,
} from "../services/billing.js";
import { loadPublicAccessBudget, loadShareLinkBudget } from "../services/public-access.js";
import { resolveShareToken } from "../services/share-links.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Operational ceiling, in **dollars a month**, on a single subscription update — a
 * fat-finger and abuse guard, NOT a model bound.
 *
 * `services/billing.ts` describes the Badge ladder as "unbounded, so Blossom+ works", and
 * both are true: the ladder genuinely has no top rung (what you give keeps scaling what
 * your time pays creators), while this caps what one request may set. The two read as
 * contradictory, which is why it was filed as drift; the resolution is that "unbounded" is
 * about the ladder and this is about a request. Note `/seeds/buy` uses a different bound
 * again — left alone here, but the roadmap carries a milestone for reconciling them.
 *
 * ⚠️ A stranded one-line docblock sat directly above this one until 2026-08-19, reading
 * *"Max Anthers-Seeds a single subscription can hold"* — the pre-retirement description of
 * the same constant, left behind when the real block was written above the rename. Two
 * docblocks on one declaration is a shape worth noticing: the compiler takes the nearest
 * and the reader takes the first.
 */
const MAX_ANTHERS_SUPPORT = 300;

/**
 * The smallest a whole monthly charge may come to.
 *
 * 🚨 **A floor on the INVOICE, never on a destination**, and that distinction is the point
 * of retiring the $3 unit. The old floor was per-Seed and justified by card economics — a
 * $1 charge loses ~33% to processing — but PR #223 made one subscription carry everything a
 * user gives, so the fixed $0.30 is paid once a month whatever the denomination. What the
 * fee actually argues for is a minimum total, which is here, and a creator may set a $1
 * Badge without it costing anyone a third of it.
 *
 * $0.50 because that is Stripe's own minimum charge; going lower is not ours to choose.
 */
const MIN_INVOICE_TOTAL = 0.5;

/** The Badge ladder (Free … Blossom), each with its monthly amount + decomposition. Shared
 *  with the Subscribe page via `badgeViews()` so the two never drift. */
const BADGE_VIEWS = badgeViews();

/** The Badge view for monthly dollars given to Anthers (capped at Blossom for display). */
function badgeViewFor(anthersSupport: number) {
	// Look the rung up by its Badge, never by array position. `thresholdForBadge` returns a
	// THRESHOLD, and a threshold only doubles as an index while Anthers' Badges sit at
	// 1/2/3/4; the moment they don't, indexing returns the wrong rung or undefined.
	const held = heldBadgeName(anthersSupport);
	return BADGE_VIEWS.find((v) => v.id === held) ?? BADGE_VIEWS[0];
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

// 🚨 A private, cookie-only `getOptionalUserId` lived here until 2026-08-28, having outlived
// the consolidation that `middleware/auth.ts` documents as having removed it. It never read
// the `Authorization: Bearer` header, so a packaged desktop Studio session read as signed out
// at `GET /public-access` and was told it had no allowance. Two ways to read one session must
// not answer differently; the import above is the one that does.

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
interface WorkEligibility {
	/**
	 * Null on a withdrawn Work whose creator deleted their account. Attention against
	 * one is ineligible by construction — the claim has to name a creator that matches,
	 * and null matches nobody, so there is no creator left to pay.
	 */
	creatorId: number | null;
	/** Event types this Work can earn — empty means it earns nothing. */
	earns: Set<AttentionEventType>;
	/** Whether the claiming viewer may actually consume it. */
	accessible: boolean;
	/**
	 * Whether this Work is **Public Access** — ungated, streaming, free to everyone — so
	 * its seconds draw a free account's monthly allowance. Gated work the viewer cleared,
	 * work they bought, and their own catalogue are all excluded by this being false.
	 */
	publicAccess: boolean;
	/** Private Works aren't public consumption, so they can't earn from the public. */
	released: boolean;
}

/**
 * Eligibility, keyed on the **Work** — which is what actually earns.
 *
 * This got simpler with the model rather than merely moving: a post could hold many
 * content elements of different types, so "what does this earn?" was a set gathered
 * across a join. A Work has exactly one type, so it is one lookup. The asymmetry the old
 * version existed to enforce — prose in a post BODY earns nothing while the same prose as
 * a content element earns — is now structural: prose that earns is a Work of type `text`,
 * and a post body is an announcement.
 */
async function loadWorkEligibility(
	workIds: number[],
	viewerId: number | null,
	sharedBy: number | null = null,
): Promise<Map<number, WorkEligibility>> {
	const byId = new Map<number, WorkEligibility>();
	if (workIds.length === 0) return byId;

	const workRows = await db.select().from(works).where(inArray(works.id, workIds));
	if (workRows.length === 0) return byId;

	const ctx = await buildAccessContext(viewerId, {
		workIds: workRows.map((w) => w.id),
		sharedBy,
	});
	for (const work of workRows) {
		const earns = new Set<AttentionEventType>();
		if (isTimePoolEligible(work.type)) earns.add(eventTypeFor(work.type));
		const access = resolveAccessSync(work as AccessibleWork, ctx);
		byId.set(work.id, {
			creatorId: work.creatorId,
			earns,
			accessible: access.canAccess,
			released: work.visibility === "released",
			// Public Access = ungated, streaming, free to everyone. `isFree` is exactly
			// "an allowed baseline row at price 0", so the definition is the resolver's
			// rather than a second copy of it. Stamped per event because a Work's access
			// can change later and today's answer must not be applied to last week's
			// seconds — see the column note on `attention_events.public_access`.
			//
			// A creator's own watching is excluded here rather than by the meter: `owner`
			// reports `isFree: false`, so their seconds never carry the flag and never
			// draw an allowance for consuming their own catalogue.
			publicAccess:
				access.isFree &&
				work.streamEnabled &&
				work.visibility === "released" &&
				// ⚠️ **A creator sharing their OWN Work earns nothing from it**, which the owner
				// branch cannot say here: a share context has a null viewer, so `owner` never
				// fires and `isFree` comes back true. Without this the sharer's Time Pool would
				// pay the sharer, which is the same refusal `resolveAccessSync` makes for a
				// creator watching their own catalogue — a pool is for buying the commons from
				// somebody else. The seconds are still recorded and still draw the relay budget,
				// because what that bounds is how much viewing one account may fund, and
				// funding it for your own work is exactly the case most in need of a bound.
				!(sharedBy != null && work.creatorId === sharedBy),
		});
	}
	return byId;
}

// ── The attributable viewer ──────────────────────────────────────────────────

/**
 * Who these seconds belong to — an account, or the **sharer** whose link a stranger followed.
 *
 * 🚨 **A session always wins over a token.** Somebody with an account spends their own
 * allowance whatever link they arrived by; otherwise a link would be a way to consume on
 * another person's meter while signed in.
 *
 * ⚠️ **The token is not checked against the Works being claimed here, and does not need to
 * be.** Eligibility is re-resolved below against a share context, so a claim naming a Work the
 * link does not cover is refused by the resolver like any other — a share context reaches
 * only universally-free work, which is the same set any recipient could already open. What
 * the token decides is *whose month pays*, and that is the sharer either way.
 */
async function attributionFor(
	c: Parameters<typeof getOptionalUserId>[0],
): Promise<{ userId: number | null; sharedBy: number | null }> {
	const userId = await getOptionalUserId(c);
	if (userId != null) return { userId, sharedBy: null };
	const token = c.req.query("share");
	if (!token) return { userId: null, sharedBy: null };
	const link = await resolveShareToken(token);
	return { userId: null, sharedBy: link?.sharerId ?? null };
}

/**
 * A session, **or** a live share link. See the note on `POST /attention` for why this
 * endpoint wants an *attributable* caller rather than a logged-in one.
 */
const requireAttributableViewer = createMiddleware(async (c, next) => {
	const token = c.req.query("share");
	if (token && (await resolveShareToken(token))) return next();
	return requireAuth(c, next);
});

/**
 * The relay budget in the ordinary meter's shape.
 *
 * The players read `remainingSeconds` and `allowed` to draw a countdown and a wall, and a
 * share-link recipient needs both for exactly the same reason a signed-in viewer does. Giving
 * them a second shape would mean a second branch in every player for a difference they should
 * never see — what ran out is *time on this link*, and the copy says so.
 */
function shareLinkBudgetAsMeter(b: ShareLinkBudget): PublicAccessBudget {
	return {
		unlimited: false,
		usedSeconds: b.usedSeconds,
		limitSeconds: b.limitSeconds,
		remainingSeconds: b.remainingSeconds,
		allowed: b.allowed,
	};
}

// ─── Routes ──────────────────────────────────────────────────────────────────

const subscriptionRoutes = new Hono()
	// ── Badge ladder ────────────────────────────────────────────────────────────
	.get("/badges", (c) => c.json({ badges: BADGE_VIEWS }))

	// ── Current Account ──────────────────────────────────────────────────────
	// ── Public Access meter ──────────────────────────────────────────────────
	// A free account watches 10 hours of the commons a month; the Public Access price
	// given to Anthers removes the limit and nothing above it buys more. Its own endpoint because
	// it is a property of the ACCOUNT, not of any Work — a Work never reports itself
	// gated by the meter, or the commons would be stratified again.
	.get("/public-access", async (c) => {
		const userId = await getOptionalUserId(c);
		return c.json(await loadPublicAccessBudget(userId));
	})

	.get("/me", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);

		if (!acct) {
			return c.json({
				account: {
					anthersSupport: "0.00",
					creatorSupportTotal: "0.00",
					bandwidthUsedGiB: "0",
					isSelfHosting: false,
					isActive: true,
					currentPeriodStart: null,
					currentPeriodEnd: null,
					canceledAt: null,
				},
				anthersSupport: 0,
				// Derived rather than typed as the literal "free": inside `c.json` a string
				// literal widens to `string`, and the RPC client then cannot see it is a
				// BadgeKey at all.
				badge: heldBadgeName(0),
				badgeView: BADGE_VIEWS[0],
			});
		}

		return c.json({
			account: acct,
			anthersSupport: supportAmount(acct.anthersSupport),
			badge: heldBadgeName(supportAmount(acct.anthersSupport)),
			badgeView: badgeViewFor(supportAmount(acct.anthersSupport)),
		});
	})

	// ── Preview a monthly amount to Anthers (no charge) — powers the confirmation modal ──
	.get("/preview/:amount", requireAuth, async (c) => {
		const user = c.get("user");
		// ⚠️ NOT `Number.isInteger`. Amounts carry cents since the Seed retired as a unit,
		// so an integer check here would refuse to preview any amount a creator's own
		// ladder can actually sit at.
		const target = supportAmount(c.req.param("amount"));
		if (!Number.isFinite(target) || target < 0 || target > MAX_ANTHERS_SUPPORT) {
			return c.json({ error: "Invalid amount" }, 400);
		}
		const stripe = getStripe();
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		const acct = await ensureAccount(user.id);

		// Cancel preview (→ 0 / Free): what you keep, and until when.
		if (target === 0) {
			if (!acct.stripeSubscriptionId || supportAmount(acct.anthersSupport) === 0) {
				return c.json({ error: "Nothing given to Anthers to cancel" }, 400);
			}
			const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId).catch(() => null);
			return c.json({
				isCancel: true,
				anthersSupport: 0,
				currentSupport: supportAmount(acct.anthersSupport),
				nextBillingUnix: sub ? periodEndFromSub(sub) : null,
			});
		}

		const price = target;

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
				const product = await ensureAnthersProduct();
				if (product) {
					// Preview only the ANTHERS line moving. Sending the whole item set would
					// price a change to every creator the user supports as well, which is not
					// what this modal is asking about.
					const existing = itemsFromSub(sub).find((i) => i.creatorId === null);
					const preview = await stripe.invoices.createPreview({
						customer: acct.stripeCustomerId ?? undefined,
						subscription: sub.id,
						subscription_details: {
							items: [
								{
									...(existing ? { id: existing.itemId } : {}),
									price_data: {
										currency: "usd",
										product,
										unit_amount: Math.round(target * 100),
										recurring: { interval: "month" as const },
									},
									quantity: 1,
									metadata: { destination: "anthers" },
								},
							],
							proration_behavior: "always_invoice",
						},
					});
					chargeNow = Math.max(0, preview.amount_due / 100).toFixed(2);
					nextBillingUnix = periodEndFromSub(sub);
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
			anthersSupport: target,
			isChange,
			recurring: { amount: price.toFixed(2), interval: "month" as const },
			chargeNow,
			nextBillingUnix,
			savedCard,
		});
	})

	// ── Set the monthly support (subscribe / change / cancel) ────────────────
	.post(
		"/account",
		requireAuth,
		requireVerified,
		zValidator(
			"json",
			z.object({
				/**
				 * Monthly dollars to Anthers. **Not an integer** — there is no unit any more,
				 * and refusing $2.50 here would reimpose the granularity the Seed retirement
				 * removed. `$${PUBLIC_ACCESS_PRICE}` buys unlimited Public Access; above that
				 * is standing, never more reach.
				 */
				anthersSupport: z.number().min(0).max(MAX_ANTHERS_SUPPORT),
				/**
				 * Support pointed at creators, on the SAME charge — one subscription item
				 * each, so the invoice names them. Optional, so every existing caller (the
				 * post unlock, /subscription) keeps working untouched and simply means
				 * "nothing directed on this charge".
				 */
				directed: z
					.array(
						z.object({
							creatorId: z.number().int(),
							amount: z.number().min(0.5).max(MAX_ANTHERS_SUPPORT),
						}),
					)
					.max(50)
					.optional(),
			}),
		),
		async (c) => {
			const user = c.get("user");
			const { anthersSupport, directed = [] } = c.req.valid("json");
			const stripe = getStripe();
			if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

			const acct = await ensureAccount(user.id);
			const directedTotal = directed.reduce((sum, d) => sum + d.amount, 0);
			const total = anthersSupport + directedTotal;

			// Nothing at all → cancel the subscription at period end (webhook reverts).
			if (total === 0) {
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

			/**
			 * 🚨 The one floor left, and it is a floor on the **invoice**, not on any
			 * destination.
			 *
			 * The retired $3 unit was justified by card economics — a $1 charge loses ~33%
			 * to processing — and that argument only ever supported a minimum *total*, since
			 * PR #223 made one subscription carry everything and the fixed $0.30 is paid once
			 * a month whatever the denomination. So a creator may sit at $1; a whole month's
			 * charge may not, and Stripe would refuse it anyway below $0.50.
			 */
			if (total < MIN_INVOICE_TOTAL) {
				return c.json(
					{ error: `A monthly charge has to come to at least $${MIN_INVOICE_TOTAL.toFixed(2)}.` },
					400,
				);
			}

			const product = await ensureAnthersProduct();
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");

			// A Product per creator, so each line on the invoice names who it is for.
			const creators =
				directed.length > 0
					? await db
							.select({ id: users.id, username: users.username })
							.from(users)
							.where(
								inArray(
									users.id,
									directed.map((d) => d.creatorId),
								),
							)
					: [];
			const byId = new Map(creators.map((u) => [u.id, u.username ?? String(u.id)]));
			const picks: { creatorId: number; product: string; amount: number }[] = [];
			for (const d of directed) {
				const handle = byId.get(d.creatorId);
				if (!handle) return c.json({ error: "Unknown creator in the directed list" }, 400);
				picks.push({
					creatorId: d.creatorId,
					product: await ensureCreatorProduct(d.creatorId, handle),
					amount: d.amount,
				});
			}
			const items = supportItems(product, anthersSupport, picks);

			// Changing an active subscription → replace the whole item set with proration.
			//
			// ⚠️ Every existing item is listed with `deleted: true` alongside the new ones.
			// Stripe does NOT remove an item you simply omit, so leaving that out would keep
			// charging for a creator the user just stopped supporting — silently, and
			// visibly on their next invoice rather than anywhere we would see it.
			if (acct.stripeSubscriptionId) {
				const sub = await stripe.subscriptions.retrieve(acct.stripeSubscriptionId);
				if (sub.status === "active" || sub.status === "trialing") {
					await stripe.subscriptions.update(sub.id, {
						items: [...sub.items.data.map((i) => ({ id: i.id, deleted: true as const })), ...items],
						proration_behavior: "always_invoice",
						cancel_at_period_end: false,
						metadata: { ...sub.metadata, userId: String(user.id) },
					});
					return c.json({ pending: false, account: await getAccount(user.id) });
				}
			}

			// New subscription → create it incomplete and hand back the confirmation secret so
			// the user confirms the first payment inline; the webhook applies it on success.
			const sub = await stripe.subscriptions.create({
				customer: customerId,
				items,
				payment_behavior: "default_incomplete",
				payment_settings: { save_default_payment_method: "on_subscription" },
				expand: ["latest_invoice.confirmation_secret"],
				metadata: { userId: String(user.id) },
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

	// ── Top up the directed-support balance (a one-off, not the subscription) ──
	.post(
		"/seeds/buy",
		requireAuth,
		requireVerified,
		zValidator("json", z.object({ amount: z.number().min(MIN_INVOICE_TOTAL).max(3000) })),
		async (c) => {
			const user = c.get("user");
			const { amount } = c.req.valid("json");
			const stripe = getStripe();
			if (!stripe) return c.json({ error: "Payments are not configured." }, 503);
			await ensureAccount(user.id);
			const customerId = await ensureStripeCustomer(user.id, user.email ?? "");
			// Charged all-in via Stripe — the card fee comes out of it, not on top; the
			// webhook credits the balance on success. ⚠️ A one-off charge pays the fixed
			// $0.30 by itself, which is exactly the cost the monthly subscription exists to
			// amortise — so this path is genuinely expensive at small amounts, and nothing
			// in the UI reaches it.
			const charge = await createOneTimeCharge({
				userId: user.id,
				customerId,
				type: "seeds",
				base: amount,
			});
			return c.json({ ...charge, savedCard: await savedCardFor(customerId) });
		},
	)

	// ── Self-Hosting Toggle (creators) ───────────────────────────────────────
	/**
	 * 🚨 **Closed with a 503, deliberately, until an origin can back the claim.**
	 *
	 * This set `accounts.is_self_hosting` to whatever an authenticated caller asked for,
	 * asserting nothing about whether they host anything — a creator-facing money input
	 * whose precondition was *claimed rather than observed*. What makes closing it the
	 * right move rather than a deferral is that the flag currently prices **nothing**: no
	 * code path bills a creator for storage at all, `SELF_HOST_FEE` has been `0` since
	 * 2026-08-12, and no UI anywhere calls this endpoint.
	 *
	 * ⚠️ And its one live effect is **inverted** — it costs the claimant money rather than
	 * saving it. `calculate-crf` reads the flag, gets a zeroed hosting cost from
	 * `estimateStorageCost`, and its `earnings.gte(hostingCost)` test then passes for
	 * everyone (earnings are never negative), so it records a zero subsidy and moves on.
	 * Setting this flag today makes a creator permanently ineligible for the hosting
	 * subsidy. A 503 removes a footgun; it does not withhold a feature.
	 *
	 * **The eventual shape is not a better-guarded setter.** The flag should be DERIVED
	 * from origin registration — a creator is self-hosting if and only if the hub knows a
	 * registered origin of theirs — which is milestone 1 of Creator-Hosted Delivery. So do
	 * not build a verification mechanism here in the meantime: there is nothing to verify
	 * against, and anything built now is replaced by that registration. When it lands, this
	 * stops being a setter and the column stops being a claim.
	 */
	.post(
		"/self-hosting",
		requireAuth,
		zValidator("json", z.object({ enabled: z.boolean() })),
		async (c) =>
			c.json(
				{
					error:
						"Self-hosting cannot be set here. It will be derived from a registered origin once creator-hosted delivery ships.",
				},
				503,
			),
	)

	// ── Cancel (revert to 0 / Free at period end) ────────────────────────────
	.post("/cancel", requireAuth, async (c) => {
		const user = c.get("user");
		const acct = await getAccount(user.id);
		if (!acct || supportAmount(acct.anthersSupport) === 0) {
			return c.json(
				{ error: "You are not supporting Anthers, so there is nothing to cancel" },
				400,
			);
		}
		// Refuse outright when payments aren't configured, like the other seven payment
		// routes. This used to be `if (stripe && …)`, which silently SKIPPED Stripe and
		// mutated the DB anyway — recording a cancellation locally that never reached
		// Stripe, so billing would keep charging a user the UI showed as cancelled. That was
		// filed as harmless while prod carried no Stripe config; prod now runs Stripe in
		// test mode, so the guard is doing real work.
		const stripe = getStripe();
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);

		// Cancel at period end — the support keeps working until the cycle ends, then the
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
		const stripe = getStripe();
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
		const stripe = getStripe();
		if (!stripe) return c.json({ error: "Payments are not configured." }, 503);
		const user = c.get("user");
		const customerId = await ensureStripeCustomer(user.id, user.email);
		const base =
			process.env.PUBLIC_WEB_URL?.trim() || c.req.header("origin") || "http://localhost:3000";
		const session = await stripe.billingPortal.sessions.create({
			customer: customerId,
			return_url: `${base}${STRIPE_RETURN_PATHS.billingPortalReturn}`,
		});
		return c.json({ portalUrl: session.url });
	})

	// ── Time (Attention) Events ──────────────────────────────────────────────
	/**
	 * 🚨 **`requireAuth` became `requireAttributableViewer` on 2026-08-28, and the name is the
	 * whole argument.** This endpoint is where time turns into money, so what it has always
	 * needed is not a *logged-in* caller but an *attributable* one — somebody a creator can be
	 * paid on behalf of. An account is the ordinary way to be that. A **share link** is the
	 * other way: the viewer is a stranger we deliberately did not ask to sign up, and the time
	 * is attributed to whoever shared the link, who does have an account.
	 *
	 * ⚠️ **Which is also why the exception cannot leak into access.** The rows written below
	 * carry the sharer's `user_id` and `via_share_link: true`; the *entitlement* question was
	 * already answered by `resolveAccessSync` against a null viewer, so nothing a link carries
	 * can open gated or Adult work. See `services/share-links.ts`.
	 */
	.post(
		"/attention",
		requireAttributableViewer,
		zValidator(
			"query",
			z.object({
				/** A **share link** token — see `attributionFor`. Declared so the client can send it. */
				share: z.string().optional(),
			}),
		),
		zValidator(
			"json",
			z.object({
				events: z
					.array(
						z.object({
							creatorId: z.number().int(),
							eventType: z.enum(["page_view", "play", "watch", "read", "listen"]),
							durationSeconds: z.number().int().min(0).max(300).default(0),
							workId: z.number().int().optional(),
						}),
					)
					.max(50),
			}),
		),
		async (c) => {
			const { userId, sharedBy } = await attributionFor(c);
			// The account the seconds are recorded against. For a share-link view that is the
			// sharer — which is what makes the time attributable at all, and the Time Pool
			// cannot pay a creator for time it cannot attribute to anybody.
			const attributedTo = userId ?? sharedBy;
			if (attributedTo == null) return c.json({ error: "Authentication required" }, 401);
			const viaShareLink = userId == null;
			const { events } = c.req.valid("json");

			if (events.length === 0) {
				return c.json({ recorded: 0, granted: 0, refused: 0, ineligible: 0 });
			}

			// Eligibility, re-decided server-side. A zero-duration event carries no time
			// and cannot over-credit, so visit pings pass through untouched — they are
			// deliberately the analytics signal for surfaces that earn nothing. Anything
			// claiming *time* has to earn it, against four checks:
			//
			//   1. It names a Work. A claim with no Work context is connective tissue by
			//      definition (a post body, a profile, discovery) and those earn nothing.
			//   2. That Work exists and has been released — private staging isn't
			//      consumption, so it cannot be consumed by the public.
			//   3. The claimed creator really is the Work's creator — otherwise the
			//      attribution is simply forged.
			//   4. The Work's type earns this event type, and the viewer can actually
			//      access it.
			const timed = events.filter((e) => e.durationSeconds > 0);
			const eligibility = await loadWorkEligibility(
				[...new Set(timed.map((e) => e.workId).filter((id): id is number => id != null))],
				userId,
				sharedBy,
			);

			const eligible = events.filter((e) => {
				if (e.durationSeconds <= 0) return true;
				if (e.workId == null) return false;
				const work = eligibility.get(e.workId);
				if (!work) return false;
				if (work.creatorId !== e.creatorId) return false;
				if (!work.released && work.creatorId !== userId) return false;
				return work.accessible && work.earns.has(e.eventType);
			});

			const ineligible = events.length - eligible.length;
			if (ineligible > 0) {
				console.warn(
					`attention eligibility: ${viaShareLink ? `a share link of user ${attributedTo}` : `user ${attributedTo}`} submitted ${ineligible} of ${events.length} events that no Work entitles them to — dropped`,
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
			//
			// ⚠️ **The clamp counts the attributed account's WHOLE window, share-link seconds
			// included.** That is deliberate: it is a wall-clock bound, and wall clocks do not
			// fork. Giving a share link its own window would hand every account a second hour
			// per hour, which is the one thing this check exists to make impossible.
			const windowStart = new Date(Date.now() - CREDIT_WINDOW_SECONDS * 1_000);
			const [spent] = await db
				.select({
					total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int`,
				})
				.from(attentionEvents)
				.where(
					and(
						eq(attentionEvents.userId, attributedTo),
						gte(attentionEvents.createdAt, windowStart),
					),
				);

			// Clamped over the ELIGIBLE set, so a rejected claim never eats another
			// surface's budget on its way to being dropped.
			const { events: allowed, granted, refused } = clampToWindow(eligible, spent?.total ?? 0);

			if (refused > 0) {
				console.warn(
					`attention clamp: ${viaShareLink ? "share links of " : ""}user ${attributedTo} claimed ${granted + refused}s with ${spent?.total ?? 0}s already credited this window — refused ${refused}s`,
				);
			}

			const rows = allowed.map((e) => ({
				userId: attributedTo,
				creatorId: e.creatorId,
				eventType: e.eventType,
				durationSeconds: e.durationSeconds,
				workId: e.workId ?? null,
				// Zero-duration visit pings carry no Work and draw nothing, so they are
				// never Public Access consumption whatever they point at.
				publicAccess: e.workId != null && (eligibility.get(e.workId)?.publicAccess ?? false),
				viaShareLink,
			}));

			await db.insert(attentionEvents).values(rows);

			// The budget AFTER this batch, so a player can stop at the limit rather than
			// discovering it on the next playlist request. Returned on every write because
			// the client has no other cheap way to know it is close.
			//
			// A share-link recipient is told about the **relay** budget instead, in the same
			// shape so the players need no second branch — and without a reading of the
			// sharer's own ten hours, which are nobody else's business.
			const budget = viaShareLink
				? shareLinkBudgetAsMeter(await loadShareLinkBudget(attributedTo))
				: await loadPublicAccessBudget(attributedTo);

			return c.json({ recorded: rows.length, granted, refused, ineligible, publicAccess: budget });
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
			// LEFT, not inner: `creator_id` is nullable since migration `0031`, because this
			// row is a payment record that outlives the accounts on either side of it. An
			// inner join would silently drop a distribution whose creator has since deleted
			// their account — making Privacy Policy's "one record survives" true in the database and
			// false on the page, which is the same failure shape as the feed dropping
			// tombstoned posts.
			.leftJoin(users, eq(poolDistributions.creatorId, users.id))
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

	// ── Directed allocations ─────────────────────────────────────────────────
	// The budget is the balance the user holds this cycle to direct at creators, and
	// Anthers takes no cut of it. Directing an amount at a creator clears that creator's
	// Badges. (What actually reaches the creator is net of that amount's pro-rata share
	// of the at-cost card fee — see the discrepancy note in `distribute-pool.ts`.)
	//
	// **Amounts are dollars, at any level, to the cent.** The API does not reject
	// non-multiples of anything, because there is no unit left to be a multiple of.
	//
	// ⚠️ This comment was left **half-edited** by the 2026-08-16 retirement and said:
	// "Amounts are whole Seeds: a Seed is an indivisible $3 unit, so an allocation is any
	// amount at all — the API no longer rejects non-multiples, because silently storing a
	// fraction of a Seed." The premise is the old model, the conclusion is the new one,
	// and the last clause has no predicate at all. Worth keeping as a marker: a sweep
	// that rewrites the end of a sentence and not its beginning leaves prose that reads
	// as considered and asserts both models at once.
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
		const budget = Number(acct?.creatorSupportTotal ?? 0);
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
					// 🚨 A `% SEED_PRICE === 0` refinement stood here until 2026-08-16, forcing
					// every allocation onto a $3 step. It went with the unit: a creator sets
					// their own Badge levels to any amount, so refusing $2.50 here would make
					// their own ladder unreachable through this route.
					.refine((v) => Number(v) > 0, { message: "Amount must be more than zero" }),
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
					{ error: "Can only direct support for the current or next billing cycle" },
					400,
				);
			}

			const acct = await getAccount(user.id);
			const budget = Number(acct?.creatorSupportTotal ?? 0);

			if (budget <= 0) {
				return c.json({ error: "You have nothing to give this cycle" }, 400);
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
					return c.json(
						{ error: "Cannot reduce what you have already given in this billing cycle" },
						400,
					);
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
				return c.json({ error: "Exceeds what you are giving this cycle" }, 400);
			}

			if (amountNum === 0) {
				// Remove allocation (only allowed for next month)
				if (cycle === currentCycle) {
					return c.json({ error: "Cannot remove a creator in the current billing cycle" }, 400);
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
				// 🚨 Monthly DOLLARS, both gate types (migration `0041`) — what is given to this
				// creator for `seed`, what is given to Anthers for `anthers_badge`. It was
				// `/^\d+$/` (digits only) until 2026-08-16 on the reasoning that a fractional
				// gate was one no viewer could exactly meet, since Seeds were indivisible. The
				// unit went and so did the reasoning: refusing "9.50" now rejects the levels a
				// creator is most likely to set. Cents, because that is what can be charged.
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
	// Access lives on the Work (the two access tables); resolveAccess is the single
	// source of truth, shared with the content and payment routes.
	.get("/access/:workId", async (c) => {
		const { workId } = c.req.param();
		const currentUserId = await getOptionalUserId(c);

		const [work] = await db
			.select()
			.from(works)
			.where(eq(works.id, Number(workId)))
			.limit(1);
		if (!work) return c.json({ error: "Work not found" }, 404);

		const result = await resolveAccess(work, currentUserId);
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

	// ── Creator Status (for the creator page's Badge + directed-support display) ──
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

		// What the viewer gives Anthers (point-in-time) and what they direct at this creator.
		const anthersSupport = await heldAnthersSupport(currentUserId);
		const badge = heldBadgeName(anthersSupport);
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

		// Both gate types are a dollar threshold — one reads what is given to Anthers, the
		// other what is given to this creator. Same comparison, two amounts, and no
		// conversion between them any more: the ledger, the threshold and the comparison are
		// all in the same unit, which is what removed the reinterpretation hazard.
		const given = supportAmount(seedAmount);
		const unlockedGates = gates
			.filter((g) =>
				amountMeets(g.gateType === "anthers_badge" ? anthersSupport : given, Number(g.threshold)),
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
