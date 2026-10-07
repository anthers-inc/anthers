// SPDX-License-Identifier: Apache-2.0
//
// The growth model has to say what 61.01 says.
//
// 🚨 **These are not tautologies, and the reason is worth stating once.** Every landmark
// asserted here was derived independently — by running the *retired HTML playground's*
// own `computeAll` headless, by hand, on 2026-08-12 and again on 2026-08-16 — and written
// into 61.01 before this module existed. So pinning against those numbers checks this
// implementation against a **different implementation of the same model**, which is the
// one form of cross-check that cannot be an assertion derived from the code under test.
//
// That property is temporary and it is spent the first time someone regenerates 61.01
// from here. After that these constants are the record of the port, and the thing they
// guard is that a later refactor does not quietly move a landmark.
import { describe, expect, test } from "bun:test";
import { FREE_TIME_POOL, STORAGE_LADDER_GIB, STORAGE_PER_GIB_MONTH } from "./constants.js";
import {
	ADMIN_CEILING,
	affordable,
	averageSupport,
	crossover,
	decayForAverage,
	floorPayingShare,
	modelAt,
	NO_STAFFING,
	PA_INCENTIVE_CEILING,
	payingBadgeMix,
	staffingForPhase,
} from "./growth.js";

/** 61.01's model default, and the single biggest input to where inflection 1 falls. */
const SHARE = 0.3;
const full = staffingForPhase(10);
const hire = staffingForPhase(11);

/** Within `pct`% — landmarks are crossovers found by bisection, not exact quantities. */
function near(actual: number | null, expected: number, pct = 1.5) {
	expect(actual).not.toBeNull();
	const drift = Math.abs((actual as number) / expected - 1) * 100;
	if (drift > pct) {
		throw new Error(`expected ~${expected}, got ${actual} (${drift.toFixed(1)}% off, tol ${pct}%)`);
	}
}

describe("the landmarks 61.01 publishes", () => {
	test("the platform stops costing Parker money at ~225 accounts", () => {
		near(
			crossover((m) => m.solvent, { payingShare: SHARE, staffing: NO_STAFFING }),
			225,
		);
	});

	test("it is charity-healthy with no salary at ~555", () => {
		near(crossover(affordable, { payingShare: SHARE, staffing: NO_STAFFING }), 555);
	});

	test("a full-time salary is SOLVENT at ~12,300 — far below where it is responsible", () => {
		near(
			crossover((m) => m.solvent, { payingShare: SHARE, staffing: full }),
			12_300,
		);
	});

	test("INFLECTION 1 — full-time and charity-healthy — is ~33,100", () => {
		near(crossover(affordable, { payingShare: SHARE, staffing: full }), 33_100);
	});

	test("INFLECTION 2 — a first hire — is ~78,000", () => {
		near(crossover(affordable, { payingShare: SHARE, staffing: hire }), 78_000);
	});

	/**
	 * 🚨 **The landmark that is actually bound by SOLVENCY, and it exists because a
	 * sabotage found its absence.** Dropping the solvency half of `affordable` failed four
	 * tests where six were predicted: every landmark above is measured at the 30% paying
	 * share, where the Admin ceiling binds and the conjunction is *equal* to `adminHealthy`
	 * — so none of them can see that half go missing. A wrong prediction is the result.
	 *
	 * At 10% paying the binding constraint flips, which is exactly why 61.01's sensitivity
	 * table turns violent there. Pinning this row means a landmark *value*, not just a
	 * verdict, protects the free-access pot's contribution to the model.
	 */
	test("at 10% paying — where solvency binds instead of Admin — inflection 1 is ~201,500", () => {
		near(crossover(affordable, { payingShare: 0.1, staffing: full }, { maxLog: 12 }), 201_500, 2);
	});

	/**
	 * The gap between solvency and charity-health is the whole reason the ladder uses the
	 * charity-health line for every salary landmark. Paying at the solvency point would run
	 * Admin near two-thirds of charitable revenue in the years the Form 1023 narrative is
	 * examined — so this asserts the gap is *large*, not merely present.
	 */
	test("charity-health is far above solvency, which is why the ladder uses it", () => {
		const solvent = crossover((m) => m.solvent, { payingShare: SHARE, staffing: full }) as number;
		const healthy = crossover(affordable, { payingShare: SHARE, staffing: full }) as number;
		expect(healthy / solvent).toBeGreaterThan(2);
		expect(
			modelAt({ accounts: solvent, payingShare: SHARE, staffing: full }).adminRatio,
		).toBeGreaterThan(0.6);
	});

	test("inflection 2 lands a bit over twice as far up as inflection 1", () => {
		const one = crossover(affordable, { payingShare: SHARE, staffing: full }) as number;
		const two = crossover(affordable, { payingShare: SHARE, staffing: hire }) as number;
		// 61.01: "roughly two and a third times further up" — 2.36x, and the ratio is a
		// structural property of fixed overhead against per-account revenue rather than an
		// artifact of the delivery economics that changed underneath it.
		expect(two / one).toBeGreaterThan(2.2);
		expect(two / one).toBeLessThan(2.5);
	});
});

