// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The growth-ladder model: what Anthers' books look like at a given scale, and the
 * account totals at which each staffing level becomes affordable.
 *
 * **Why this exists.** Until 2026-08-16 this model lived *only* in a retired HTML
 * playground in the vault's Graveyard. 61.01 carried its output as hand-typed derived
 * figures, said so in its own standing instruction, and rotted twice in three days —
 * once when R2 removed delivery cost, once when the Public Access model changed the free
 * tier. Re-deriving a landmark meant reviving a file that had been retired, which is
 * precisely the situation retiring it was meant to end.
 *
 * **`fees.ts` is upstream of this and 61.01 is upstream of the ladder.** Every per-user
 * money term comes from `anthersSupportBreakdown`, so a dial move in `constants.ts` reaches
 * the landmarks without anyone remembering to re-run anything. The rungs themselves are
 * **policy** — chosen in 61.01, copied here, and if the two ever disagree 61.01 is right.
 *
 * ## Floats, deliberately, and where the line is
 *
 * The per-user money is `Decimal` and comes from `fees.ts`. Everything above that — the
 * population, the sweep, the ratios — is plain `number`. This is not a relaxation of the
 * "all financial values use decimal.js" rule: that rule is about money that moves through
 * somebody's account, and nothing here does. This is a **sizing** model over a modeled
 * population, and its output is a crossover found by bisection, which has no exact answer
 * to round correctly. Exact arithmetic on a forecast would be false precision at a real
 * cost in legibility.
 *
 * ## Scope — Anthers' own books only
 *
 * What Anthers subsidizes (free accounts' Time Pool, free creators' storage, the Public
 * Access storage exemption) and what it takes in (support given to Anthers, paying creators'
 * storage charge). **Directed support and direct purchases are deliberately absent**: Anthers
 * keeps $0 of either, so they cannot move any line here. That is 11.02's decoupling, and
 * it is why a creator-heavy, purchase-heavy Anthers can look successful while the budget
 * that funds free access stays thin.
 */
import {
	AFF_INFRA_RATE,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	PUBLIC_ACCESS_PRICE,
	STORAGE_PER_GIB_MONTH,
} from "./constants.js";
import { anthersSupportBreakdown, paymentsSplit } from "./fees.js";

// ── The ladder (policy — canonical in 61.01, mirrored here) ──────────────────
/**
 * Each rung's **account ceiling**. Chosen, not derived — which is what makes them safe to
 * quote — under the rule 61.01 recovered: *a rung's ceiling is where the NEXT rung's
 * staffing becomes affordable.* You may not open a phase until you can pay for it.
 */
export const PHASE_ACCOUNTS: readonly number[] = [
	100, 250, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 35_000, 80_000, 200_000, 400_000, 2_000_000,
];

export interface Staffing {
	/** Salaries and stipends. */
	staff: number;
	tooling: number;
	services: number;
}

/**
 * What each rung PLANS to spend, which is deliberately **not** what it can afford.
 *
 * Keeping the two apart is the whole point: set the plan equal to the ceiling and the model
 * can only ever confirm itself. Rungs 1–3 are underwater on purpose — that is Parker's own
 * subsidy, and the honest thing is for the model to show it rather than to size the plan to
 * hide it. The later rungs deliberately spend well under their ceiling so Admin's share
 * *declines* with scale, which is the design target the wiki's *How the Programs Are Funded*
 * states.
 */
export const PHASE_OVERHEAD: readonly Staffing[] = [
	{ staff: 0, tooling: 0, services: 0 },
	{ staff: 0, tooling: 0, services: 0 },
	{ staff: 0, tooling: 0, services: 0 },
	{ staff: 0, tooling: 0, services: 0 },
	{ staff: 0, tooling: 50, services: 0 },
	{ staff: 0, tooling: 100, services: 50 },
	{ staff: 800, tooling: 100, services: 100 }, // a token stipend
	{ staff: 1_800, tooling: 150, services: 150 }, // part-time
	{ staff: 3_600, tooling: 200, services: 200 }, // most-of-the-time
	{ staff: 6_700, tooling: 250, services: 200 }, // INFLECTION 1 — full-time, ~$80k/yr all-in
	{ staff: 15_000, tooling: 500, services: 1_500 }, // INFLECTION 2 — full-time ED + one hire
	{ staff: 35_000, tooling: 2_000, services: 5_000 },
	{ staff: 70_000, tooling: 4_000, services: 10_000 },
];

/** The rung a landmark is measured against, 1-based as 61.01 numbers them. */
export const staffingForPhase = (phase: number): Staffing => PHASE_OVERHEAD[phase - 1];

