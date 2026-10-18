// SPDX-License-Identifier: Apache-2.0
//
// Pins for the creator financials calculator's computation layer
// (`lib/creator-financials.ts`).
//
// Four kinds of pin, because the layer makes four kinds of promise:
//
// 1. **The supporter arithmetic is the checkout's arithmetic.** A supporter's Badge
//    amount and directed support ride one monthly charge; the pool is split by time,
//    not shaped by this layer. Recomputed here in DECIMAL from the fee model's own
//    shape so a float drift fails, and asserted against the generated receipt.
// 2. **The purchase take-home is the fee schedule's** — pinned to the generated
//    `SALE_TABLE` rows, and the storefront concession stays live (it is computed,
//    never chosen).
// 3. **Storage is rung arithmetic with no invented charge.** Free accounts are not
//    top-up eligible, paid accounts bill every byte past their allowance at cost —
//    pinned to `estimateStorageCost` in `fees.ts`, the money version.
// 4. **The free tier's pool is never a number this layer invents.** With the
//    Fund's slice unpublished the free rows answer null and stay null — a stated
//    gap, representable, never estimated.

import { describe, expect, test } from "bun:test";
import { estimateStorageCost } from "@anthers/shared/fees";
import { DIRECTED_SUPPORT_WORST_CASE, SALE_TABLE, SAMPLE_RECEIPT } from "@anthers/shared/figures";
import Decimal from "decimal.js";
import {
	freeViewerRow,
	rungCarrying,
	salesCase,
	storageCostDisplay,
	supporterRow,
	videoCatalog,
} from "./creator-financials";

const GIB = new Decimal("1073741824");

// ── 1. The supporter arithmetic ────────────────────────────────────────────────

describe("supporterRow — the checkout's own charge shape", () => {
	test("a Root supporter's pool is half their Badge, nothing else", () => {
		const row = supporterRow({ badge: "root", count: 1, hoursTotal: 30, hoursYou: 5, directed: 0 });
		expect(row.pool).toBeCloseTo(1.5, 10);
	});

	test("the pool split is the time share, exactly", () => {
		const row = supporterRow({
			badge: "sprout",
			count: 1,
			hoursTotal: 20,
			hoursYou: 5,
			directed: 0,
		});
		expect(row.share).toBe(0.25);
		expect(row.tpEarn).toBe(centHalfUp(0.25 * 3));
	});

	test("directed support nets its pro-rata slice of the whole charge's card fee — SAMPLE_RECEIPT's case", () => {
		// The generated receipt: a Sprout ($6) directing $6 atop it nets $5.67 directed,
		// 1.50 + 5.67 = 8.67 to creators from that user with all their time on you.
		const row = supporterRow({
			badge: "sprout",
			count: 1,
			hoursTotal: 30,
			hoursYou: 30,
			directed: 6,
		});
		expect(row.directedNet).toBe(Number(SAMPLE_RECEIPT.directedNet));
		expect(row.perSupporter).toBe(Number(SAMPLE_RECEIPT.toCreators));
	});

	test("the lone-worst case: a lone $3 directed from a bare account nets the worst-case figure", () => {
		const row = freeViewerRow({ count: 1, hoursTotal: 10, hoursYou: 0, directed: 3 }, 0);
		expect(row.directedNet).toBe(Number(DIRECTED_SUPPORT_WORST_CASE.net));
	});

	test("a decimal re-derivation agrees across a grid of badges and directions", () => {
		const badges = { root: 3, sprout: 6, petal: 9, blossom: 12 } as const;
		for (const [badge, amount] of Object.entries(badges)) {
			for (const directed of [0, 1, 2.5, 6, 20]) {
				const row = supporterRow({
					badge: badge as keyof typeof badges,
					count: 1,
					hoursTotal: 20,
					hoursYou: 7,
					directed,
				});
				// The decimal engine, mirroring supportBreakdown (the checkout's version):
				// one charge, one card fee, pro-rata by dollar value, half to the Time
				// Pool — cent rounding ROUND_HALF_UP at each cent boundary.
				const charge = new Decimal(amount).plus(directed);
				const fee = charge.gt(0)
					? charge.mul(0.029).plus(0.3).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
					: new Decimal(0);
				const cardOnDirected = fee
					.times(new Decimal(directed).div(charge))
					.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
				const pool = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).times(0.5);
				const directedNet = new Decimal(directed).minus(cardOnDirected);
				const earned = pool
					.times(7 / 20)
					.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
					.plus(directedNet)
					.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
				expect(row.perSupporter).toBe(earned.toNumber());
			}
		}
	});

	test("hours with you above their total is capped at the share 1", () => {
		const row = supporterRow({
			badge: "root",
			count: 3,
			hoursTotal: 10,
			hoursYou: 40,
			directed: 0,
		});
		expect(row.share).toBe(1);
		expect(row.tpEarn).toBe(row.pool);
	});
});

/** Cent-round half-up, the layer's rounding. */
function centHalfUp(n: number): number {
	return Math.round(n * 100 + 1e-6) / 100;
}

// ── 2. The purchase take-home ──────────────────────────────────────────────────

describe("salesCase — each item settles as its own charge", () => {
	test("take-homes match the generated SALE_TABLE rows", () => {
		for (const r of SALE_TABLE) {
			const sc = salesCase(Number(r.price), 1);
			expect(sc.reachAnthers).toBe(Number(r.creatorReceives));
			expect(sc.card).toBe(Number(r.cardFee));
		}
	});

	test("the fee is the same display copy the checkout pins to", () => {
		expect(salesCase(10, 5).reachAnthers * 5).toBeCloseTo(9.41 * 5, 10);
	});

	test("below the crossover the storefront wins, and the concession is computed", () => {
		const below = salesCase(1, 5); // $1 sits below the generated crossover
		expect(below.storefrontWins).toBe(true);
		expect(below.reachStorefront).toBeGreaterThan(below.reachAnthers);
		const at = salesCase(2, 1);
		expect(at.storefrontWins).toBe(false);
		expect(at.reachAnthers).toBeGreaterThan(at.reachStorefront);
	});
});

