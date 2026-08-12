// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One charge, two destinations — and the split that must survive it.
 *
 * A subscription carries **every** Seed a user holds: one to Anthers and one each to two
 * creators is quantity 3, $9/month, one card fee. So the subscription's quantity is the
 * *total*, and `accounts.anthersSeeds` — the Badge, and what sets the Time Pool — is only
 * part of it.
 *
 * 🚨 Reading quantity as the Anthers count is the failure this file exists to prevent. It
 * costs nobody an error: the account simply reports a 3-Seed Petal funding $4.50 of Time
 * Pool off a $3 gift to Anthers, and every downstream figure is quietly wrong. So the
 * assertions below name the two halves separately and never derive one from the other.
 *
 * Scope: this file covers the SPLIT only. The directed picks are applied from subscription
 * metadata on activation rather than at request time — so a card that declines cannot
 * leave Seeds directed that nobody paid for — and that path is upsert-keyed on
 * (user, creator, cycle) against a replayed webhook. Neither is covered here yet; it wants
 * the recording Stripe fake from `payments-stripe.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { anthersSeedsFromSub, directedSeedsFromSub, totalSeedsFromSub } from "../services/billing";

/** The shape `syncSubscriptionToAccount` reads — quantity plus the metadata split. */
function sub(quantity: number, metadata: Record<string, string> = {}) {
	return {
		id: "sub_test",
		status: "active",
		metadata,
		items: { data: [{ id: "si_test", quantity, current_period_end: 1_800_000_000 }] },
		// biome-ignore lint/suspicious/noExplicitAny: a hand-built subset of Stripe's type
	} as any;
}

describe("the Seed split on one subscription", () => {
	it("reads the Anthers half from metadata, not from the quantity", () => {
		// A Seed to Anthers and one each to two creators.
		const s = sub(3, { anthersSeeds: "1" });
		expect(totalSeedsFromSub(s)).toBe(3);
		expect(anthersSeedsFromSub(s)).toBe(1);
		expect(directedSeedsFromSub(s)).toBe(2);
	});

	it("treats an unstamped subscription as Anthers-only", () => {
		// Every subscription predating directed Seeds is Anthers-only, so for those the
		// quantity genuinely IS the Anthers count. This is the migration path, not a guess.
		const s = sub(2);
		expect(anthersSeedsFromSub(s)).toBe(2);
		expect(directedSeedsFromSub(s)).toBe(0);
	});

	it("never lets the stamped Anthers half exceed what was charged", () => {
		// A stale or tampered stamp must not mint Badge levels nobody paid for.
		const s = sub(2, { anthersSeeds: "9" });
		expect(anthersSeedsFromSub(s)).toBe(2);
		expect(directedSeedsFromSub(s)).toBe(0);
	});

	it("ignores a stamp that isn't a number", () => {
		for (const bad of ["", "none", "-1", "NaN"]) {
			const s = sub(4, { anthersSeeds: bad });
			expect(anthersSeedsFromSub(s)).toBe(4);
			expect(directedSeedsFromSub(s)).toBe(0);
		}
	});

	it("puts every Seed beyond the Anthers half on the creators' side", () => {
		const s = sub(10, { anthersSeeds: "4" });
		expect(anthersSeedsFromSub(s)).toBe(4);
		expect(directedSeedsFromSub(s)).toBe(6);
	});
});