/** No salary, no tooling, no services — the "does it cost Parker money" baseline. */
export const NO_STAFFING: Staffing = { staff: 0, tooling: 0, services: 0 };

/** Board policy (11.02): Admin ≤ 30% of charitable revenue — the CharityNavigator line. */
export const ADMIN_CEILING = 0.3;

/**
 * One aggregate budget line for the Public Access incentives, as a share of charitable
 * revenue. Each incentive clearing its own bar is **not** sufficient — a set of
 * individually healthy incentives can still add up to a cost problem. Internal
 * discipline, not creator-facing: a creator should experience the incentives, not the
 * budget governing them.
 *
 * ⚠️ **The program currently has no members, so this bounds nothing** (2026-08-30). The
 * storage exemption — Public Access content not counting against a creator's storage —
 * was its first and only priced incentive, and it is retired: see `modelAt` below. The
 * ceiling is kept rather than deleted because it is a standing policy from 11.02 about
 * what the *next* incentive is allowed to cost, and re-deriving it later from an empty
 * file is how a considered number becomes a guess.
 */
export const PA_INCENTIVE_CEILING = 0.03;

/** `creatorCap = max(25, accounts / 100)` — one formula for the whole ladder (61.01). */
export const CREATOR_RATIO = 100;
export const CREATOR_FLOOR = 25;
export const creatorCap = (accounts: number) => Math.max(CREATOR_FLOOR, accounts / CREATOR_RATIO);

// ── Modeled populations ─────────────────────────────────────────────────────
/**
 * How the paying population spreads across monthly amounts: a geometric decay, `0.55^(n-1)`
 * over Anthers' own rungs — $3, $6, $9, and up in the same steps.
 *
 * Parametric rather than hand-typed on purpose. It is the distribution 61.01's
 * flattening-risk table sweeps — that table's rows *are* different decay values — and it
 * admits amounts above Blossom, which the product supports ("+" beyond the top rung).
 *
 * ⚠️ **Keyed in dollars**, stepping at `PUBLIC_ACCESS_PRICE` because those are **Anthers'**
 * own Badge levels — creators may sit anywhere, but this model is about Anthers' books and
 * only Anthers-directed money reaches them.
 *
 * 🚨 **This is the only mix, and there were two once.** A second, lighter distribution sat
 * in `scenarios.ts` while the ladder ran on this one, so the two published **two different
 * floor paying shares** (10.3% and 8.8%) and 61.01 had to carry a warning saying which
 * governed. Two descriptions of one fact is the failure every generated figure in this
 * repo exists to prevent; a mix is no different.
 */
export const PAY_DECAY = 0.55;
/** Rungs the mix spans. Beyond ten the weights are noise (0.55^10 ≈ 0.003). */
export const MAX_MODELLED_RUNGS = 10;

/** The normalized paying-user mix — `{monthlyDollars: share}`, summing to 1. */
export function payingBadgeMix(
	decay = PAY_DECAY,
	max = MAX_MODELLED_RUNGS,
): Record<number, number> {
	const weights = Array.from({ length: max }, (_, i) => decay ** i);
	const total = weights.reduce((a, b) => a + b, 0);
	return Object.fromEntries(weights.map((w, i) => [(i + 1) * PUBLIC_ACCESS_PRICE, w / total]));
}

/** Average monthly support per paying account — 61.01's flattening-risk axis. */
export const averageSupport = (mix: Record<number, number>) =>
	Object.entries(mix).reduce((acc, [amount, share]) => acc + Number(amount) * share, 0);

/**
 * The decay that produces a given average.
 *
 * 61.01's flattening-risk table is indexed by **average monthly support per payer**, not by the
 * decay underneath it — so the axis is solved for rather than dialed. Dialing it would
 * mean the published axis label and the mix it describes could disagree by a rounding,
 * which is the small version of the whole defect this file exists to close.
 *
 * Bounded by the mix's own reach: with ten rungs the average cannot exceed 5.5 rungs' worth
 * (decay 1, a flat distribution) and cannot fall below one rung (decay 0, everyone at the
 * bottom).
 */
export function decayForAverage(target: number, max = MAX_MODELLED_RUNGS): number {
	let lo = 1e-6;
	let hi = 1;
	for (let i = 0; i < 80; i++) {
		const mid = (lo + hi) / 2;
		if (averageSupport(payingBadgeMix(mid, max)) < target) lo = mid;
		else hi = mid;
	}
	return hi;
}

