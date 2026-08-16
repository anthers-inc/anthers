// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The canonical published scenarios — every money figure the site and the wiki
 * quote, derived from `fees.ts` in one place.
 *
 * **Why this exists.** Before 2026-08-08 these figures were typed by hand into
 * marketing pages and wiki tables. When Payments moved inside the price on
 * 2026-08-03 a sweep updated most of them, and quietly missed 50.01's per-Badge
 * table, its sample receipt, and a line on the Infrastructure page — which then
 * sat there overstating the remainder by exactly the card fee. A sweep cannot be
 * trusted to be complete; only derivation can.
 *
 * So: **nothing downstream may re-type a figure.** This module computes them,
 * `scripts/econ-figures.ts` renders them into `figures.generated.ts` (plain
 * numbers, so the SPA bundle never sees decimal.js) and into the wiki docs
 * between markers, and `--check` fails CI if either has drifted.
 *
 * Adding a published figure? Add it here, not to the page.
 */
import Decimal from "decimal.js";
import {
	AFF_INFRA_RATE,
	BADGE_ORDER,
	FREE_STORAGE_GIB,
	FREE_TIME_POOL,
	SALES_TAX_RATE,
	SEED_PRICE,
	STORAGE_PER_GIB_MONTH,
	TIME_POOL_PER_SEED,
	thresholdForBadge,
} from "./constants.js";
import {
	anthersSeedBreakdown,
	calculateFees,
	estimateStorageCost,
	paymentsSplit,
	supportBreakdown,
} from "./fees.js";
import {
	affordable,
	averageSeeds,
	crossover,
	decayForAverage,
	floorPayingShare,
	modelAt,
	NO_STAFFING,
	PA_INCENTIVE_CEILING,
	PAY_DECAY,
	PHASE_ACCOUNTS,
	payingBadgeMix,
	remainderPerPayingAccount,
	staffingForPhase,
} from "./growth.js";

const money = (d: Decimal) => d.toFixed(2);

export interface BadgeRow {
	badge: string;
	seeds: number;
	/** The all-in monthly charge for those Seeds. */
	charge: string;
	timePool: string;
	/** This side's share of the at-cost card fee — INSIDE the charge since 2026-08-03. */
	payments: string;
	/** The residual, which is what funds free access and the charitable programs. */
	remainder: string;
}

/**
 * The per-Badge decomposition. Each row conserves: pool + payments + rem = charge.
 *
 * A `bandwidth` column sat between the charge and the Time Pool until 2026-08-12,
 * driven by a reference streamer's watch-hours. Both are gone: delivery costs $0,
 * so there is nothing for time to price, and the table no longer rests on a
 * behavioural assumption at all. **Every row is now exact rather than illustrative.**
 */
export function badgeTable(): BadgeRow[] {
	return BADGE_ORDER.filter((b) => thresholdForBadge(b) > 0).map((badge) => {
		const n = thresholdForBadge(badge);
		// No directed Seeds in this scenario, so the whole card fee sits on this side.
		const payments = paymentsSplit(n, 0).anthers;
		const b = anthersSeedBreakdown(n, { payments });
		return {
			badge: badge.charAt(0).toUpperCase() + badge.slice(1),
			seeds: n,
			charge: money(b.seedValue),
			timePool: money(b.timePool),
			payments: money(b.payments),
			remainder: money(b.foundation),
		};
	});
}

export interface ReceiptScenario {
	anthersSeeds: number;
	creatorSeeds: number;
	/** Gross directed-Seed value — what the user chose to give. */
	directedGross: string;
	/** What actually reaches those creators, net of their share of the card fee. */
	directedNet: string;
	timePool: string;
	/** The WHOLE card fee on the batched charge. */
	payments: string;
	/** This side's share of it — what the Anthers block must show, or it double-counts. */
	paymentsAnthers: string;
	/** The creator side's share, already deducted from `directedNet`. */
	paymentsCreator: string;
	remainder: string;
	seedsSubtotal: string;
	salesTax: string;
	/** All-in: the subtotal plus sales tax, and nothing else. */
	totalBilled: string;
	toCreators: string;
}

