// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Access & entitlement resolution — the one place that answers
 * "may this user consume this Work, and if not, what does it cost?"
 *
 * The subject is a **Work**, not a Post (migration `0010`). Gates used to hang off the
 * Post, but a Work could be referenced from any number of Posts and inherited each one's
 * gates independently — so the same bytes were genuinely free via one Post and gated via
 * another, resolved per URL. A gate belongs to the thing being gated. A Post's reference
 * to a Work is inert and confers nothing; see `40.08 Catalog and Posts` in the vault.
 *
 * Access is expressed by two per-Work tables (see `packages/db/src/schema/content.ts`),
 * and since migration `0007` they are the SAME row shape — `{ threshold, allow, price }`,
 * where `threshold` is **whole Seeds**:
 *   - `anthersAccess`: threshold = Anthers-Seeds the viewer currently holds
 *   - `seedAccess`:    threshold = Seeds the viewer has given THIS creator this cycle
 *
 * That is the whole difference: one primitive — a Seed threshold — pointed at two
 * entities. So there is one comparison here, `seedsMeet`, applied to two counts, rather
 * than a rank ladder for one table and a dollar figure for the other.
 *
 * A viewer *qualifies* for a row when they meet its threshold. Access is the **OR**
 * across BOTH tables: among the rows the viewer qualifies for AND that are allowed, the
 * cheapest price wins. price 0 = free; a positive price = a one-time purchase that
 * unlocks the Work's enabled delivery (stream and/or download — one price unlocks both).
 * No qualifying allowed row is a hard gate. Works ship "free but fully locked" (every
 * row allow=false).
 *
 * The Anthers Gate is point-in-time — the viewer must *currently hold* the Seeds
 * (`accounts.anthersSeeds`); there is no trailing-spend window. Resolution reads three
 * viewer facts — Anthers-Seeds held, per-creator Seeds this cycle, and prior purchases —
 * which `buildAccessContext` loads once so a batch (a Catalog page) resolves without an N+1.
 *
 * Note a gate need not sit on a Badge. Thresholds are levels, not Badge identities, so a
 * creator may gate at 3 Seeds whether or not they have named a Badge there.
 */

import { db } from "@anthers/db/client";
import type { AccessRow, AnthersAccessRow, SeedAccessRow } from "@anthers/db/schema";
import { accounts, purchases, seedAllocations } from "@anthers/db/schema";
import { ANTHERS_BADGES, seedCost, seedsFromDollars, seedsMeet } from "@anthers/shared/constants";
import { and, eq, inArray } from "drizzle-orm";

/** The thresholds a default Anthers table carries: everyone (0) plus each Anthers Badge. */
const ANTHERS_THRESHOLDS = [0, ...ANTHERS_BADGES.map((b) => b.threshold)];

/** The Work fields access resolution depends on (structurally satisfied by a full work row). */
export interface AccessibleWork {
	id: number;
	creatorId: number;
	streamEnabled: boolean;
	downloadEnabled: boolean;
	anthersAccess: AnthersAccessRow[] | null;
	seedAccess: SeedAccessRow[] | null;
}

/** Viewer facts needed to resolve access, loaded once and reused across a batch of Works. */
export interface AccessContext {
	userId: number | null;
	/**
	 * Anthers-Seeds the viewer *currently holds* (point-in-time).
	 *
	 * A raw count, not a Badge name: a gate is a threshold, and thresholds exist at levels
	 * no Badge is named for. Collapsing to the held Badge first would quantise the viewer
	 * down to the nearest named rung and silently deny them gates they actually clear.
	 */
	anthersSeeds: number;
	/** creatorId → whole Seeds the viewer has given to that creator this cycle */
	seedByCreator: Map<number, number>;
	/** Work ids the viewer has a completed purchase for */
	purchasedWorkIds: Set<number>;
}

export type AccessReason =
	| "owner"
	| "free"
	| "purchased"
	| "entitled"
	| "payment_required"
	| "gated"
	| "login_required";

