// SPDX-License-Identifier: Apache-2.0
/**
 * The Time Pool table's arithmetic, kept in one place.
 *
 * The pool has two kinds of money on one row: what the time split paid a creator and what
 * the supporter directed by hand as a Sticker. They are the same pot rather than two, so the
 * row's total and the column totals have to add both without either drifting. Cents are
 * integers here for the reason the old month table used them: the browser cannot import
 * decimal.js, and 2.61 + 3.00 in binary floating point is not 5.61.
 *
 * Time is a separate measure and never folds into a money total.
 */
export interface TimePoolRow {
	/** What the Time Pool paid this creator by attention. */
	poolAmount: number;
	/** What the supporter directed to this creator as a Sticker, out of the same pool. */
	stickerAmount: number;
}

export interface TimePoolTotals {
	poolAmount: number;
	stickerAmount: number;
	/** The whole pool this month: by time plus directed. */
	total: number;
}

export function timePoolTotals(rows: TimePoolRow[]): TimePoolTotals {
	const cents = (dollars: number) => Math.round(dollars * 100);
	const totals = rows.reduce(
		(sum, row) => ({
			poolCents: sum.poolCents + cents(row.poolAmount),
			stickerCents: sum.stickerCents + cents(row.stickerAmount),
		}),
		{ poolCents: 0, stickerCents: 0 },
	);
	return {
		poolAmount: totals.poolCents / 100,
		stickerAmount: totals.stickerCents / 100,
		total: (totals.poolCents + totals.stickerCents) / 100,
	};
}