/**
 * The sample monthly receipt in 50.01 — a Sprout who also directs two Seeds.
 *
 * Note the shape, because it is the whole point of all-in pricing: the subtotal
 * IS what the user pays, and sales tax is the only thing added. Payments appears
 * as a line inside the Seeds, never beneath the subtotal.
 */
export function sampleReceipt(anthersSeeds = 2, creatorSeeds = 2): ReceiptScenario {
	const s = supportBreakdown({ anthersSeeds, creatorSeeds });
	const split = paymentsSplit(anthersSeeds, creatorSeeds);
	const anthers = anthersSeedBreakdown(anthersSeeds, { payments: split.anthers });
	const salesTax = new Decimal(s.seedsSubtotal).mul(SALES_TAX_RATE).toDecimalPlaces(2);
	return {
		anthersSeeds,
		creatorSeeds,
		directedGross: money(s.creatorDirect),
		directedNet: money(s.creatorNet),
		timePool: money(s.timePool),
		payments: money(split.total),
		paymentsAnthers: money(split.anthers),
		paymentsCreator: money(split.creator),
		remainder: money(anthers.foundation),
		seedsSubtotal: money(s.seedsSubtotal),
		salesTax: money(salesTax),
		totalBilled: money(s.seedsSubtotal.plus(salesTax)),
		toCreators: money(s.toCreators),
	};
}

export interface SaleScenario {
	label: string;
	price: string;
	sizeGiB: number;
	creatorReceives: string;
	cardFee: string;
}

/**
 * The sale take-homes quoted across the comparison pages.
 *
 * ⚠️ **Size stopped affecting take-home on 2026-08-12** and the identical rows here
 * are deliberate: `game-10-1gib` and `game-10-2gib` now differ only in their label.
 * Download size *was* load-bearing — it caused a live inconsistency where two pages
 * quoted $9.39 and $9.40 for "a $10 game" because each assumed a different size —
 * and the fix at the time was to name the size in every scenario. Delivery is free
 * now, so the two agree by construction. The sizes stay because a row still reads
 * as a concrete thing, not because they price anything.
 */
export const SALE_SCENARIOS: { label: string; price: number; sizeGiB: number }[] = [
	{ label: "game-10-1gib", price: 10, sizeGiB: 1 },
	{ label: "game-10-2gib", price: 10, sizeGiB: 2 },
	{ label: "game-20-10gib", price: 20, sizeGiB: 10 },
	{ label: "album-10-1gib", price: 10, sizeGiB: 1 },
	{ label: "merch-25-physical", price: 25, sizeGiB: 0 },
];

export function saleTable(): SaleScenario[] {
	return SALE_SCENARIOS.map(({ label, price, sizeGiB }) => {
		const r = calculateFees(new Decimal(price), { type: sizeGiB > 0 ? "digital" : "physical" });
		return {
			label,
			price: money(new Decimal(price)),
			sizeGiB,
			creatorReceives: money(r.creatorEarnings),
			cardFee: money(r.processingFee),
		};
	});
}

export interface PurchaseExample extends SaleScenario {
	/** Human label for the row, as the creator-facing table names it. */
	item: string;
	sizeLabel: string;
	/** Share of list price the creator does not receive, e.g. "34.0%". */
	deductionPct: string;
}

/**
 * The creator-facing worked examples — the single-item worst case Studio quotes.
 *
 * Single-item on purpose: a multi-item cart amortises the fixed $0.30 and only ever
 * pays the creator more, so quoting the cart price would be quoting a best case. The
 * deduction percentage is here rather than in the doc because it is the number a
 * creator actually reacts to, and a percentage recomputed by hand beside a generated
 * take-home is precisely how the two drift apart.
 */
