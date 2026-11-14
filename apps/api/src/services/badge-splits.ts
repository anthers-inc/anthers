// SPDX-License-Identifier: Apache-2.0
/**
 * Even splits for a shared Badge's money.
 *
 * A Collab Badge's support is one charge and one subscription line, but it belongs to every
 * owner. The split is done in **integer cents**, because a float division can leave the
 * rows a cent short of the charge and settlement would credit the difference to nobody.
 * The last owner absorbs the remainder, the same rule the card fee already uses.
 *
 * The helper is pure so the conservation property can be tested without Stripe or a
 * database: the returned cents always sum to the input.
 */
import Decimal from "decimal.js";

/** Split a whole number of cents into `count` shares; the last share takes the remainder. */
export function splitCentsEvenly(totalCents: number, count: number): number[] {
	if (count <= 0) return [];
	const cents = Math.max(0, Math.round(totalCents));
	const base = Math.floor(cents / count);
	const remainder = cents - base * count;
	return Array.from({ length: count }, (_, index) => base + (index === count - 1 ? remainder : 0));
}

/** Split a dollar figure into integer-cent shares, rounded to the nearest cent first. */
export function splitDollarsEvenly(total: Decimal, count: number): number[] {
	const cents = total.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
	return splitCentsEvenly(cents, count);
}
