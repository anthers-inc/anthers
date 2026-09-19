// SPDX-License-Identifier: Apache-2.0
/**
 * A complete rating matrix that adds up to a given rating, for seeds and tests alone.
 *
 * 🚨 **Nothing in the product may call this.** A creator's rows are their own answers, and a
 * function that fills them in is exactly the editor answering on the creator's behalf, which is
 * what `unrated` and *Not in It* exist to prevent. It lives in its own module so that importing
 * it is a visible act: a fixture or a seed standing for a Work somebody rated properly needs a
 * matrix that says so, because release refuses a rating without one.
 */

import { type DeclarableMaturity, type MaturityRows, RATING_ROWS } from "./content-rating.js";

/**
 * Every row *Not in It*, apart from the one row that carries the rating: Violence for Mature and
 * Sexual Content for Adult, both of which reach those rungs. General is every row *Not in It*.
 */
export function rowsRatedAs(rating: DeclarableMaturity): MaturityRows {
	const rows: MaturityRows = {};
	for (const row of RATING_ROWS) rows[row.note] = "none";
	if (rating === "mature") rows.violence = "mature";
	if (rating === "adult") rows["sexual-themes"] = "adult";
	return rows;
}