export const PURCHASE_EXAMPLES: {
	item: string;
	price: number;
	sizeGiB: number;
	sizeLabel: string;
}[] = [
	{ item: "A single track", price: 1, sizeGiB: 30 / 1024, sizeLabel: "30 MB" },
	{ item: "A small game", price: 5, sizeGiB: 800 / 1024, sizeLabel: "800 MB" },
	{ item: "An album", price: 10, sizeGiB: 500 / 1024, sizeLabel: "500 MB" },
	{ item: "A mid-size game", price: 20, sizeGiB: 10, sizeLabel: "10 GiB" },
	{ item: "A large game", price: 40, sizeGiB: 40, sizeLabel: "40 GiB" },
];

export function purchaseExamples(): PurchaseExample[] {
	return PURCHASE_EXAMPLES.map(({ item, price, sizeGiB, sizeLabel }) => {
		const list = new Decimal(price);
		const r = calculateFees(list, { type: "digital" });
		const deduction = list.minus(r.creatorEarnings).dividedBy(list).times(100);
		return {
			label: item,
			item,
			sizeLabel,
			price: money(list),
			sizeGiB,
			creatorReceives: money(r.creatorEarnings),
			cardFee: money(r.processingFee),
			// One decimal reads right for most rows; the sub-5% rows need two, or the
			// large-game case rounds to a suspiciously round 4.7%.
			deductionPct: `${deduction.toFixed(deduction.lessThan(5) ? 2 : 1)}%`,
		};
	});
}

/**
 * What the cart is worth, at the small end where the flat fee hurts most.
 *
 * Five $1 tracks bought one at a time pay the fixed $0.30 five times; bought together
 * they pay it once. The whole saving goes to the creators — it is the reason carts and
 * bundles are an economic instrument here rather than a convenience.
 */
export function cartSaving(unitPrice = 1, count = 5) {
	const one = calculateFees(new Decimal(unitPrice), { type: "digital" });
	const together = calculateFees(new Decimal(unitPrice * count), { type: "digital" });
	return {
		count,
		unitPrice: money(new Decimal(unitPrice)),
		separately: money(one.processingFee.times(count)),
		inOneCart: money(together.processingFee),
	};
}

/**
 * A mid-size creator's monthly earnings receipt.
 *
 * Gross earnings and library size are the two ASSUMPTIONS; everything below them is
 * derived. Storage above the free allowance, plus the charge on it, is a creator's
 * **only** platform-side cost — payouts carry no processing (Connect standard
 * transfers are free) and delivery costs nothing at any volume.
 *
 * ⚠️ **The numbers come from `estimateStorageCost`, not from a second copy of its
 * formula.** They used to be re-derived here, which was invisible while the rate was
 * $0.02/GiB: 19 billable GiB landed on exact cents at every step, so rounding once or
 * twice gave the same answer. R2's $0.0161 does not, and the receipt promptly stopped
 * reconciling — the charge is half of the *rounded* storage cost, not the rounded half
 * of the raw one. Same family as the five hand-rolled card-fee copies: a duplicated
 * formula agrees with its original right up until a dial moves.
 */
export function creatorReceipt(grossEarnings = 1575, libraryGiB = 69) {
	const gross = new Decimal(grossEarnings);
	const billableGiB = Math.max(0, libraryGiB - FREE_STORAGE_GIB);
	const { storageCost, storageAff } = estimateStorageCost({
		storageBytes: libraryGiB * 1024 ** 3,
	});
	return {
		libraryGiB,
		freeGiB: FREE_STORAGE_GIB,
		billableGiB,
		gross: money(gross),
		storage: money(storageCost),
		storageCharge: money(storageAff),
		net: money(gross.minus(storageCost).minus(storageAff)),
	};
}

