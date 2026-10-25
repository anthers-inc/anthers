// SPDX-License-Identifier: Apache-2.0
//
// The creator financials calculator's computation layer — everything the page states
// as a number, computed here, with no JSX and no React. The page
// (`CreatorFinancialsPage`) renders what this returns; the tests beside this file pin
// it to `fees.ts`'s money originals and to the wiki's generated tables.
//
// One page joins the explanation of how creator financials work to a calculator over
// a few high-level inputs — what the creator would host, how many supporters they
// would have, what they would sell — absorbing `/resources/creator-monetization` and
// `/resources/video-storage` (2026-10-18; see the resources revamp task body).
//
// 🚨 **The browser may not import `fees.ts`** — the decimal.js chain. Every money
// operation here goes through the existing display copies (`cardFeeDisplay`,
// `supportBreakdownDisplay` for the whole supporter charge, `storageGibFor` and
// `STORAGE_PER_GIB_MONTH` for the rung arithmetic), each already pinned to its money
// original by `economics.test.ts` — never a second formula. What is pinned HERE is
// this layer's own decisions, and the composition's agreement with the generated tables.
//
// 🚨 **The free account's pool is not in this file.** `timePoolFor(0)` is 0; the free
// tier's pool is the **Time Pool Fund**, a stated share of the charitable remainder
// published monthly by its ledger, fetched browser-side by `lib/time-pool-fund.ts`.
// This layer takes the published slice as an argument (`freeSlicePerAccount: number | null`)
// and answers `null` revenue rows where it is unpublished — a gap rendered as one, not
// an estimate. Per the pool ruling: Root's paid pool is the reference for any per-hour
// comparison the copy makes; the free slice is never a comparison denominator.
//
// 🚨 **Badges are subscription purchases, never gifts** (82.01). A supporter's Badge
// is what they give Anthers; directed support and purchases are given to the creator —
// the verb is give, the noun gift belongs to the giving channel alone.

import {
	ANTHERS_BADGES,
	type BadgeKey,
	badgeLabel,
	cardFeeDisplay,
	FREE_STORAGE_GIB,
	STORAGE_LADDER_GIB,
	STORAGE_PER_GIB_MONTH,
	storageGibFor,
	supportBreakdownDisplay,
} from "@anthers/shared/constants";
import { videoStore } from "../components/calculators/video-model";
import { cent, crossover, storefrontItemReach } from "./media-month";

// ─── The supporter group ───────────────────────────────────────────────────────

/** One group of like supporters — the calculator's whole audience model. */
export interface SupporterGroup {
	/** The Badge they hold — the monthly amount given to Anthers. Free supporters live in the page's free-viewer group, whose pool rides the Fund. */
	badge: Exclude<BadgeKey, "free">;
	/** How many of them. */
	count: number;
	/** Their total monthly time across everything they watch, in hours. */
	hoursTotal: number;
	/** Of that, time with you. */
	hoursYou: number;
	/** What each directs at you per month, $ — rides their own monthly charge and nets its pro-rata slice of the at-cost card fee. */
	directed: number;
}

export interface GroupRow {
	badge: SupporterGroup["badge"];
	/** The Badge's display name. */
	label: string;
	count: number;
	/** Your share of their time, 0..1. */
	share: number;
	/** The pool one supporter of this rung holds — half of what they give Anthers. */
	pool: number;
	/** The pool slice your share of their time earns, per supporter. */
	tpEarn: number;
	/** What their directed support nets you, per supporter. */
	directedNet: number;
	/** What one supporter earns you: pool slice + directed net. */
	perSupporter: number;
	/** The group's monthly revenue. */
	revenue: number;
	/** Hours with you, across the group — the time the revenue is paid against. */
	hoursYou: number;
}

/**
 * One supporter's financials through the checkout's own shape: their Badge amount and
 * their directed support ride ONE monthly charge (`supportBreakdownDisplay` — the whole
 * charge's single at-cost card fee, split pro-rata, the Fee's rounding never shorting
 * the creator); the pool their Badge funds, they split across everything they watch by
 * time — your slice of it is `share × pool`. This is the same model the retired
 * monetization page's engine ran; composing it through the pinned helper rather than a
 * second formula makes the page agree with the generated tables by construction.
 */