describe("affordability takes BOTH tests", () => {
	/**
	 * 🚨 The test that would have caught the wrong predicate, and did.
	 *
	 * The Admin ratio is overhead against charitable **revenue**, so it cannot see the
	 * free-access pot at all — a free account contributes nothing to either side of that
	 * fraction. Reaching for `adminHealthy` alone therefore reports a model that is
	 * "healthy" while it is losing money on every free account, and the published floor
	 * comes out at 1.3% instead of 8.8%, with a smooth curve where the real one has a
	 * cliff. This pins a scale where the two verdicts genuinely disagree.
	 */
	test("at a low paying share the Admin ratio passes while the books do not balance", () => {
		const m = modelAt({ accounts: 500_000, payingShare: 0.05, staffing: full });
		expect(m.adminHealthy).toBe(true);
		expect(m.solvent).toBe(false);
		expect(affordable(m)).toBe(false);
	});

	test("at a high paying share the reverse binds — solvent well before Admin is healthy", () => {
		const m = modelAt({ accounts: 15_000, payingShare: SHARE, staffing: full });
		expect(m.solvent).toBe(true);
		expect(m.adminHealthy).toBe(false);
		expect(affordable(m)).toBe(false);
	});
});

describe("the floor paying share", () => {
	test("is ~8.7% at the shipped free pot", () => {
		expect(floorPayingShare({ staffing: NO_STAFFING }) * 100).toBeCloseTo(8.7, 1);
	});

	/**
	 * Cross-checked against the model's own SLOPE rather than against its closed form —
	 * there isn't one here, which is the point. Below the floor one more account makes the
	 * budget worse; above it, better. Asserting that is asserting what the floor *means*,
	 * not how it is computed.
	 */
	test("is exactly where one more account stops making the budget worse", () => {
		const floor = floorPayingShare({ staffing: NO_STAFFING });
		const slope = (share: number) => {
			const at = (n: number) =>
				modelAt({ accounts: n, payingShare: share, staffing: NO_STAFFING }).programs;
			return (at(2e6) - at(1e6)) / 1e6;
		};
		expect(slope(floor - 0.01)).toBeLessThan(0);
		expect(slope(floor + 0.01)).toBeGreaterThan(0);
		expect(Math.abs(slope(floor))).toBeLessThan(0.002);
	});

	/**
	 * The dial this pivots on is explicitly provisional (Parker, 2026-08-12) and expected
	 * to move, so the assertion is the RELATIONSHIP, not a number tuned to today's value.
	 * A more generous pot is a standing obligation to every free account, and it raises the
	 * share of payers needed to fund it — which is the asymmetry the $0.25 opening was
	 * chosen on: raising it later is easy, climbing down is not.
	 */
	test("a more generous free pot raises the share of payers needed to fund it", () => {
		const a = floorPayingShare({ staffing: NO_STAFFING, freeTimePool: FREE_TIME_POOL });
		const b = floorPayingShare({ staffing: NO_STAFFING, freeTimePool: FREE_TIME_POOL * 2 });
		expect(b).toBeGreaterThan(a);
		// 61.01 recorded the $0.50 pot's floor as 15.66% under the old storage shape; the
		// ruled ladder makes carrying allowances cheaper than the half-again world was,
		// so the same pot lands at 15.61% — recorded as the relationship, re-derived here.
		expect(b * 100).toBeCloseTo(15.61, 1);
	});

	test("staffing does not move it — a floor is asymptotic, and fixed cost washes out", () => {
		expect(floorPayingShare({ staffing: full })).toBeCloseTo(
			floorPayingShare({ staffing: NO_STAFFING }),
			3,
		);
	});
});