/**
 * The paying-user mix behind every figure below — what share of paying users sit at each
 * Seed count. An ASSUMPTION, and the one that moves the most: the remainder a paying user
 * generates rises faster than linearly with their Seed count, because the fixed $0.30 of
 * the card fee does not scale with it.
 *
 * 🚨 **It is `growth.ts`'s mix now, and that unification was the point** (2026-08-16).
 * This was four hand-typed shares — `{1: .5, 2: .3, 3: .15, 4: .05}`, average 1.75 Seeds
 * — while the growth ladder ran on a geometric decay averaging 2.20. Two mixes meant two
 * **floor paying shares** in circulation (10.3% here, 8.8% there), and 61.01 had to carry
 * a warning naming which one governed. That is the same defect as a typed figure beside a
 * generated one, wearing different clothes: two descriptions of one fact, drifting.
 */
export const PAYING_BADGE_MIX: Record<number, number> = payingBadgeMix();

/** The paying shares the table reports. */
export const PAYING_SHARES = [0.1, 0.15, 0.2, 0.3];

/**
 * What a free user costs each month.
 *
 * It used to be their streaming bandwidth at cost plus the subsidised Time Pool.
 * With delivery free the bandwidth half is gone, so **a free account's whole cost to
 * Anthers is the Time Pool it funds on their behalf** — the money that reaches the
 * creators they watched. Watching more costs Anthers nothing extra, which is exactly
 * what makes Public Access describable as free without qualification.
 *
 * Not literally zero beyond that: presigned HLS segments can't be edge-cached, so
 * streaming carries ~600 Class B reads per watch-hour — about $0.0002/hr, against
 * 10 million free reads a month. It rounds to nothing at any scale this model
 * describes, and it is a platform line rather than a per-account one, so it is
 * deliberately not charged to a user here. 42.02 carries the figures.
 */
export const freeUserCost = () => new Decimal(FREE_TIME_POOL);

/**
 * What one more account does to the charitable budget, at a given paying share.
 *
 * Measured as the model's **slope** rather than re-derived: `modelAt` at two scales,
 * differenced. That matters more than it looks — the marginal cost of an account is the
 * free pot *plus* free creators' storage, the Public Access exemption and variable infra,
 * and a hand-written version of that sum is a duplicated formula that would agree with
 * `growth.ts` right up until a term moved. Same lesson as the five hand-rolled card-fee
 * copies and `creatorReceipt`'s storage formula.
 *
 * The two scales are large and far apart so fixed overhead — which is not marginal —
 * washes out of the difference entirely.
 */
function marginalProgramsPerAccount(share: number): number {
	const at = (accounts: number) =>
		modelAt({ accounts, payingShare: share, staffing: NO_STAFFING }).programs;
	const lo = 1_000_000;
	const hi = 2_000_000;
	return (at(hi) - at(lo)) / (hi - lo);
}

/**
 * Whether the charitable budget funds itself, as a function of the paying share.
 *
 * 🚨 **This reads `growth.ts` now** (2026-08-16). It used to carry its own two-term
 * model — a paying user's remainder against the free pot, and a `FIXED_MONTHLY_OVERHEAD`
 * of $12,600 that nothing sourced — while the growth ladder ran a fuller one. The two
 * published **different floors** for the same question, so 61.01 carried a warning saying
 * which governed, and the ladder could only be re-derived by reviving a retired file.
 *
 * Two things changed in the merge and both make the number *more* honest:
 *
 * - **A free account is not a free account's whole cost.** Every account also carries a
 *   share of free creators' 50 GiB, the Public Access storage exemption, and variable
 *   infrastructure. `freeUserCost` is still the pot — that is what a *free* account adds
 *   over a paying one — but the break-even now nets the rest off too.
 * - **`FIXED_MONTHLY_OVERHEAD` is gone.** A named staffing level replaces it, so "solvent"
 *   means something you can point at on the ladder instead of a constant with no
 *   derivation. The table reports the no-salary line (the platform stops costing Parker
 *   money) beside the full-time line (61.01's inflection 1), which is the pair the two
 *   documents were implicitly comparing all along.
 */