/**
 * One way a denied viewer could open this Work, stated in the gate's own terms.
 *
 * `moreNeeded` is the point of this type: the UI must be able to say what the viewer
 * still needs, not what the gate abstractly requires, and it must not compute that
 * itself. The client used to derive its own label from the threshold and got it wrong —
 * naming the highest Badge at-or-below the gate, which by definition does *not* clear a
 * gate that sits above it. Resolution owns the thresholds, so resolution owns this.
 */
export interface UnlockRoute {
	/** Whole Seeds this gate requires. */
	threshold: number;
	/** Whole Seeds the viewer still has to add — the marginal ask. */
	moreNeeded: number;
	/** Monthly cost of holding `threshold` Seeds, as a money string. */
	price: string;
	/**
	 * The Badge sitting EXACTLY at this threshold, or null when the gate sits between
	 * Badges (which is legal — a gate needn't sit on a Badge). Never the nearest Badge:
	 * naming one the viewer would still be short of is the bug this type exists to kill.
	 *
	 * A plain `string`, not `BadgeKey`: `BadgeKey` covers only Anthers' own four, and a
	 * creator names their Badges whatever they like. Only the Anthers side is populated
	 * today, but typing it to Anthers' set would have to be undone the moment it isn't.
	 */
	badge: string | null;
}

/**
 * How a gated Work could be opened, per destination. Null routes mean that side offers
 * no path in — a Work gated only on Seeds to the creator has no `anthers` route, and one
 * whose only allowed rows carry a price can have neither, because reaching the threshold
 * would still not open it.
 */
export interface UnlockOffer {
	/** Climb by giving more Seeds to Anthers. */
	anthers: UnlockRoute | null;
	/** Climb by giving more Seeds to this creator. */
	creator: UnlockRoute | null;
}

export interface AccessResult {
	/** May the viewer consume the Work now? */
	canAccess: boolean;
	reason: AccessReason;
	/**
	 * Present only when the viewer is shut out by a gate (`gated`), and only for routes
	 * that genuinely open the Work. Absent for purchase (ProjectPricing owns that) and,
	 * necessarily, for a logged-out viewer, whose standing we don't know.
	 */
	unlock?: UnlockOffer;
	/** Accessible to everyone at no cost. */
	isFree: boolean;
	/** A (one-time) purchase is the path to access. */
	requiresPurchase: boolean;
	/** Minimum price to unlock via purchase (money string), or null when free/gated. */
	price: string | null;
	/** Viewer qualifies via an allowed Badge/Seed row (a gate), even if a price still applies. */
	isEntitled: boolean;
	streamEnabled: boolean;
	downloadEnabled: boolean;
}

/** First day of the current month, `YYYY-MM-DD` — the billing-cycle key used across the app. */
export function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

/**
 * Anthers-Seeds a user currently holds — what gate resolution actually compares against.
 *
 * Deliberately NOT routed through the held Badge. A Badge is the highest threshold you
 * meet, so collapsing to it first would round a 3-Seed viewer down to a 2-Seed Badge and
 * deny them a 3-Seed gate they genuinely clear. Resolve on the count; name the Badge only
 * for display.
 */
export async function heldAnthersSeeds(userId: number): Promise<number> {
	const [row] = await db
		.select({ anthersSeeds: accounts.anthersSeeds })
		.from(accounts)
		.where(eq(accounts.userId, userId))
		.limit(1);
	return Math.max(0, Math.floor(Number(row?.anthersSeeds ?? 0)));
}

export { seedsFromDollars };

function money(n: number): string {
	return (Math.round(n * 100) / 100).toFixed(2);
}

/** An allowed row the viewer qualifies for: its numeric price and whether it's a baseline (everyone) row. */
interface Offer {
	price: number;
	baseline: boolean;
}

/**
 * The allowed rows a viewer holding `heldSeeds` qualifies for.
 *
 * **One function for both tables.** The Anthers table and the Seed table differ only in
 * which Seed count is passed in — Anthers-Seeds held, or Seeds given to this creator —
 * so they cannot drift apart in how they decide, only in what they are asked about.
 */
