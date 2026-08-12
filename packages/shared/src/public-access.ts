// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The Public Access meter — how much ungated streaming a free account may watch each
 * month, and what a Seed given to Anthers does about it.
 *
 * Pure (no clock, no I/O, no database), the same shape as `attention.ts` and
 * `services/access.ts`'s `resolveAccessSync`, so the whole policy is exhaustively
 * testable without a browser.
 *
 * **The rule, in full.** Every account watches **10 hours of Public Access a month, free
 * forever**. A single Seed given to Anthers removes the limit for as long as it is held,
 * and **no Seed above the first buys any more access** — what further Seeds buy is a
 * larger Time Pool for the creators the user watches. Access is binary and arrives whole
 * at the first Seed.
 *
 * 🚨 **This is a property of the ACCOUNT, never of the Work**, and that is what lets
 * Public Access be described as free to everyone without qualification. A Work is not
 * "10-hour content"; a *viewer* has a monthly allowance. The distinction matters because
 * the alternative — metering per Work — is how you end up back at a stratified commons,
 * which is exactly what retiring Anthers Gates was for.
 *
 * **What the meter does NOT count**, and each exclusion is load-bearing:
 *
 * - **Gated work the viewer cleared.** They gave that creator Seeds; charging their free
 *   allowance for it would bill them twice for one thing.
 * - **Work they bought.** A purchase is permanent access, not a draw against anything.
 * - **Their own work.** A creator watching their own catalogue is not consuming a commons.
 * - **Downloads, of anything.** Delivery is free at any volume, and the meter measures
 *   *attention to the commons*, not bytes.
 *
 * Since none of those are Public Access, the meter simply counts Public Access seconds —
 * the exclusions fall out of the definition rather than being a list of special cases.
 */

/**
 * Hours of Public Access a free account may watch per calendar month.
 *
 * ⚠️ A **product** number, not a budget one, and that is a genuinely new property. Free
 * access costs `free accounts × FREE_TIME_POOL` — headcount times a policy figure — so
 * raising this changes what a free account *feels like* without changing what it costs.
 * It was untrue while a bandwidth floor existed, where generosity and solvency were
 * literally the same dial. What this figure trades against is **conversion**: it is the
 * reason to give Anthers a first Seed at all.
 */
export const FREE_PUBLIC_ACCESS_HOURS = 10;

/** The same limit in seconds, which is the unit `attention_events` records. */
export const FREE_PUBLIC_ACCESS_SECONDS = FREE_PUBLIC_ACCESS_HOURS * 3600;

/** A viewer's standing against the meter this month. */
export interface PublicAccessBudget {
	/** No limit applies — the viewer holds at least one Seed given to Anthers. */
	unlimited: boolean;
	/** Public Access seconds already watched this month. */
	usedSeconds: number;
	/** The cap in seconds, or null when unlimited. */
	limitSeconds: number | null;
	/** Seconds left before the cap, or null when unlimited. Never negative. */
	remainingSeconds: number | null;
	/** Whether the viewer may start more Public Access right now. */
	allowed: boolean;
}

/**
 * Resolve a viewer's Public Access standing from the two facts it depends on.
 *
 * `anthersSeeds` is the count the viewer *currently holds* — point-in-time, like
 * everything else in the model. **One is the only number that matters**: the comparison
 * is `>= 1`, deliberately not `seedsMeet` against a Badge threshold, because a Badge no
 * longer decides access and reaching for that helper here is how the ladder would creep
 * back in.
 */
export function publicAccessBudget(anthersSeeds: number, usedSeconds: number): PublicAccessBudget {
	const used = Math.max(0, Math.floor(usedSeconds));
	if (Math.floor(anthersSeeds) >= 1) {
		return {
			unlimited: true,
			usedSeconds: used,
			limitSeconds: null,
			remainingSeconds: null,
			allowed: true,
		};
	}
	const remaining = Math.max(0, FREE_PUBLIC_ACCESS_SECONDS - used);
	return {
		unlimited: false,
		usedSeconds: used,
		limitSeconds: FREE_PUBLIC_ACCESS_SECONDS,
		remainingSeconds: remaining,
		// Strictly greater than zero: a viewer who has exactly spent the allowance has
		// spent it. Starting one more stream on an empty budget is the case this exists
		// to refuse.
		allowed: remaining > 0,
	};
}