export function selfSufficiency() {
	const cost = freeUserCost();
	const mix = PAYING_BADGE_MIX;
	// The remainder one paying user generates, weighted across the mix. This no longer
	// depends on how much anyone watches: bandwidth was the term the remainder absorbed,
	// and it is gone, so each rung's remainder is now exact.
	const revenuePerPayingUser = new Decimal(remainderPerPayingAccount(mix));

	const rows = PAYING_SHARES.map((share) => {
		const marginal = marginalProgramsPerAccount(share);
		const staffing = { payingShare: share, staffing: NO_STAFFING };
		return {
			share,
			sharePct: `${(share * 100).toFixed(0)}%`,
			// Per PAYING account, since that is the cohort carrying it.
			net: money(new Decimal(marginal / share)),
			/** Accounts at which the budget covers its obligations with no salary drawn. */
			selfFunding: crossover(affordable, staffing),
			/** Accounts at which it also affords a full-time ED inside the Admin ceiling. */
			fullTime: crossover(affordable, { ...staffing, staffing: staffingForPhase(10) }),
		};
	});

	// Below this share each new cohort costs more than it brings in, so growth makes the
	// gap worse rather than better. Bisected on the share through the same model the rows
	// use, so the floor and the rows cannot disagree — the previous closed-form version
	// could, and did, because it was solving a simpler model.
	const breakEven = floorPayingShare({ staffing: NO_STAFFING });

	return {
		freeUserCost: money(cost),
		revenuePerPayingUser: money(revenuePerPayingUser),
		averageSeeds: averageSeeds(mix).toFixed(2),
		breakEvenPct: `${(breakEven * 100).toFixed(1)}%`,
		rows,
	};
}

/**
 * The storefronts 62.04's headline table compares us against, and their revenue share.
 *
 * ⚠️ **These rates are PERISHABLE** — checked 2026-08-03, and a competitor can change
 * one without telling us. Re-check before anything ships. They live here rather than
 * in the document because they are arithmetic, not copy: 63.01 § Comparisons binds
 * every row to be **all-in against all-in**, which means a rival's column must be
 * computed from the same card fee ours is and must move when that fee moves. Typed by
 * hand, they don't — the $5 row disagreed with itself by a cent for exactly that
 * reason, because the rival columns rounded the fee at the end while ours rounded it
 * first.
 *
 * `absorbsProcessing` is Valve's model: their 30% covers the card cost, so nothing
 * further comes off. `maxPrice` bounds a row we would not honestly claim — Bandcamp
 * sells music, and a $40 album is not a transaction anyone recognises.
 */
export const RIVAL_STOREFRONTS: {
	name: string;
	share: number;
	absorbsProcessing?: boolean;
	maxPrice?: number;
}[] = [
	{ name: "Steam", share: 0.3, absorbsProcessing: true },
	{ name: "itch.io", share: 0.1 },
	{ name: "Bandcamp", share: 0.15, maxPrice: 20 },
];

export interface TakeHomeRow {
	price: string;
	/** What reaches the creator here — the list price less at-cost card processing. */
	anthers: string;
	/** Per storefront, all-in at the same list price. `null` where we make no claim. */
	rivals: { name: string; net: string | null }[];
	/** The best take-home in the row. Steam wins below ~$1.15 and the table must say so. */
	best: string;
}

/**
 * Creator take-home at the same list price, us against each storefront.
 *
 * The winner is computed rather than marked by hand, because *"concede where we lose"*
 * is a rule we would otherwise have to remember on every dial change: Steam beats us
 * below about $1.15, where their 30% of a small sale is less than the flat card fee
 * they absorb. A generated table concedes it by construction.
 */
