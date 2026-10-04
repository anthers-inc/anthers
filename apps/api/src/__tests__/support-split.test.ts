// SPDX-License-Identifier: Apache-2.0
/**
 * One charge, several destinations — and the split that must survive it.
 *
 * A subscription carries **everything** a user gives: $3 to Anthers and $5 and $2.50 to two
 * creators is one $10.50 charge. So the whole charge is the *total*, and the Anthers line —
 * the Badge, and what sets the Time Pool — is only part of it.
 *
 * 🚨 **This file guards the lesson PR #223 paid for, which has MOVED rather than gone.**
 * Then, the hazard was reading a subscription's `quantity` as the Anthers count: it cost
 * nobody an error, the account simply reported a 3-Seed Petal funding $4.50 of Time Pool
 * off a $3 gift, and every downstream figure was quietly wrong. That mechanism retired with
 * the Seed on 2026-08-16 — one item per destination now, amounts structural and legible on
 * the invoice. What is left in its place is the **destination stamp**: an item priced at $5
 * says nothing on its own about whose money it is, and crediting the wrong side is silent
 * for exactly the same reason. So the assertions below name each half separately and never
 * derive one from the other.
 *
 * ⭐ **Every destination is a user id, Anthers' own line included** (the issuer pass,
 * 2026-10-04): the Anthers creator account is an ordinary issuer, so its line is stamped
 * with its user id and "the Anthers half" is the filter `creatorId === anthersId` rather
 * than a special spelling. The retired `"anthers"` literal and a blank stamp still read as
 * the Anthers line — no subscription carries either, so it is a belt against a hand-authored
 * Stripe object rather than a migration path.
 *
 * Scope: the SPLIT only. The per-creator picks are applied on activation — so a card that
 * declines cannot leave support directed that nobody paid for — and that path is
 * upsert-keyed on (user, creator, cycle) against a replayed webhook. Neither is covered
 * here; it wants the recording Stripe fake from `payments-stripe.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import {
	anthersSupportFromSub,
	directedPicksFromSub,
	directedSupportFromSub,
	itemsFromSub,
	periodEndFromSub,
	totalSupportFromSub,
} from "../services/billing";

/** The Anthers creator account's id, as the issuer pass stamps it. */
const ANTHERS_ID = 7;

/** One subscription item: dollars, and who they are for. `undefined` = unstamped. */
function item(dollars: number, destination?: string, periodEnd = 1_800_000_000) {
	return {
		id: `si_${destination ?? "none"}_${dollars}`,
		quantity: 1,
		price: { unit_amount: Math.round(dollars * 100) },
		current_period_end: periodEnd,
		...(destination === undefined ? {} : { metadata: { destination } }),
	};
}

/** The shape `syncSubscriptionToAccount` reads. */
function sub(...items: ReturnType<typeof item>[]) {
	return {
		id: "sub_test",
		status: "active",
		metadata: {},
		items: { data: items },
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built subset of Stripe's type
	} as any;
}

