// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access & entitlement resolution — the one place that answers
 * "may this user consume this post, and if not, what does it cost?"
 *
 * The unified Post model expresses access with a small set of orthogonal
 * columns (see `packages/db/src/schema/content.ts` and the design doc
 * "30.1 - Unified Post & Content Model"):
 *
 *   - basePrice (null = free) + pricingMode (fixed | pwyw) + minPrice/suggestedPrice
 *   - entitlementKind (null | tier | boost) + entitlementTier/entitlementBoostThreshold
 *   - entitlementDiscountPct (0..100; 100 = free for entitled users)
 *   - purchasableWithoutEntitlement (false = gated; true = anyone can buy)
 *
 * The combinations map cleanly onto real cases:
 *   - free:                 basePrice null, entitlementKind null
 *   - simple paid:          basePrice set, entitlementKind null
 *   - subscriber-or-buy:    basePrice set, entitlementKind tier, discount 100, purchasable true
 *   - subscriber discount:  basePrice set, entitlementKind tier, discount <100, purchasable true
 *   - gated (subs-only):    entitlementKind set, purchasable false
 *
 * Resolution reads three viewer facts — subscription, per-creator boost this
 * cycle, and prior purchases — which `buildAccessContext` loads once so a batch
 * (the timeline) resolves without an N+1.
 */

import { db } from "@anthers/db/client";
import { boostAllocations, purchases, subscriptions } from "@anthers/db/schema";
import { and, eq, inArray } from "drizzle-orm";

/** Minimum whole-dollar monthly funding each Anthers tier requires. */
export const TIER_MIN_FUNDING: Record<string, number> = {
	free: 0,
	root: 3,
	sprout: 7,
	petal: 15,
	bloom: 30,
};

/** The post fields access resolution depends on (structurally satisfied by a full post row). */
export interface AccessiblePost {
	id: number;
	creatorId: number;
	basePrice: string | null;
	pricingMode: string;
	minPrice: string | null;
	suggestedPrice: string | null;
	entitlementKind: string | null;
	entitlementTier: string | null;
	entitlementBoostThreshold: string | null;
	entitlementDiscountPct: number | null;
	purchasableWithoutEntitlement: boolean;
}

/** Viewer facts needed to resolve access, loaded once and reused across a batch of posts. */
export interface AccessContext {
	userId: number | null;
	subscription: { tier: string; fundingLevel: number; isActive: boolean } | null;
	/** creatorId → boost amount allocated to that creator this billing cycle */
	boostByCreator: Map<number, number>;
	/** post ids the viewer has a completed purchase for */
	purchasedPostIds: Set<number>;
}

export type AccessReason =
	| "owner"
	| "free"
	| "purchased"
	| "entitled"
	| "gated"
	| "payment_required"
	| "login_required";

export interface AccessResult {
	/** May the viewer consume the content now? */
	canAccess: boolean;
	reason: AccessReason;
	/** True when there is no gate and nothing to pay. */
	isFree: boolean;
	/** True when a (possibly discounted) purchase is the path to access. */
	requiresPurchase: boolean;
	/** Effective amount to unlock via purchase, or the suggested amount for a free-but-supportable post. Null otherwise. */
	price: string | null;
	/** Sticker price (pre-discount), for display. */
	basePrice: string | null;
	pricingMode: string;
	minPrice: string | null;
	suggestedPrice: string | null;
	entitlementKind: string | null;
	entitlementDiscountPct: number | null;
	/** Does the viewer meet the post's entitlement requirement (subscription tier / boost)? */
	isEntitled: boolean;
}

/** First day of the current month, `YYYY-MM-DD` — the billing-cycle key used across the app. */
export function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function clampPct(pct: number | null | undefined): number {
	const n = pct ?? 0;
	return Math.max(0, Math.min(100, n));
}

function money(n: number): string {
	return (Math.round(n * 100) / 100).toFixed(2);
}

/** The minimum a non-entitled viewer must pay to access (0 = freely accessible). */
function priceFloor(post: AccessiblePost): number {
	if (post.pricingMode === "pwyw") return Number(post.minPrice ?? "0");
	return Number(post.basePrice ?? "0");
}

/** The price to surface for display / an optional support prompt. */
function stickerPrice(post: AccessiblePost): string | null {
	if (post.pricingMode === "pwyw") return post.suggestedPrice ?? post.minPrice ?? null;
	return post.basePrice ?? null;
}

/** Does the viewer meet the post's entitlement requirement? */
function meetsEntitlement(post: AccessiblePost, ctx: AccessContext): boolean {
	if (!post.entitlementKind) return false;

	if (post.entitlementKind === "tier") {
		const sub = ctx.subscription;
		if (!sub || !sub.isActive || sub.tier === "free") return false;
		if (post.entitlementTier) {
			const need = TIER_MIN_FUNDING[post.entitlementTier] ?? 0;
			return sub.fundingLevel >= need;
		}
		return true; // any active paid subscription
	}

	if (post.entitlementKind === "boost") {
		const have = ctx.boostByCreator.get(post.creatorId) ?? 0;
		const need = Number(post.entitlementBoostThreshold ?? "0");
		return have >= need;
	}

	return false;
}