export function takeHomeComparison(): TakeHomeRow[] {
	return PURCHASE_EXAMPLES.map(({ price }) => {
		const list = new Decimal(price);
		const card = calculateFees(list, { type: "digital" }).processingFee;
		const anthers = list.minus(card);
		const rivals = RIVAL_STOREFRONTS.map((r) => {
			if (r.maxPrice !== undefined && price > r.maxPrice) return { name: r.name, net: null };
			const afterShare = list.times(1 - r.share);
			return {
				name: r.name,
				net: money(r.absorbsProcessing ? afterShare : afterShare.minus(card)),
			};
		});
		const best = rivals.reduce(
			(top, r) => (r.net && new Decimal(r.net).greaterThan(top) ? new Decimal(r.net) : top),
			anthers,
		);
		return { price: money(list), anthers: money(anthers), rivals, best: money(best) };
	});
}

// ── The growth ladder (61.01) ────────────────────────────────────────────────
/**
 * The paying share the ladder is modelled at. 61.01 calls it the model default and the
 * single biggest input to where inflection 1 falls — and the one thing the early rungs
 * exist to *measure*, since nothing in the product has ever observed it.
 */
export const MODELLED_PAYING_SHARE = 0.3;

export interface LadderRung {
	phase: number;
	accounts: number;
	creators: number;
	staff: number;
	/** Admin as a share of charitable revenue at this rung's ceiling, e.g. "17%". */
	adminPct: string;
	/** Whether Admin clears the 30% board policy here. */
	adminHealthy: boolean;
	solvent: boolean;
}

/**
 * Each rung's ceiling, and what the books look like standing on it.
 *
 * The ceilings are **policy** — chosen in 61.01, not derived — which is what makes them
 * safe to quote. What is derived is the verdict beside each one: whether that rung's own
 * planned staffing is affordable and charity-healthy at the ceiling it may grow to.
 *
 * Rungs 1–3 come back unhealthy on purpose. That is Parker's subsidy, and 61.01 accepts
 * it explicitly — a model that hid it by sizing the plan to the ceiling would only ever
 * confirm itself.
 */
export function growthLadder(): LadderRung[] {
	return PHASE_ACCOUNTS.map((accounts, i) => {
		const staffing = staffingForPhase(i + 1);
		const m = modelAt({ accounts, payingShare: MODELLED_PAYING_SHARE, staffing });
		return {
			phase: i + 1,
			accounts,
			creators: Math.round(m.creators),
			staff: staffing.staff,
			adminPct: Number.isFinite(m.adminRatio) ? `${(m.adminRatio * 100).toFixed(0)}%` : "—",
			adminHealthy: m.adminHealthy,
			solvent: m.solvent,
		};
	});
}

export interface Landmark {
	label: string;
	accounts: number | null;
	note: string;
}

/**
 * The account totals at which each staffing level becomes payable.
 *
 * 🚨 **Solvency and charity-health are different lines and the gap is the whole design.**
 * A full-time salary is *solvent* far earlier than it is *responsible*: paying at the
 * solvency point would run Admin near two-thirds of charitable revenue in the same years
 * the Form 1023 narrative is examined and the first 990s are filed. **Every salary
 * landmark uses the charity-health line**, and the solvency line is reported beside it
 * because "the platform stops costing Parker money" is a real milestone — just not a
 * licence to draw a salary.
 */
export function salaryLandmarks(): Landmark[] {
	const share = MODELLED_PAYING_SHARE;
	const full = staffingForPhase(10);
	const hire = staffingForPhase(11);
	return [
		{
			label: "Platform stops costing Parker money (no salary)",
			accounts: crossover((m) => m.solvent, { payingShare: share, staffing: NO_STAFFING }),
			note: "inflow covers infrastructure and free access, though not yet at a healthy Admin ratio",
		},
		{
			label: "Charity-healthy, no salary",
			accounts: crossover(affordable, { payingShare: share, staffing: NO_STAFFING }),
			note: "the platform pays for its own iron and keeps Admin under the board's 30%",
		},
		{
			label: "Full-time salary — solvent",
			accounts: crossover((m) => m.solvent, { payingShare: share, staffing: full }),
			note: "affordable, but at an Admin ratio no 990 should carry — not a licence to draw it",
		},
		{
			label: "🚩 Inflection 1 — full-time, charity-healthy",
			accounts: crossover(affordable, { payingShare: share, staffing: full }),
			note: "inside 60.01's ED band with Admin under 30% — the line the ladder is anchored on",
		},
		{
			label: "🚩 Inflection 2 — a first hire, charity-healthy",
			accounts: crossover(affordable, { payingShare: share, staffing: hire }),
			note: "a full-time ED plus one hire; the organisation exists",
		},
	];
}