function offersFor(rows: AccessRow[], heldSeeds: number): Offer[] {
	const offers: Offer[] = [];
	for (const row of rows) {
		if (!row.allow) continue;
		const threshold = Number(row.threshold ?? 0);
		if (!seedsMeet(heldSeeds, threshold)) continue;
		offers.push({ price: Number(row.price ?? "0"), baseline: threshold <= 0 });
	}
	return offers;
}

/**
 * The cheapest rung in one table that would actually OPEN the Work for this viewer.
 *
 * "Actually open" is the whole subtlety: only a row that is both allowed **and free**
 * qualifies. An allowed row carrying a price doesn't become access when you reach its
 * threshold — it becomes a purchase — so offering it as an unlock route would promise
 * something climbing cannot deliver. Returns null when the table offers no such rung.
 */
export function unlockRoute(
	rows: AccessRow[],
	heldSeeds: number,
	badges: readonly { name: string; threshold: number }[],
): UnlockRoute | null {
	let best: number | null = null;
	for (const row of rows) {
		if (!row.allow) continue;
		if (Number(row.price ?? "0") > 0) continue;
		const threshold = Number(row.threshold ?? 0);
		if (seedsMeet(heldSeeds, threshold)) continue; // already met — not a route in
		if (best === null || threshold < best) best = threshold;
	}
	if (best === null) return null;
	// Exact match only. The nearest Badge at-or-below would not clear this gate, and
	// naming it is precisely the error this replaces.
	const badge = badges.find((b) => b.threshold === best) ?? null;
	return {
		threshold: best,
		moreNeeded: Math.max(0, best - heldSeeds),
		price: money(seedCost(best)),
		badge: badge?.name ?? null,
	};
}

/**
 * Resolve access for a single Work against an already-loaded viewer context.
 * Pure and synchronous, so a Catalog page resolves a batch cheaply.
 */
export function resolveAccessSync(work: AccessibleWork, ctx: AccessContext): AccessResult {
	const base = {
		isFree: false,
		requiresPurchase: false,
		price: null as string | null,
		isEntitled: false,
		streamEnabled: work.streamEnabled,
		downloadEnabled: work.downloadEnabled,
	};

	// Creators always see their own content.
	if (ctx.userId != null && ctx.userId === work.creatorId) {
		return { ...base, canAccess: true, reason: "owner" };
	}

	// A prior purchase unlocks it permanently.
	if (ctx.purchasedWorkIds.has(work.id)) {
		return { ...base, canAccess: true, reason: "purchased" };
	}

	// The same comparison, twice — once against Anthers-Seeds held, once against Seeds
	// given to this creator. OR across both: qualifying anywhere is qualifying.
	const givenSeeds = ctx.seedByCreator.get(work.creatorId) ?? 0;

	const offers = [
		...offersFor(work.anthersAccess ?? [], ctx.anthersSeeds),
		...offersFor(work.seedAccess ?? [], givenSeeds),
	];

	// No qualifying allowed row → hard gate. Report what would open it, from here.
	if (offers.length === 0) {
		if (ctx.userId == null) return { ...base, canAccess: false, reason: "login_required" };
		return {
			...base,
			canAccess: false,
			reason: "gated",
			unlock: {
				anthers: unlockRoute(work.anthersAccess ?? [], ctx.anthersSeeds, ANTHERS_BADGES),
				// No Badge set: a creator's Badges are their own rows, not carried on the Work
				// (thresholds are levels, not Badge identities — migration 0007). The creator's
				// name is the identity the UI shows on this side, so it needs no Badge here.
				creator: unlockRoute(work.seedAccess ?? [], givenSeeds, []),
			},
		};
	}

	// Qualifies via a non-baseline (Badge/Seed) row → "entitled" for display.
	const isEntitled = offers.some((o) => !o.baseline);

	// Free when any qualifying allowed row is priced at/below 0.
	if (offers.some((o) => o.price <= 0)) {
		const universallyFree = offers.some((o) => o.baseline && o.price <= 0);
		return {
			...base,
			canAccess: true,
			reason: universallyFree ? "free" : "entitled",
			isFree: universallyFree,
			isEntitled,
		};
	}

	// Purchasable: cheapest qualifying allowed price unlocks the enabled delivery.
	const min = Math.min(...offers.map((o) => o.price));
	return {
		...base,
		canAccess: false,
		reason: "payment_required",
		requiresPurchase: true,
		price: money(min),
		isEntitled,
	};
}