/**
 * The charitable remainder one paying account generates per month, under a mix.
 *
 * Read from `anthersSupportBreakdown`, never re-derived — so a move in `PUBLIC_ACCESS_PRICE`,
 * `TIME_POOL_RATE` or the card rate reaches every landmark below without anyone
 * remembering to re-run anything. The `.anthers` side of the split is the one that
 * matters: this account directs nothing at creators, so the whole card fee sits on it, and
 * taking `.creator` here reads as zero and silently hands the fee back to the remainder.
 *
 * It rises **faster than linearly** with the amount given, because the fixed $0.30 does not
 * scale with it — which is why the mix moves every number here more than it looks.
 */
export function remainderPerPayingAccount(mix: Record<number, number>): number {
	return Object.entries(mix).reduce((acc, [amount, share]) => {
		const n = Number(amount);
		const bd = anthersSupportBreakdown(n, { payments: paymentsSplit(n, 0).anthers });
		return acc + bd.foundation.toNumber() * share;
	}, 0);
}

/**
 * The creator population by size, as shares of the creator cap.
 *
 * `attention` is each segment's share of viewer attention — what divides the Time Pool.
 * It is deliberately **not** hours: with unlimited Public Access a viewer's hours are a
 * free variable while their contribution is fixed by what they give, so a per-hour rate
 * is an emergent ratio nobody is paid at. Attention-proportion is the real metric and the
 * one the equal-time principle applies to — a minute is a minute, whatever the medium.
 *
 * `storageGiB` is the whole catalog. A **free** creator's is subsidized entirely; a
 * paying creator is billed on their non-Public-Access bytes only.
 */
export interface CreatorSegment {
	name: string;
	/** Share of all creators. */
	share: number;
	/** Share of viewer attention, which is what divides the Time Pool. */
	attention: number;
	storageGiB: number;
	/** Whether this segment's storage is entirely on the charitable budget. */
	free: boolean;
}

export const CREATOR_SEGMENTS: readonly CreatorSegment[] = [
	{ name: "Free", share: 0.84, attention: 0.05, storageGiB: FREE_STORAGE_GIB, free: true },
	{ name: "Tiny", share: 0.1, attention: 0.15, storageGiB: 15, free: false },
	{ name: "Small", share: 0.03, attention: 0.25, storageGiB: 50, free: false },
	{ name: "Medium", share: 0.02, attention: 0.3, storageGiB: 150, free: false },
	{ name: "Large", share: 0.01, attention: 0.25, storageGiB: 400, free: false },
];

/**
 * Platform infrastructure, per month.
 *
 * `opsPerKAccounts` is what survived the R2 migration: presigned HLS segments cannot be
 * edge-cached, so streaming carries uncacheable Class B reads. It is billed per thousand
 * **accounts** rather than per hour, because hours stopped being a modeled quantity when
 * pay-per-watch-hour was retired — the streaming volume behind it is an assumption inside
 * the rate rather than a dial of its own.
 */
export const INFRA = {
	base: 120,
	perKAccounts: 6,
	perKCreators: 60,
	opsPerKAccounts: 3.4,
	/** Held back against the unbudgeted, as a share of everything above plus staffing. */
	reservesRate: 0.1,
} as const;

// ── The ledger at a given scale ──────────────────────────────────────────────
export interface GrowthInputs {
	accounts: number;
	/** Share of accounts giving Anthers anything at all, 0..1. */
	payingShare: number;
	staffing: Staffing;
	/** Defaults to the shipped `FREE_TIME_POOL`; a parameter so 11.03's review can sweep it. */
	freeTimePool?: number;
	mix?: Record<number, number>;
}

export interface CreatorSegmentLedger extends CreatorSegment {
	count: number;
	/** Monthly Time Pool earnings for one creator in this segment. */
	earnsEach: number;
	/** What one creator is billed for storage, before the charge. */
	storageCostEach: number;
	/** The half-again on top, which is charitable revenue. */
	storageChargeEach: number;
	/** Take-home after storage and the charge. */
	netEach: number;
}

export interface GrowthLedger {
	accounts: number;
	creators: number;
	payingAccounts: number;
	freeAccounts: number;
	segments: CreatorSegmentLedger[];
	/** Charitable revenue in: the users' remainder plus paying creators' storage charge. */
	charitableRevenue: number;
	/** Admin: infrastructure, staffing and reserves. */
	overhead: number;
	/** Free access as a program obligation: the free pot and free creators' storage. */
	freeAccess: number;
	/** What the Public Access incentives cost, and what they are allowed to cost. */
	paIncentiveCost: number;
	paCeiling: number;
	paWithinCeiling: boolean;
	/** The discretionary charitable budget — the residual, read obligations-first. */
	programs: number;
	solvent: boolean;
	adminRatio: number;
	adminHealthy: boolean;
	timePoolToCreators: number;
}

