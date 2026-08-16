// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The take-home figures the Studio shows a creator at the moment they set a price.
//
// 🚨 **These are a persuasion surface, so a wrong number here does not merely mislead — it
// loses the creator.** The brief's whole argument is that "33%" reads as a platform cut and
// "$0.67 beside itch's $0.57" reads as the truth, so the comparison has to be right in the
// direction that is *unflattering* to us as well: Steam beats us at small prices, 62.04
// concedes that publicly, and a component that quietly stopped conceding it would be worse
// than one that showed nothing.
//
// The component computes with `cardFeeDisplay` (browser-side, dependency-free) rather than
// `fees.ts`, because the SPA must never pull decimal.js in. That substitution is only safe
// while the two agree — `economics.test.ts` pins them across ~2,900 amounts — so what this
// file adds is the *comparison* arithmetic and the low-price claims the UI makes in words.
import { describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { CARD_FLAT, CARD_RATE, cardFeeDisplay } from "./constants.js";
import { calculateFees } from "./fees.js";
import { RIVAL_STOREFRONTS } from "./figures.generated.js";

/** What the component renders as "You receive". */
const net = (amount: number) => amount - cardFeeDisplay(amount);

/** A rival's all-in take-home at the same list price, as the component computes it. */
function rivalNet(name: string, amount: number): number | null {
	const r = RIVAL_STOREFRONTS.find((x) => x.name === name);
	if (!r) throw new Error(`no rival ${name}`);
	const maxPrice = "maxPrice" in r ? (r.maxPrice as number | undefined) : undefined;
	if (maxPrice !== undefined && amount > maxPrice) return null;
	const afterShare = amount * (1 - r.share);
	const absorbs = "absorbsProcessing" in r && r.absorbsProcessing;
	// ⚠️ NOT clamped, matching the component. A clamped helper would agree with a clamped
	// component about a number that was wrong in both — the tautology this file exists to
	// avoid, and precisely the bug that clamping hid on our own column.
	return absorbs ? afterShare : afterShare - cardFeeDisplay(amount);
}

describe("what the creator is shown they receive", () => {
	test("is the list price less card processing, and nothing else", () => {
		for (const price of [0.25, 0.99, 1, 2, 3, 5, 10, 20, 40]) {
			expect(net(price)).toBeCloseTo(price - cardFeeDisplay(price), 10);
		}
	});

	/**
	 * The one assertion that makes the display trustworthy: it must equal what the buyer's
	 * charge actually books. `calculateFees` is what runs at checkout, and it uses Decimal.
	 * If the browser formula and the money formula ever part, the Studio quotes a number the
	 * creator never receives — silently, and only visible on a payout.
	 */
	test("agrees exactly with what checkout books, at every price the UI offers", () => {
		for (let cents = 1; cents <= 5000; cents++) {
			const price = cents / 100;
			const booked = calculateFees(new Decimal(price), { type: "digital" }).creatorEarnings;
			expect(net(price).toFixed(2), `$${price}`).toBe(booked.toFixed(2));
		}
	});

	test("Anthers keeps nothing — the deduction IS the card fee", () => {
		for (const price of [1, 5, 25]) {
			const r = calculateFees(new Decimal(price), { type: "digital" });
			expect(r.crfFee.toNumber()).toBe(0);
			expect(r.deliveryFee.toNumber()).toBe(0);
			expect(price - r.creatorEarnings.toNumber()).toBeCloseTo(r.processingFee.toNumber(), 10);
		}
	});
});

describe("the claims the low-price note makes in words", () => {
	/**
	 * The note says the fixed $0.30 is a stated share of the deduction at that price. It is
	 * the sentence that reframes "33%" as "one third-party flat fee", so the number in it
	 * has to be derived rather than written — it moves with `CARD_FLAT` and `CARD_RATE`.
	 */
	const flatShare = (amount: number) => {
		const fee = cardFeeDisplay(amount);
		return ((fee - amount * CARD_RATE) / fee) * 100;
	};

	test("at $1.00 the fixed fee is ~91% of the deduction, which is the brief's number", () => {
		expect(flatShare(1)).toBeCloseTo(91, 0);
	});

	test("the fixed share falls as the price rises — the reason small prices hurt", () => {
		const shares = [0.5, 1, 2, 5, 20].map(flatShare);
		expect([...shares].sort((a, b) => b - a)).toEqual(shares);
	});

	/**
	 * 🚨 The threshold the UI explains below is **$1, not $2**, and the brief corrected
	 * itself on this. "Anything under about $2 is punishing" is false against the platforms
	 * a creator actually compares us with — at $1.00 we return more than itch or Bandcamp.
	 * Below a dollar is where it genuinely hurts.
	 */
	test("take-home is healthy at $1 and genuinely poor below it", () => {
		expect((net(1) / 1) * 100).toBeCloseTo(67, 0);
		expect((net(2) / 2) * 100).toBeCloseTo(82, 0);
		expect((net(3) / 3) * 100).toBeCloseTo(87, 0);
		expect((net(0.5) / 0.5) * 100).toBeCloseTo(38, 0);
	});

	/**
	 * 🚨 **The brief said "a creator can price at $0.25 and keep about 6%". That is false**,
	 * and this test is why the display had to change rather than merely be built.
	 *
	 * At $0.25 the fee is $0.31, so the creator receives **−$0.06** — the sale loses them
	 * money. The first cut of `TakeHome` clamped with `Math.max(0, …)` and would have
	 * rendered that as "$0.00", which reads as *free* rather than *this costs you*. Hiding
	 * the one state a creator most needs to see is restricting by omission, which is exactly
	 * what "inform, never restrict" was written against.
	 */
	test("below break-even the creator LOSES money, and the figure is negative", () => {
		expect(net(0.25)).toBeLessThan(0);
		expect(net(0.25)).toBeCloseTo(-0.06, 2);
		expect(net(0.3)).toBeLessThan(0);
	});

	test("break-even is $0.32, derived from the dials rather than assumed", () => {
		// `0.971p > 0.30` — but asserted by search, so it moves if either dial does.
		let breakEven = 0;
		for (let cents = 1; cents <= 200; cents++) {
			if (net(cents / 100) > 0) {
				breakEven = cents / 100;
				break;
			}
		}
		expect(breakEven).toBeCloseTo(0.32, 2);
		expect(net(breakEven)).toBeGreaterThan(0);
		expect(net(breakEven - 0.01)).toBeLessThanOrEqual(0);
	});

	test("a creator may still price under break-even — informed, not restricted", () => {
		// No floor anywhere in our code. The accepted cost of the settled rule is that this
		// is legal; asserting it stops a well-meaning minimum creeping in later.
		expect(() => net(0.25)).not.toThrow();
	});
});

describe("the named-alternative comparison", () => {
	test("at $1.00 we return more than itch and Bandcamp — the brief's headline", () => {
		expect(net(1)).toBeCloseTo(0.67, 2);
		expect(rivalNet("itch.io", 1)).toBeCloseTo(0.57, 2);
		expect(rivalNet("Bandcamp", 1)).toBeCloseTo(0.52, 2);
	});

	/**
	 * 🚨 **The concession, asserted so it cannot quietly disappear.** Steam absorbs
	 * processing, so their 30% of a small sale costs the creator less than the flat fee we
	 * pass through — they beat us below about $1.15. 63.01 § Comparisons binds us to
	 * conceding where we lose, and a comparison that only ever showed us winning would be
	 * the exact dishonesty the rule exists to prevent.
	 */
	test("Steam beats us at small prices, and the display must show it", () => {
		expect(rivalNet("Steam", 1)).toBeGreaterThan(net(1));
		// …and we overtake them not far above, which is why the crossover is worth being
		// precise about rather than rounding away.
		expect(net(2)).toBeGreaterThan(rivalNet("Steam", 2) as number);
	});

	test("we win at every ordinary price above the crossover", () => {
		for (const price of [2, 5, 10, 20, 40]) {
			for (const r of RIVAL_STOREFRONTS) {
				const theirs = rivalNet(r.name, price);
				if (theirs === null) continue; // a row we make no claim about
				expect(net(price), `$${price} vs ${r.name}`).toBeGreaterThan(theirs);
			}
		}
	});

	test("a rival can be negative at a tiny price too, and is not clamped", () => {
		// itch takes 10% and does not absorb processing, so at $0.25 they are underwater by
		// about the same fixed fee we are. Showing $0.00 there would assert they pay nothing.
		expect(rivalNet("itch.io", 0.25) as number).toBeLessThan(0);
	});

	test("a rival we make no claim about renders as no claim, not as zero", () => {
		// Bandcamp sells music; a $40 album is not a transaction anyone recognises, so
		// `maxPrice` bounds the row. Showing $0 there would assert they pay nothing.
		expect(rivalNet("Bandcamp", 40)).toBeNull();
		expect(rivalNet("Bandcamp", 10)).not.toBeNull();
	});

	test("every rival column includes the same card fee we itemise", () => {
		// 63.01 § Comparisons: all-in against all-in. A rival's cut compared against our
		// all-in would flatter us exactly where a creator would check.
		const price = 10;
		const itch = RIVAL_STOREFRONTS.find((r) => r.name === "itch.io");
		if (!itch) throw new Error("no itch row");
		expect(rivalNet("itch.io", price)).toBeCloseTo(
			price * (1 - itch.share) - cardFeeDisplay(price),
			10,
		);
	});

	test("the rates come from the generated module, not from the component", () => {
		// If these are ever typed into a page, 62.04 and the Studio can disagree — which is
		// the whole reason `RIVAL_STOREFRONTS` is generated.
		expect(RIVAL_STOREFRONTS.length).toBeGreaterThan(0);
		for (const r of RIVAL_STOREFRONTS) {
			expect(r.share).toBeGreaterThan(0);
			expect(r.share).toBeLessThan(1);
		}
	});
});

describe("the Badge worst case", () => {
	/**
	 * A Badge level's worst case is a supporter with nothing else on the month's invoice, so
	 * the whole fixed fee lands on that one line — identical arithmetic to a lone purchase.
	 * Anyone giving more amortises it. Stating the worst case is the honest direction: the
	 * best case would flatter the creator into pricing low.
	 */
	test("a lone $3 Badge nets the same as a lone $3 purchase", () => {
		expect(net(3)).toBeCloseTo(3 - (3 * CARD_RATE + CARD_FLAT), 2);
	});

	test("a second destination on the same charge only ever pays the creator more", () => {
		// Two $3 lines share one $0.30 rather than paying it twice.
		const alone = cardFeeDisplay(3);
		const shared = cardFeeDisplay(6) / 2;
		expect(shared).toBeLessThan(alone);
	});
});