describe("the ledger balances", () => {
	test("charitable revenue is exactly Admin plus free access plus programs", () => {
		for (const accounts of [100, 5_000, 80_000, 2_000_000]) {
			const m = modelAt({ accounts, payingShare: SHARE, staffing: full });
			expect(m.overhead + m.freeAccess + m.programs).toBeCloseTo(m.charitableRevenue, 6);
		}
	});

	test("every account is either paying or free, and none is both", () => {
		for (const accounts of [100, 3_333, 80_000]) {
			const m = modelAt({ accounts, payingShare: SHARE, staffing: full });
			expect(m.payingAccounts + m.freeAccounts).toBe(Math.round(accounts));
		}
	});

	/**
	 * Directed support and direct purchases are deliberately absent — Anthers keeps $0 of
	 * either, so neither can move a line here. Stated as a test because it is 11.02's
	 * decoupling and the reason a purchase-heavy Anthers can look successful while the
	 * budget that funds free access stays thin.
	 */
	test("charitable revenue reads support given to Anthers, and nothing else", () => {
		const m = modelAt({ accounts: 80_000, payingShare: SHARE, staffing: full });
		// The storage mark-up was charitable revenue's second line; the top-up ruling
		// (2026-10-07) retires it — top-up is at cost, so every segment's `storageChargeEach`
		// is zero and users' remainder is the whole of revenue.
		const fromCreators = m.segments.reduce((a, s) => a + s.storageChargeEach * s.count, 0);
		expect(fromCreators).toBe(0);
		expect(m.charitableRevenue / m.payingAccounts).toBeCloseTo(2.8, 1);
	});
});

describe("creator storage follows the ruled Badge shape", () => {
	/**
	 * 🚨 **This is the guard that replaced the Public Access storage exemption's tests**
	 * (2026-08-30). A creator's Public Access bytes used to be free, so `modelAt` billed
	 * `fullCost × (1 − paCatalogueShare)` and two tests asserted the resulting subsidy fit
	 * inside `PA_INCENTIVE_CEILING`. The exemption is retired, so those tests had nothing
	 * left to assert — and deleting them without putting this in its place would have left
	 * the discount reintroducible by a one-character edit with nothing to notice.
	 *
	 * What it asserts now (2026-10-07's ruling) is the **ruled split of who pays**: a
	 * paying creator pays at-cost overflow *past* their rung's allowance — nothing at or
	 * under it — and Anthers carries the allowance bytes the catalog actually uses. A
	 * model creator's allowance is the rung that covers their catalog (never below Root).
	 * Derived from `CREATOR_SEGMENTS` and `STORAGE_LADDER_GIB` rather than frozen dollar
	 * figures, so it moves with the dials and fails only on a real change of rule.
	 */
	test("a paying creator pays overflow past their allowance; the allowance is Anthers' obligation", () => {
		const m = modelAt({
			accounts: 10_000,
			payingShare: SHARE,
			staffing: staffingForPhase(7),
		});
		const paying = m.segments.filter((s) => !s.free);
		expect(paying.length, "no paying creator segments to check").toBeGreaterThan(0);
		for (const seg of paying) {
			const covered = Math.min(seg.storageGiB, seg.allowanceGiBEach);
			// The allowance never reads below Root's 50 for a paying creator.
			expect(seg.allowanceGiBEach).toBeGreaterThanOrEqual(STORAGE_LADDER_GIB.root);
			// The creator pays the vendor rate on overflow, and nothing else — the
			// mark-up is retired, so `storageChargeEach` is zero everywhere.
			expect(
				seg.storageCostEach,
				`${seg.name} pays something other than at-cost overflow`,
			).toBeCloseTo(Math.max(0, seg.storageGiB - covered) * STORAGE_PER_GIB_MONTH, 10);
			expect(seg.storageChargeEach, `${seg.name} carries a mark-up that retired`).toBe(0);
			// Anthers' obligation is the stored bytes the allowance covers.
			expect(seg.allowanceCostEach, `${seg.name}'s allowance cost is off`).toBeCloseTo(
				covered * STORAGE_PER_GIB_MONTH,
				10,
			);
		}
		// The ruled ladder's whole point: no paying segment's overflow can be a loss
		// position for Anthers, because overflow is margin-neutral by construction.
		for (const seg of m.segments) {
			expect(seg.storageChargeEach).toBe(0);
		}
	});

	/**
	 * ⚠️ **This one passes vacuously, and says so rather than pretending otherwise.** The
	 * incentive program is real policy (11.02) and `PA_INCENTIVE_CEILING` still governs it,
	 * but it has no members: the storage exemption was its first and only priced one. So
	 * `paWithinCeiling` is true because zero is under every ceiling, which is exactly the
	 * shape of guard that looks green while checking nothing.
	 *
	 * It earns its place by pinning the **zero** instead of the verdict: the moment a real
	 * incentive lands as a term in `paIncentiveCost`, this fails and whoever added it has to
	 * come here and price it against the ceiling on purpose. That is the whole point of
	 * keeping the budget line rather than deleting it with the exemption.
	 */
	test("the incentive program costs nothing, because nothing is in it yet", () => {
		for (const accounts of [100, 1_000, 10_000, 80_000, 2_000_000]) {
			const m = modelAt({
				accounts,
				payingShare: SHARE,
				staffing: staffingForPhase(13),
			});
			expect(m.paIncentiveCost, "an incentive has a cost — price it against the ceiling").toBe(0);
			expect(m.paWithinCeiling).toBe(true);
		}
		expect(PA_INCENTIVE_CEILING).toBeGreaterThan(0);
	});
});

