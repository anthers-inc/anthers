// SPDX-License-Identifier: Apache-2.0
import type { CreatorEarnings } from "../../lib/types";

/**
 * The line under a creator's earnings saying whether the figures are money yet.
 *
 * 🚨 **A running month is an estimate and has to say so.** It is worked out nightly from what
 * supporters give today, and credited only after the month ends, from what they actually paid —
 * a renewal that fails, a refund or a lowered amount all move the settled figure away from the
 * estimate. A creator reading a number with no qualifier beside it would reasonably take it as
 * owed.
 */
export function EarningsBasis({
	earnings,
}: {
	earnings: Pick<CreatorEarnings, "cycle" | "settled">;
}) {
	const month = new Date(earnings.cycle).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});
	return earnings.settled ? (
		<>Settled for {month}.</>
	) : (
		<>
			Estimated for {month}. These figures become final after the month ends, from what supporters
			actually paid.
		</>
	);
}