/** The paying shares 61.01 sweeps inflection 1 against. */
export const SENSITIVITY_SHARES = [0.3, 0.25, 0.2, 0.18, 0.16, 0.15, 0.12, 0.1, 0.09];

/**
 * Inflection 1 against the paying share — the sensitivity the whole quota rests on.
 *
 * **Violently non-linear near the floor**, and that is the point of publishing it: above
 * ~15% the binding constraint is the Admin ceiling, which cannot see the free pot, so the
 * curve is gentle. Below that solvency binds, the pot enters, and the threshold runs away.
 */
export function payingShareSensitivity() {
	const full = staffingForPhase(10);
	return SENSITIVITY_SHARES.map((share) => ({
		share,
		sharePct: `${(share * 100).toFixed(0)}%`,
		accounts: crossover(affordable, { payingShare: share, staffing: full }, { maxLog: 12 }),
	}));
}

/**
 * Inflection 1 against how many Seeds an average payer holds — 61.01's flattening risk.
 *
 * 🚨 **This is the single biggest risk to the ladder, and it is not an economic one.**
 * Binary Public Access removes the reason to hold more than one Seed given to Anthers, so
 * the paying population slides toward exactly one unless something above the first Seed
 * earns it. Each row is a different decay in the mix; the labelled average is what the
 * decay produces, so the axis stays a fact about the population rather than a dial name.
 */
export const MIX_AVERAGES = [4.65, 3.04, 1.67, 1.25];

export function seedMixSensitivity() {
	const full = staffingForPhase(10);
	// The shipped mix is inserted by its OWN average rather than listed as a target, so
	// the "current" row can never quietly become a nearby round number that isn't it.
	const shipped = averageSeeds(payingBadgeMix());
	const points = [...MIX_AVERAGES, shipped].sort((a, b) => b - a);
	return points.map((avg) => {
		const current = avg === shipped;
		const mix = payingBadgeMix(current ? PAY_DECAY : decayForAverage(avg));
		return {
			avgSeeds: averageSeeds(mix).toFixed(2),
			current,
			accounts: crossover(
				affordable,
				{ payingShare: MODELLED_PAYING_SHARE, staffing: full, mix },
				{ maxLog: 12 },
			),
		};
	});
}

/**
 * Candidate settings for the free-account Time Pool pot, priced by what each costs.
 *
 * The pot is explicitly **provisional** (Parker, 2026-08-12) and under its own review, so
 * the thing 11.03 actually needs is not today's number but the *shape of the trade*: what
 * each setting costs, expressed as the floor paying share below which growth never closes
 * the gap. Generated because this document has now had three different values for it.
 */
export const FREE_POT_CANDIDATES = [0.05, FREE_TIME_POOL, 0.4, 0.5];

export function freePotSensitivity() {
	return FREE_POT_CANDIDATES.map((pot) => ({
		pot: money(new Decimal(pot)),
		shipped: pot === FREE_TIME_POOL,
		floorPct: `${(floorPayingShare({ staffing: NO_STAFFING, freeTimePool: pot }) * 100).toFixed(1)}%`,
		/** How much more a creator earns per unit of a free viewer's attention with a Seed. */
		multiple: TIME_POOL_PER_SEED / pot,
	}));
}

/** 60.01's ED compensation band, as monthly all-in staff cost. */
export const ED_BAND = [
	{ label: "$80k (band floor — current assumption)", staff: 6_700 },
	{ label: "$100k", staff: 8_350 },
	{ label: "$120k (band ceiling)", staff: 10_000 },
];