describe("the paying-user mix", () => {
	test("the shipped decay puts the average payer at $6.59 a month", () => {
		// 2.20 rungs at $3 — the figure 61.01 names as its current assumption, in the
		// dollars the model is denominated in.
		expect(averageSupport(payingBadgeMix())).toBeCloseTo(6.59, 2);
		expect(averageSupport(payingBadgeMix()) / 3).toBeCloseTo(2.2, 2);
	});

	test("an average is solved for, so the published axis is the mix it describes", () => {
		for (const target of [3.75, 5.01, 9.12, 13.95]) {
			expect(averageSupport(payingBadgeMix(decayForAverage(target)))).toBeCloseTo(target, 3);
		}
	});

	/**
	 * 61.01's biggest named risk, and it is not an economic one: binary Public Access
	 * removes the reason to give Anthers more than its price, so the population
	 * slides toward exactly that unless something above it earns it.
	 */
	test("a flattening ladder pushes inflection 1 further away, monotonically", () => {
		const at = (avg: number) =>
			crossover(affordable, {
				payingShare: SHARE,
				staffing: full,
				mix: payingBadgeMix(decayForAverage(avg)),
			}) as number;
		const points = [13.95, 9.12, 6.59, 5.01, 3.75].map(at);
		expect([...points].sort((a, b) => a - b)).toEqual(points);
		// A full collapse to ~the Public Access price is still worse than the pre-R2 world's ~57,500 —
		// so the R2 windfall does not quite cover it — but by 1.15x, not the 1.9x that was
		// published while the $0.50 pot was assumed.
		expect(at(3.75) / 57_500).toBeGreaterThan(1);
		expect(at(3.75) / 57_500).toBeLessThan(1.25);
	});
});

describe("monotonicity — the model responds in the right direction", () => {
	test("a higher paying share reaches every landmark sooner", () => {
		const at = (share: number) =>
			crossover(affordable, { payingShare: share, staffing: full }, { maxLog: 12 }) as number;
		const points = [0.3, 0.25, 0.2, 0.15, 0.12].map(at);
		expect([...points].sort((a, b) => a - b)).toEqual(points);
	});

	test("more staffing costs more accounts", () => {
		const at = (staff: number) =>
			crossover(affordable, { payingShare: SHARE, staffing: { ...full, staff } }) as number;
		expect(at(10_000)).toBeGreaterThan(at(6_700));
		expect(at(6_700)).toBeGreaterThan(at(3_600));
	});

	test("Admin's share falls with scale, which is the wiki's stated design target", () => {
		const early = modelAt({
			accounts: 1_000,
			payingShare: SHARE,
			staffing: NO_STAFFING,
		});
		const late = modelAt({
			accounts: 2_000_000,
			payingShare: SHARE,
			staffing: staffingForPhase(13),
		});
		expect(late.adminRatio).toBeLessThan(early.adminRatio);
		expect(late.adminRatio).toBeLessThan(ADMIN_CEILING / 3);
	});
});