// ── 3. Storage — rung arithmetic, pinned to the money version ──────────────────

describe("storageCostDisplay — pinned to estimateStorageCost", () => {
	test("agrees across a grid of Badges and catalog sizes", () => {
		const amounts = { root: 3, sprout: 6, petal: 9, blossom: 12 } as const;
		for (const badge of ["free", "root", "sprout", "petal", "blossom"] as const) {
			for (const gib of [0, 10, 25, 25.5, 50, 60, 120, 150.25, 200, 240, 512]) {
				const float = storageCostDisplay(badge, gib);
				const money = estimateStorageCost({
					storageBytes: new Decimal(gib).times(GIB).toNumber(),
					anthersDollars: badge === "free" ? undefined : amounts[badge],
				});
				expect(float.allowance).toBe(money.allowanceGiB);
				expect(float.eligible).toBe(money.topUpEligible);
				expect(float.monthly).toBe(money.storageCost.toNumber());
				expect(float.billableGiB).toBeCloseTo(Number(money.storageGiB), 9);
			}
		}
	});

	test("a free account is billed nothing even past its floor", () => {
		expect(storageCostDisplay("free", 300).monthly).toBe(0);
		expect(storageCostDisplay("free", 300).eligible).toBe(false);
	});

	test("a paid allowance bills every byte past it, at cost", () => {
		const r = storageCostDisplay("root", 50 + 10);
		expect(r.billableGiB).toBeCloseTo(10, 9);
		expect(r.monthly).toBe(centHalfUp(10 * 0.0161));
	});
});

describe("rungCarrying — the smallest rung the catalog fits in", () => {
	test("the free floor carries the small catalogs", () => {
		expect(rungCarrying(0).badge).toBe("free");
		expect(rungCarrying(25).badge).toBe("free");
	});

	test("the ladder upward, with no invented rung", () => {
		expect(rungCarrying(25.01).badge).toBe("root");
		expect(rungCarrying(50).badge).toBe("root");
		expect(rungCarrying(100).badge).toBe("sprout");
		expect(rungCarrying(199).badge).toBe("blossom");
	});

	test("past the top rung: Blossom plus an at-cost top-up on the excess", () => {
		const r = rungCarrying(212.5);
		expect(r.badge).toBe("blossom");
		expect(r.topUp?.gib).toBeCloseTo(12.5, 9);
		expect(r.topUp?.monthly).toBe(centHalfUp(12.5 * 0.0161));
	});
});

// ── 4. The free tier's pool — a published value, never invented here ───────────

describe("freeViewerRow — the Fund's slice as an argument", () => {
	test("an unpublished slice: null all the way down, the gap representable", () => {
		const row = freeViewerRow({ count: 2000, hoursTotal: 20, hoursYou: 1 }, null);
		expect(row.slicePerAccount).toBeNull();
		expect(row.earnPerViewer).toBeNull();
		expect(row.revenue).toBeNull();
	});

	test("with a published slice: the time share of it, times the count", () => {
		// 1 hour of 20 — a 5% share of a $0.09 slice rounds to the cent: $0.00 per viewer.
		const row = freeViewerRow({ count: 2000, hoursTotal: 20, hoursYou: 1 }, 0.09);
		expect(row.earnPerViewer).toBe(0);
		expect(row.revenue).toBe(0);
		// Half their time against a $0.90 slice — $0.45 each, $900 across 2,000.
		const big = freeViewerRow({ count: 2000, hoursTotal: 20, hoursYou: 10 }, 0.9);
		expect(big.earnPerViewer).toBe(0.45);
		expect(big.revenue).toBe(900);
	});
});

// ── The catalog sizing — the shared ladder model ───────────────────────────────

describe("videoCatalog — one model, the ladder's", () => {
	test("a named format is the ladder model's own arithmetic", () => {
		const cat = videoCatalog({ res: "1080p", fps: 60, master: "h264", masterMbps: 20 }, 10);
		// 10.62 GiB per hour — the sizing test's frozen geometry off the bitrate ladder —
		// across ten source-hours.
		expect(cat.totalGiB).toBeCloseTo(106.2, 0);
		expect(cat.masterGiB + cat.ladderGiB).toBeCloseTo(cat.totalGiB, 9);
	});

	test("a custom master replaces the master term and only it", () => {
		const named = videoCatalog({ res: "1080p", fps: 60, master: "h264", masterMbps: 18 }, 10);
		const custom = videoCatalog({ res: "1080p", fps: 60, master: "custom", masterMbps: 18 }, 10);
		// 18 Mbps is H.264's 1080p60 reference exactly — so the totals agree.
		expect(custom.totalGiB).toBeCloseTo(named.totalGiB, 9);
		// A leaner custom master shrinks the master term and only it.
		const lean = videoCatalog({ res: "1080p", fps: 60, master: "custom", masterMbps: 6 }, 10);
		expect(lean.totalGiB).toBeLessThan(named.totalGiB);
		expect(lean.ladderGiB).toBeCloseTo(named.ladderGiB, 9);
		expect(lean.masterShare).toBeLessThan(named.masterShare);
	});

	test("zero hours answers an empty store, no NaN", () => {
		const cat = videoCatalog({ res: "1080p", fps: 60, master: "h264", masterMbps: 20 }, 0);
		expect(cat.totalGiB).toBe(0);
		expect(cat.masterGiB).toBe(0);
		expect(cat.ladderGiB).toBe(0);
	});
});