export function supporterRow(g: SupporterGroup): GroupRow {
	const safeTotal = g.hoursTotal > 0 ? g.hoursTotal : 0.0001;
	const you = Math.min(g.hoursYou, safeTotal);
	const share = you / safeTotal;
	const breakdown = supportBreakdownDisplay(amountFor(g.badge), g.directed);
	// The creator half of the Badge amount; the Anthers-side fee share never touches it.
	// ⚠️ **This is the by-time pool at its best case**, because it counts the supporter's
	// whole Sticker budget as rolling into time distribution — true for a supporter who
	// hands out no Stickers, which is most of them, and an overcount for one who does.
	// Stickers reach creators by the giver's hand, so no split by time can attribute them;
	// the dashboard estimates the time channel and cannot claim the directed one.
	const pool = breakdown.timePool;
	const tpEarn = cent(share * pool);
	const directedNet = breakdown.directedNet;
	const perSupporter = cent(tpEarn + directedNet);
	return {
		badge: g.badge,
		label: badgeLabel(g.badge),
		count: Math.max(0, Math.round(g.count)),
		share,
		pool,
		tpEarn,
		directedNet,
		perSupporter,
		revenue: cent(perSupporter * Math.max(0, Math.round(g.count))),
		hoursYou: you * Math.max(0, Math.round(g.count)),
	};
}

function amountFor(badge: SupporterGroup["badge"]): number {
	const def = ANTHERS_BADGES.find((b) => b.name === badge);
	if (!def) throw new Error(`creator-financials: no Badge named ${badge}`);
	return def.threshold;
}

// ─── Free viewers — the Fund's published slice ─────────────────────────────────

export interface FreeViewerGroup {
	/** How many free accounts spend time with you in the month. */
	count: number;
	hoursTotal: number;
	hoursYou: number;
	/** What each directs at you per month, $ — a free account rides no Badge, so this is their whole monthly charge when given, and it nets the full pro-rata card fee of it. */
	directed?: number;
}

export interface FreeViewerRow {
	count: number;
	share: number;
	/** The Fund's published per-account slice, or null while it is unpublished — never a fallback number. */
	slicePerAccount: number | null;
	/** The pool slice your share of a free account's time earns, per account — null when the slice is unpublished. */
	earnPerViewer: number | null;
	/** What their directed support nets you, per account. */
	directedNet: number;
	/** The group's monthly revenue — null while the slice is unpublished (their directed support alone is then not stated either, as one gap). */
	revenue: number | null;
	hoursYou: number;
}

/**
 * A free account's stream of your Public Access work pays from the **Time Pool Fund**
 * — Anthers' pool for free accounts, a stated share of the charitable remainder
 * after the admin budget, published monthly and divided across the cycle's active
 * free accounts. What the Fund pays is runtime data; where it is unpublished this
 * row is a stated gap, and the page totals it as one. Their directed support is their
 * own charge: everything past its at-cost card fee reaches you — the lone-worst case
 * ($3 on a bare account) is `DIRECTED_SUPPORT_WORST_CASE`, and the copy quotes it.
 */
export function freeViewerRow(g: FreeViewerGroup, slicePerAccount: number | null): FreeViewerRow {
	const safeTotal = g.hoursTotal > 0 ? g.hoursTotal : 0.0001;
	const you = Math.min(g.hoursYou, safeTotal);
	const share = you / safeTotal;
	const count = Math.max(0, Math.round(g.count));
	const directedNet = supportBreakdownDisplay(0, Math.max(0, g.directed ?? 0)).directedNet;
	const earn = slicePerAccount === null ? null : cent(share * slicePerAccount);
	return {
		count,
		share,
		slicePerAccount,
		earnPerViewer: earn,
		directedNet,
		revenue: earn === null ? null : cent((earn + directedNet) * count),
		hoursYou: you * count,
	};
}

// ─── Purchases ─────────────────────────────────────────────────────────────────

export interface SalesCase {
	/** The list price of the Work. */
	price: number;
	/** Buyers a month. */
	buyers: number;
	/** The at-cost card fee per charge. */
	card: number;
	/** What reaches you per sale on Anthers — each purchase is its own charge. */
	reachAnthers: number;
	/** What reaches per sale on a percentage-cut storefront pricing the same item. */
	reachStorefront: number;
	/** True below the computed crossover: the storefront wins outright, conceded rather than hidden. */
	storefrontWins: boolean;
}

/**
 * A purchase is its own charge, each sale settling separately — the at-cost card fee
 * sits inside the price, and everything past it reaches you. Rival side: a percentage
 * cut that absorbs its processing, at the published 30%; the computed crossover is
 * where the two agree, and below it that storefront wins — conceded, as every losing
 * case on a calculator is.
 */