/** Inflection 1 against where in 60.01's band the ED is paid. */
export function edBandSensitivity() {
	const base = staffingForPhase(10);
	return ED_BAND.map(({ label, staff }) => ({
		label,
		accounts: crossover(
			affordable,
			{ payingShare: MODELLED_PAYING_SHARE, staffing: { ...base, staff } },
			{ maxLog: 12 },
		),
	}));
}

/**
 * The creator population by size, at a reference rung — who earns what, and who is
 * carried.
 *
 * `attentionPct` is a share of viewer attention, **not** hours: with unlimited Public
 * Access a viewer's hours are a free variable while their contribution is fixed by their
 * Seed count, so a per-hour rate is an emergent ratio nobody is paid at. It is also what
 * the equal-time principle actually governs — a minute is a minute, whichever medium it
 * was spent on.
 */
export function creatorSegments(accounts = 80_000) {
	const m = modelAt({
		accounts,
		payingShare: MODELLED_PAYING_SHARE,
		staffing: staffingForPhase(10),
	});
	const attention = m.segments.reduce((a, s) => a + (s.count > 0 ? s.attention : 0), 0);
	return {
		accounts,
		creators: Math.round(m.creators),
		rows: m.segments.map((s) => ({
			name: s.name,
			count: s.count,
			sharePct: `${(s.share * 100).toFixed(0)}%`,
			attentionPct: `${((s.attention / attention) * 100).toFixed(0)}%`,
			storageGiB: s.storageGiB,
			earns: money(new Decimal(s.earnsEach)),
			storage: money(new Decimal(s.storageCostEach + s.storageChargeEach)),
			net: money(new Decimal(s.netEach)),
			free: s.free,
		})),
	};
}

/**
 * What the Public Access storage exemption costs against the budget line that bounds it.
 *
 * ⚠️ **The worst case is rung 1, not the largest rung**, which is the opposite of the
 * intuition and was not what the retired playground's own prose claimed (it said "about
 * 1% … and stays there at every rung"; the model says **0.29%**, flat from rung 6 up).
 * The cost is driven by *creators per account*, and the flat 25-creator floor makes rung 1
 * the most creator-dense the platform will ever be — 25 creators against 100 accounts,
 * where the ratio would allow one. So the exemption very nearly breaches its 3% ceiling at
 * the smallest rung and is negligible everywhere else.
 *
 * Worth carrying into 61.01's open call on the flat-25 floor: raising it raises this.
 */
export function paIncentiveCeiling() {
	const rows = PHASE_ACCOUNTS.map((accounts, i) => {
		// The exemption priced at its worst case — every creator giving their whole
		// catalogue to the commons. Modelling it at the current 10% would report a cost we
		// have no way to hold anyone to.
		const m = modelAt({
			accounts,
			payingShare: MODELLED_PAYING_SHARE,
			staffing: staffingForPhase(i + 1),
			paCatalogueShare: 1,
		});
		return {
			phase: i + 1,
			accounts,
			pct: (m.paIncentiveCost / m.charitableRevenue) * 100,
			fits: m.paWithinCeiling,
		};
	});
	const worst = rows.reduce((a, b) => (b.pct > a.pct ? b : a));
	const atScale = rows[rows.length - 1];
	return {
		ceilingPct: `${(PA_INCENTIVE_CEILING * 100).toFixed(0)}%`,
		worstPct: `${worst.pct.toFixed(2)}%`,
		worstPhase: worst.phase,
		atScalePct: `${atScale.pct.toFixed(2)}%`,
		allFit: rows.every((r) => r.fits),
		rows,
	};
}

/** A lone directed Seed — the worst case, and the figure creator-facing copy quotes. */
export function directedSeedWorstCase() {
	const s = supportBreakdown({ anthersSeeds: 0, creatorSeeds: 1 });
	return {
		gross: money(new Decimal(SEED_PRICE)),
		net: money(s.creatorNet),
		cardFee: money(s.payments),
	};
}