describe("the support split on one subscription", () => {
	it("reads each half from the items' destinations, never from the total", () => {
		// $3 to Anthers, $5 and $2.50 to two creators — one charge of $10.50.
		const s = sub(item(3, String(ANTHERS_ID)), item(5, "42"), item(2.5, "77"));
		expect(totalSupportFromSub(s, ANTHERS_ID)).toBe(10.5);
		expect(anthersSupportFromSub(s, ANTHERS_ID)).toBe(3);
		expect(directedSupportFromSub(s, ANTHERS_ID)).toBe(7.5);
	});

	it("carries cents, which is the whole reason the unit retired", () => {
		const s = sub(item(2.5, String(ANTHERS_ID)), item(1.75, "42"));
		expect(anthersSupportFromSub(s, ANTHERS_ID)).toBe(2.5);
		expect(directedSupportFromSub(s, ANTHERS_ID)).toBe(1.75);
		expect(totalSupportFromSub(s, ANTHERS_ID)).toBe(4.25);
	});

	it("treats an unstamped item as the Anthers line", () => {
		// No subscription carries an unstamped item; an object authored by hand in Stripe's
		// dashboard could. Crediting it to Anthers — the account a blank stamp most plausibly
		// names — rather than dropping it keeps the total honest.
		const s = sub(item(6));
		expect(anthersSupportFromSub(s, ANTHERS_ID)).toBe(6);
		expect(directedSupportFromSub(s, ANTHERS_ID)).toBe(0);
	});

	it('still reads the retired "anthers" spelling as the Anthers line', () => {
		const s = sub(item(3, "anthers"), item(5, "42"));
		expect(anthersSupportFromSub(s, ANTHERS_ID)).toBe(3);
		expect(directedSupportFromSub(s, ANTHERS_ID)).toBe(5);
	});

	it("ignores a destination stamp that isn't an account id", () => {
		// 🚨 `Number("")` is 0, and user id 0 is a real row shape. A blank, negative or
		// non-numeric stamp must fall back to Anthers rather than credit somebody arbitrary.
		for (const bad of ["", "  ", "none", "-1", "NaN", "0"]) {
			const s = sub(item(4, bad));
			expect(anthersSupportFromSub(s, ANTHERS_ID), `stamp ${JSON.stringify(bad)}`).toBe(4);
			expect(directedSupportFromSub(s, ANTHERS_ID), `stamp ${JSON.stringify(bad)}`).toBe(0);
		}
	});

	it("sums several lines pointed at the same side", () => {
		const s = sub(
			item(3, String(ANTHERS_ID)),
			item(6, String(ANTHERS_ID)),
			item(1, "42"),
			item(2, "42"),
		);
		expect(anthersSupportFromSub(s, ANTHERS_ID)).toBe(9);
		expect(directedSupportFromSub(s, ANTHERS_ID)).toBe(3);
		expect(totalSupportFromSub(s, ANTHERS_ID)).toBe(12);
	});

	it("the two halves always reconstruct the total", () => {
		const s = sub(item(3, String(ANTHERS_ID)), item(5, "42"), item(2.5, "77"), item(1, undefined));
		expect(
			anthersSupportFromSub(s, ANTHERS_ID) + directedSupportFromSub(s, ANTHERS_ID),
		).toBeCloseTo(totalSupportFromSub(s, ANTHERS_ID), 10);
	});
});

describe("the per-destination picks come from the items", () => {
	it("names every destination and what it is given — Anthers' own line included", () => {
		const s = sub(item(3, String(ANTHERS_ID)), item(5, "42"), item(2.5, "77"));
		expect(directedPicksFromSub(s, ANTHERS_ID)).toEqual([
			{ creatorId: ANTHERS_ID, amount: 3 },
			{ creatorId: 42, amount: 5 },
			{ creatorId: 77, amount: 2.5 },
		]);
	});

	it("resolves an unstamped line to the Anthers destination rather than dropping it", () => {
		const s = sub(item(3, String(ANTHERS_ID)), item(9, undefined), item(1, "42"));
		expect(directedPicksFromSub(s, ANTHERS_ID)).toEqual([
			{ creatorId: ANTHERS_ID, amount: 3 },
			{ creatorId: ANTHERS_ID, amount: 9 },
			{ creatorId: 42, amount: 1 },
		]);
	});

	it("drops a zero-amount line rather than writing an empty allocation", () => {
		const s = sub(item(0, "42"), item(1, "77"));
		expect(directedPicksFromSub(s, ANTHERS_ID)).toEqual([{ creatorId: 77, amount: 1 }]);
	});
});

describe("the billing period", () => {
	/**
	 * ⚠️ `sub.items.data[0]` was "the" item and is now an arbitrary destination. Every item
	 * on one subscription shares a period, so reading the first one is *usually* right —
	 * which is exactly what makes it a bad thing to depend on. Taking the latest stops the
	 * answer depending on which creator happens to sort first.
	 */
	it("reads across the items rather than off the first one", () => {
		const s = sub(item(3, String(ANTHERS_ID), 1_700_000_000), item(5, "42", 1_800_000_000));
		expect(periodEndFromSub(s)).toBe(1_800_000_000);
	});

	it("is null when no item carries one", () => {
		const s = sub({ id: "si_x", quantity: 1, price: { unit_amount: 300 } } as never);
		expect(periodEndFromSub(s)).toBeNull();
	});
});

describe("itemsFromSub", () => {
	it("reports the item id, so a change can target the right line", () => {
		const s = sub(item(3, String(ANTHERS_ID)), item(5, "42"));
		expect(itemsFromSub(s, ANTHERS_ID).map((i) => i.creatorId)).toEqual([ANTHERS_ID, 42]);
		expect(itemsFromSub(s, ANTHERS_ID).every((i) => i.itemId.length > 0)).toBe(true);
	});
});