export function salesCase(price: number, buyers: number): SalesCase {
	const card = cardFeeDisplay(price);
	const reachAnthers = cent(price - card);
	const reachStorefront = storefrontItemReach(price);
	const n = Math.max(0, Math.round(buyers));
	return {
		price,
		buyers: n,
		card,
		reachAnthers,
		reachStorefront,
		storefrontWins: price < crossover(),
	};
}

// ─── Storage — rung arithmetic, every stored byte above the allowance billed ────

/** The allowance a Badge's holder gets, in GiB — the free floor for absent Badges. */
export function allowanceOf(badge: BadgeKey): number {
	return badge === "free" ? FREE_STORAGE_GIB : storageGibFor(amountFor(badge));
}

/**
 * The at-cost storage charge for bytes past an account's allowance, in float
 * display arithmetic. **The money version is `estimateStorageCost` in `fees.ts`**
 * (ROUND_HALF_UP over the overflow × the vendor rate); this copies its cent rounding
 * exactly and `creator-financials.test.ts` pins the two together across a grid.
 * Free accounts are not top-up eligible — their bytes past the floor bill to nobody
 * here, and hosting past the floor is what Root is for.
 */
export function storageCostDisplay(
	badge: BadgeKey,
	gib: number,
): { allowance: number; billableGiB: number; monthly: number; eligible: boolean } {
	const allowance = allowanceOf(badge);
	const eligible = allowance > STORAGE_LADDER_GIB.free;
	const billable = eligible ? Math.max(0, gib - allowance) : 0;
	const monthly = Math.round(billable * STORAGE_PER_GIB_MONTH * 100 + 1e-6) / 100;
	return { allowance, billableGiB: billable, monthly, eligible };
}

/**
 * The smallest rung whose bundled allowance carries a catalog of `gib` — Free's
 * floor, then the ladder upward — and the top-up bytes when only the top rung plus
 * top-up can hold it.
 */
export function rungCarrying(gib: number): {
	badge: BadgeKey;
	allowance: number;
	/** Present only past the top rung: the bytes above Blossom's allowance and their at-cost monthly charge. */
	topUp?: { gib: number; monthly: number };
} {
	for (const badge of ["free", ...ANTHERS_BADGES.map((b) => b.name)] as BadgeKey[]) {
		const allowance = allowanceOf(badge);
		if (gib <= allowance) return { badge, allowance };
	}
	const top = allowanceOf("blossom");
	const excess = gib - top;
	return {
		badge: "blossom",
		allowance: top,
		topUp: { gib: excess, monthly: Math.round(excess * STORAGE_PER_GIB_MONTH * 100 + 1e-6) / 100 },
	};
}

/** The at-cost rate as the page's copy states it — off the dial, never retyped. */
export const STORAGE_RATE = STORAGE_PER_GIB_MONTH;

// ─── Video catalog sizing — the ladder model, reused ───────────────────────────

export interface VideoSizing {
	res: "720p" | "1080p" | "1440p" | "2160p";
	fps: 24 | 30 | 60;
	master: "h264" | "h265" | "prores" | "custom";
	/** For `custom` masters: the observed upload bitrate, video only. */
	masterMbps: number;
}

export interface CatalogVideo {
	masterGiB: number;
	ladderGiB: number;
	totalGiB: number;
	/** The master's share of the store, 0..1 — the notes quote it. */
	masterShare: number;
}

/**
 * What Anthers stores for `hours` of uploaded video: the original master kept
 * as-is, plus the whole AV1 ladder from the master's resolution down to 240p30 —
 * `videoStore` in the shared ladder model, which the signup matrix and the
 * marketing prose read too. One model, no second copy.
 */
export function videoCatalog(v: VideoSizing, hours: number): CatalogVideo {
	const safe = Math.max(0, hours);
	const { masterGiB, ladderGiB } = videoStore(
		v.res,
		v.fps,
		v.master === "custom" ? "h264" : v.master,
		v.master === "custom" ? v.masterMbps : undefined,
	);
	const total = masterGiB + ladderGiB;
	return {
		masterGiB: masterGiB * safe,
		ladderGiB: ladderGiB * safe,
		totalGiB: total * safe,
		masterShare: safe === 0 ? 0 : masterGiB / total,
	};
}