/**
 * Load the viewer facts needed to resolve access. Pass the Work ids in view to
 * scope the purchase lookup; omit for "all of the viewer's purchases".
 */
export async function buildAccessContext(
	userId: number | null,
	opts: { workIds?: number[] } = {},
): Promise<AccessContext> {
	if (userId == null) {
		return {
			userId: null,
			anthersSeeds: 0,
			seedByCreator: new Map(),
			purchasedWorkIds: new Set(),
		};
	}

	const cycle = currentBillingCycle();
	const scoped = opts.workIds && opts.workIds.length > 0;

	const [anthersSeeds, seedRows, purchaseRows] = await Promise.all([
		heldAnthersSeeds(userId),
		db
			.select({ creatorId: seedAllocations.creatorId, amount: seedAllocations.amount })
			.from(seedAllocations)
			.where(and(eq(seedAllocations.userId, userId), eq(seedAllocations.billingCycle, cycle))),
		db
			.select({ workId: purchases.workId })
			.from(purchases)
			.where(
				and(
					eq(purchases.buyerId, userId),
					eq(purchases.status, "completed"),
					...(scoped ? [inArray(purchases.workId, opts.workIds as number[])] : []),
				),
			),
	]);

	// `seed_allocations.amount` is MONEY and stays money — it is the payment ledger, not a
	// gate. Gates count Seeds, so the dollars are divided here, at the one boundary where
	// the two meet, rather than by every caller that compares against a threshold.
	const seedByCreator = new Map<number, number>();
	for (const s of seedRows) {
		seedByCreator.set(s.creatorId, seedsFromDollars(s.amount));
	}

	return {
		userId,
		anthersSeeds,
		seedByCreator,
		// Seed one-time charges have a null workId — only real Work purchases unlock.
		purchasedWorkIds: new Set(
			purchaseRows.map((p) => p.workId).filter((id): id is number => id !== null),
		),
	};
}

// `isPubliclyFree(post)` used to live here, documented as driving storage-ACL decisions
// in the media jobs. It never had a call site and never could: the jobs run when a Work
// is uploaded to the Catalog, before it is released or gated, so there is no access table
// to evaluate — and a Work's access can change after the transcode anyway, which would
// leave a baked-in ACL wrong. The settled answer is the opposite shape: store every
// derived media object private, and sign per request at the delivery endpoints, where
// access is re-resolved live. See `deliveryCtxFor` in routes/content.ts.

/** Convenience: resolve access for a single Work (loads its own context). */
export async function resolveAccess(
	work: AccessibleWork,
	userId: number | null,
): Promise<AccessResult> {
	const ctx = await buildAccessContext(userId, { workIds: [work.id] });
	return resolveAccessSync(work, ctx);
}

/**
 * Default access tables for a freshly created Work: every row present but locked
 * (allow=false, price "0") — "free but fully locked". The creator opts access in.
 */
export function defaultAnthersAccess(): AnthersAccessRow[] {
	return ANTHERS_THRESHOLDS.map((threshold) => ({ threshold, allow: false, price: "0" }));
}

/** Default Seed table = just the $0 "everyone" baseline row, locked. Ladder rungs are added by the creator. */
export function defaultSeedAccess(): SeedAccessRow[] {
	return [{ threshold: 0, allow: false, price: "0" }];
}