/**
 * Resolve access for a single post against an already-loaded viewer context.
 * Pure and synchronous, so the timeline can resolve a batch cheaply.
 */
export function resolveAccessSync(post: AccessiblePost, ctx: AccessContext): AccessResult {
	const pricingMode = post.pricingMode ?? "fixed";
	const floor = priceFloor(post);
	const sticker = stickerPrice(post);
	const hasEntitlement = !!post.entitlementKind;
	const isEntitled = meetsEntitlement(post, ctx);
	const isFree = !hasEntitlement && floor <= 0;

	const base = {
		isFree,
		requiresPurchase: false,
		price: null as string | null,
		basePrice: post.basePrice ?? null,
		pricingMode,
		minPrice: post.minPrice ?? null,
		suggestedPrice: post.suggestedPrice ?? null,
		entitlementKind: post.entitlementKind ?? null,
		entitlementDiscountPct: post.entitlementDiscountPct ?? null,
		isEntitled,
	};

	// Creators always see their own content.
	if (ctx.userId != null && ctx.userId === post.creatorId) {
		return { ...base, canAccess: true, reason: "owner" };
	}

	// A prior purchase unlocks it permanently.
	if (ctx.purchasedPostIds.has(post.id)) {
		return { ...base, canAccess: true, reason: "purchased" };
	}

	// Free for everyone (pwyw with a $0 floor still lands here — accessible, optionally supportable).
	if (isFree) {
		return { ...base, canAccess: true, reason: "free", price: sticker };
	}

	if (hasEntitlement) {
		if (isEntitled) {
			const discount = clampPct(post.entitlementDiscountPct);
			// Entitlement grants free access when there's nothing to pay or the discount is total.
			if (floor <= 0 || discount >= 100) {
				return { ...base, canAccess: true, reason: "entitled" };
			}
			// Entitled, but a discounted purchase is still required to unlock.
			return {
				...base,
				canAccess: false,
				reason: "payment_required",
				requiresPurchase: true,
				price: money((floor * (100 - discount)) / 100),
			};
		}

		// Not entitled and there's no purchase path → hard gate.
		if (!post.purchasableWithoutEntitlement) {
			return {
				...base,
				canAccess: false,
				reason: ctx.userId != null ? "gated" : "login_required",
			};
		}
		// Otherwise fall through: a non-entitled viewer may buy at full price.
	}

	// Purchasable paid content.
	return {
		...base,
		canAccess: false,
		reason: "payment_required",
		requiresPurchase: true,
		price: sticker ?? money(floor),
	};
}

/**
 * Load the viewer facts needed to resolve access. Pass the post ids in view to
 * scope the purchase lookup; omit for "all of the viewer's purchases".
 */
export async function buildAccessContext(
	userId: number | null,
	opts: { postIds?: number[] } = {},
): Promise<AccessContext> {
	if (userId == null) {
		return {
			userId: null,
			subscription: null,
			boostByCreator: new Map(),
			purchasedPostIds: new Set(),
		};
	}

	const cycle = currentBillingCycle();
	const scoped = opts.postIds && opts.postIds.length > 0;

	const [subRows, boostRows, purchaseRows] = await Promise.all([
		db
			.select({
				tier: subscriptions.tier,
				fundingLevel: subscriptions.fundingLevel,
				isActive: subscriptions.isActive,
			})
			.from(subscriptions)
			.where(eq(subscriptions.userId, userId))
			.limit(1),
		db
			.select({ creatorId: boostAllocations.creatorId, amount: boostAllocations.amount })
			.from(boostAllocations)
			.where(
				and(eq(boostAllocations.userId, userId), eq(boostAllocations.billingCycle, cycle)),
			),
		db
			.select({ postId: purchases.postId })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, userId),
					eq(purchases.status, "completed"),
					...(scoped ? [inArray(purchases.postId, opts.postIds as number[])] : []),
				),
			),
	]);

	const sub = subRows[0];
	const boostByCreator = new Map<number, number>();
	for (const b of boostRows) {
		boostByCreator.set(b.creatorId, Number(b.amount));
	}

	return {
		userId,
		subscription: sub
			? { tier: sub.tier, fundingLevel: sub.fundingLevel, isActive: sub.isActive ?? false }
			: null,
		boostByCreator,
		purchasedPostIds: new Set(purchaseRows.map((p) => p.postId)),
	};
}

/** Convenience: resolve access for a single post (loads its own context). */
export async function resolveAccess(
	post: AccessiblePost,
	userId: number | null,
): Promise<AccessResult> {
	const ctx = await buildAccessContext(userId, { postIds: [post.id] });
	return resolveAccessSync(post, ctx);
}