/**
 * Apportion `total` across `shares` by largest remainder, so the parts are whole
 * accounts and still sum to the total. Rounding each independently loses or invents
 * a few at every scale, which shows up as a jagged crossover under the sweep.
 */
function apportion(total: number, shares: readonly number[]): number[] {
	const T = Math.round(total);
	const sum = shares.reduce((a, b) => a + b, 0);
	if (sum <= 0 || T <= 0) return shares.map(() => 0);
	const raw = shares.map((s) => (T * s) / sum);
	const counts = raw.map(Math.floor);
	const short = T - counts.reduce((a, b) => a + b, 0);
	const byRemainder = raw
		.map((r, i) => [i, r - Math.floor(r)] as const)
		.sort((a, b) => b[1] - a[1]);
	for (let k = 0; k < short; k++) counts[byRemainder[k % byRemainder.length][0]]++;
	return counts;
}

/** Anthers' monthly books at a given scale, staffing and paying share. */
export function modelAt(input: GrowthInputs): GrowthLedger {
	const {
		accounts,
		payingShare,
		staffing,
		freeTimePool = FREE_TIME_POOL,
		mix = payingBadgeMix(),
	} = input;

	const creators = creatorCap(accounts);
	const freeAccounts = Math.round(accounts * (1 - payingShare));
	const payingAccounts = Math.max(0, Math.round(accounts) - freeAccounts);

	// ---- Users ----
	const rungs = Object.keys(mix)
		.map(Number)
		.sort((a, b) => a - b);
	const byLevel = apportion(
		payingAccounts,
		rungs.map((n) => mix[n]),
	);
	let charitableFromUsers = 0;
	let timePoolToCreators = freeTimePool * freeAccounts;
	rungs.forEach((n, i) => {
		const count = byLevel[i];
		const bd = anthersSupportBreakdown(n, { payments: paymentsSplit(n, 0).anthers });
		charitableFromUsers += bd.foundation.toNumber() * count;
		timePoolToCreators += bd.timePool.toNumber() * count;
	});
	const freeAccessTimePool = freeTimePool * freeAccounts;

	// ---- Creators ----
	// Bookkeeping care with the Public Access exemption: a FREE creator's whole catalog
	// is already subsidized, so only a PAYING creator's PA bytes are new cost. Counting
	// both would double-count them.
	const segmentCounts = apportion(
		creators,
		CREATOR_SEGMENTS.map((s) => s.share),
	);
	const attentionTotal = CREATOR_SEGMENTS.reduce(
		(a, s, i) => a + (segmentCounts[i] > 0 ? s.attention : 0),
		0,
	);
	let storageCharge = 0;
	let freeStorageSubsidy = 0;
	const segments: CreatorSegmentLedger[] = CREATOR_SEGMENTS.map((seg, i) => {
		const count = segmentCounts[i];
		const attentionShare = attentionTotal > 0 && count > 0 ? seg.attention / attentionTotal : 0;
		const earnsEach = count > 0 ? (attentionShare * timePoolToCreators) / count : 0;
		// 🚨 **Every stored byte is billed, and the Public Access exemption that used to
		// discount this is gone** (Parker, 2026-08-30). A creator's Public Access bytes
		// once cost them nothing, which made the commons cheaper to join; the exemption
		// was retired because its cost is governed by a number Anthers does not control
		// and cannot observe in advance — how much creators store. Priced at its own
		// worst case it fit the ceiling with almost nothing to spare (2.97% of charitable
		// revenue at rung 1), and doubling the modeled library sizes breached it. Those
		// sizes are modest for video: `CREATOR_SEGMENTS` puts Large at 400 GiB, while a
		// 100-hour 1080p60 library with masters is ~1,062 GiB by our own storage model.
		// So the exemption was solvent only on an assumption the platform is actively
		// trying to falsify. It may return in a **bounded** form — see 11.02.
		const fullCost = seg.storageGiB * STORAGE_PER_GIB_MONTH;
		const chargeEach = seg.free ? 0 : AFF_INFRA_RATE * fullCost;
		const paidByCreator = seg.free ? 0 : fullCost;
		if (seg.free) {
			freeStorageSubsidy += fullCost * count;
		} else {
			storageCharge += chargeEach * count;
		}
		return {
			...seg,
			count,
			earnsEach,
			storageCostEach: paidByCreator,
			storageChargeEach: chargeEach,
			netEach: earnsEach - paidByCreator - chargeEach,
		};
	});
	// The Public Access incentive program's cost. Its first and only priced member was the
	// storage exemption above, so this is **zero until an incentive is actually built** —
	// kept as a term rather than deleted because `PA_INCENTIVE_CEILING` still bounds the
	// program, and the next incentive should land here rather than rebuild the accounting.
	const paIncentiveCost = 0;

	// ---- The charitable budget, read obligations-first ----
	const charitableRevenue = charitableFromUsers + storageCharge;
	const variableInfra =
		(accounts / 1000) * (INFRA.perKAccounts + INFRA.opsPerKAccounts) +
		(creators / 1000) * INFRA.perKCreators;
	const baselineInfra = INFRA.base + variableInfra;
	const staffed = staffing.staff + staffing.tooling + staffing.services;
	const reserves = INFRA.reservesRate * (baselineInfra + staffed);
	const overhead = baselineInfra + staffed + reserves;
	const freeAccess = freeAccessTimePool + freeStorageSubsidy + paIncentiveCost;
	const paCeiling = PA_INCENTIVE_CEILING * charitableRevenue;
	const programs = charitableRevenue - overhead - freeAccess;
	const adminRatio =
		charitableRevenue > 0 ? overhead / charitableRevenue : Number.POSITIVE_INFINITY;

	return {
		accounts,
		creators,
		payingAccounts,
		freeAccounts,
		segments,
		charitableRevenue,
		overhead,
		freeAccess,
		paIncentiveCost,
		paCeiling,
		paWithinCeiling: paIncentiveCost <= paCeiling + 1e-9,
		programs,
		solvent: programs >= -1e-9,
		adminRatio,
		adminHealthy: adminRatio <= ADMIN_CEILING + 1e-9,
		timePoolToCreators,
	};
}

