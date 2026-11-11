// SPDX-License-Identifier: Apache-2.0
/**
 * The Where Your Month Went table's arithmetic, kept in one place.
 *
 * A row total and a column total that are computed separately drift: the bottom row used to
 * end with the Time Pool's figure alone, sitting under the Badge column, which read as a
 * total for the wrong column. The table now ends with a Totals row under every column and a
 * Total column after the last, and the grand total is their intersection — so all three
 * answers come from this function rather than from a sum at each call site.
 *
 * Money only adds money: the time column is a separate measure, reported in its own total
 * and never folded into the grand total.
 */
export interface CycleTableRow {
	timeSeconds: number;
	poolAmount: number;
	badgeAmount: number;
}

export interface CycleTableTotals {
	timeSeconds: number;
	poolAmount: number;
	badgeAmount: number;
	/** What the month directed at creators: the Time Pool and Badge columns together. */
	grandTotal: number;
}

export function cycleTableTotals(rows: CycleTableRow[]): CycleTableTotals {
	// 🚨 **Cents, not floats.** The browser cannot import `decimal.js` (the fees chain is
	// server-side by design), and adding 2.61 + 3.00 in binary floating point produced
	// 5.609999999999999 in the test that earned this comment. The values are already money
	// at two decimals, so integer cents make the totals exact and the displayed figure
	// stable.
	const cents = (dollars: number) => Math.round(dollars * 100);
	const totals = rows.reduce(
		(sum, row) => ({
			timeSeconds: sum.timeSeconds + row.timeSeconds,
			poolCents: sum.poolCents + cents(row.poolAmount),
			badgeCents: sum.badgeCents + cents(row.badgeAmount),
		}),
		{ timeSeconds: 0, poolCents: 0, badgeCents: 0 },
	);
	return {
		timeSeconds: totals.timeSeconds,
		poolAmount: totals.poolCents / 100,
		badgeAmount: totals.badgeCents / 100,
		grandTotal: (totals.poolCents + totals.badgeCents) / 100,
	};
}