// ── The crossover sweep ──────────────────────────────────────────────────────
/**
 * A landmark is **affordable and healthy**, and it takes both tests.
 *
 * 🚨 Getting this wrong is what makes the model look wrong at low paying shares, and it
 * is easy to reach for `adminHealthy` alone. The Admin ratio is overhead against
 * charitable *revenue*, so it **cannot see the free-access pot at all** — above roughly
 * 15% paying it is the binding constraint and solvency is slack, while below that
 * solvency binds and the ratio is slack. Test only the ratio and the floor comes out at
 * 1.3% instead of 8.8%, with a smooth curve where the real one has a cliff.
 */
export const affordable = (m: GrowthLedger) => m.adminHealthy && m.solvent;

/**
 * The lowest account total at which `pred` holds, or `null` if it never does.
 *
 * Bisects on log10(accounts) because the ladder spans four orders of magnitude and the
 * interesting crossings are not evenly spaced. `maxLog` bounds the search: past ~10^9
 * accounts a landmark is not a landmark, it is an asymptote, and reporting a number there
 * would dress up "never" as a plan.
 */
export function crossover(
	pred: (m: GrowthLedger) => boolean,
	input: Omit<GrowthInputs, "accounts">,
	{ minLog = 2, maxLog = 9, steps = 120 } = {},
): number | null {
	const at = (log: number) => modelAt({ ...input, accounts: 10 ** log });
	if (!pred(at(maxLog))) return null;
	if (pred(at(minLog))) return Math.round(10 ** minLog);
	let lo = minLog;
	let hi = maxLog;
	for (let i = 0; i < steps; i++) {
		const mid = (lo + hi) / 2;
		if (pred(at(mid))) hi = mid;
		else lo = mid;
	}
	return Math.round(10 ** hi);
}

/**
 * The paying share below which no scale is ever affordable — the floor 11.02 is built on.
 *
 * Below it each new cohort costs more in free access than it brings in, so growth makes
 * the gap worse rather than better. Found by bisecting the share rather than solved in
 * closed form, so it stays correct if a term stops being linear in the share.
 */
export function floorPayingShare(
	input: Omit<GrowthInputs, "accounts" | "payingShare">,
	{ steps = 60 } = {},
): number {
	const reachable = (share: number) =>
		crossover(affordable, { ...input, payingShare: share }, { maxLog: 12 }) !== null;
	let lo = 0.001;
	let hi = 0.5;
	if (!reachable(hi)) return Number.NaN;
	for (let i = 0; i < steps; i++) {
		const mid = (lo + hi) / 2;
		if (reachable(mid)) hi = mid;
		else lo = mid;
	}
	return hi;
}
