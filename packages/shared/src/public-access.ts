// SPDX-License-Identifier: AGPL-3.0-or-later
import { PUBLIC_ACCESS_PRICE } from "./constants.js";

/**
 * The Public Access meter — how much ungated streaming a free account may watch each
 * month, and what supporting Anthers does about it.
 *
 * Pure (no clock, no I/O, no database), the same shape as `attention.ts` and
 * `services/access.ts`'s `resolveAccessSync`, so the whole policy is exhaustively
 * testable without a browser.
 *
 * **The rule, in full.** Every account watches **10 hours of Public Access a month, free
 * forever**. Giving Anthers the Public Access price removes the limit for as long as it is
 * kept up, and **nothing above it buys any more access** — what more buys is a
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
 * - **Gated work the viewer cleared.** They gave that creator money; charging their free
 *   allowance for it would bill them twice for one thing.
 * - **Work they bought.** A purchase is permanent access, not a draw against anything.
 * - **Their own work.** A creator watching their own catalogue is not consuming a commons.
 * - **Downloads, of anything.** Delivery is free at any volume, and the meter measures
 *   *attention to the commons*, not bytes.
 *
 * Since none of those are Public Access, the meter simply counts Public Access seconds —
 * the exclusions fall out of the definition rather than being a list of special cases.
 *
 * 🚨 **An allowance belongs to an account, so somebody with no account has none.** That is
 * not a refusal dressed up as arithmetic; it is what the word means here. Consuming a Work
 * requires an account (21.01 §9.1), which makes a signed-out visitor somebody the meter
 * never has to answer for rather than somebody it answers generously about. This module
 * said the opposite until 2026-08-28 — it handed a logged-out caller the full allowance
 * with nothing spent, and called anonymous streaming the shop window — and that sentence
 * was the written justification for a missing `requireAuth` rather than a decision anybody
 * took. See {@link NO_PUBLIC_ACCESS_ALLOWANCE}.
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
	/** No limit applies — the viewer gives Anthers at least the Public Access price. */
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
 * The standing of somebody with no account: no allowance, none of it spent.
 *
 * ⚠️ **`limitSeconds: 0` is the honest reading and `usedSeconds: FREE_PUBLIC_ACCESS_SECONDS`
 * would not be.** Both would make `allowed` false, but only one of them is true — a
 * signed-out visitor has consumed nothing we could attribute to them, and saying they had
 * burned ten hours would put a fabricated number in front of anyone who read the budget.
 * What is actually zero is the allowance itself, because an allowance is a property of an
 * account and there is no account here.
 *
 * Nothing user-facing renders this today: the browser store drops the budget entirely when
 * signed out, and delivery refuses a signed-out request before the meter is consulted. It
 * is stated anyway so that the one place the logged-out budget is built says what it means,
 * the way `buildAccessContext` does for the logged-out access context.
 */
export const NO_PUBLIC_ACCESS_ALLOWANCE: PublicAccessBudget = {
	unlimited: false,
	usedSeconds: 0,
	limitSeconds: 0,
	remainingSeconds: 0,
	allowed: false,
};

/**
 * Resolve a viewer's Public Access standing from the two facts it depends on.
 *
 * `anthersSupport` is the **monthly amount in dollars** the viewer currently gives Anthers
 * — point-in-time, like everything else in the model. Reaching the Public Access price is
 * the only threshold that matters, and nothing above it buys more.
 *
 * 🚨 **This took a Seed COUNT until 2026-08-17 and tested `Math.floor(seeds) >= 1`.** The
 * Seed retirement converted the caller — `services/public-access.ts` began passing
 * `supportAmount(...)`, i.e. dollars — and left this contract behind, so **$1 a month
 * bought unlimited access priced at $3**, for anything above a dollar and below three.
 *
 * The unit tests could not see it: they still called this in Seeds (`publicAccessBudget(1,
 * …)`), which is exactly what a passing suite looks like when a *contract* moves rather
 * than an implementation. Comparing against the price rather than a bare `1` is what makes
 * the units legible at the call site, and is why the constant is read here instead of a
 * literal.
 */
export function publicAccessBudget(
	anthersSupport: number,
	usedSeconds: number,
): PublicAccessBudget {
	const used = Math.max(0, Math.floor(usedSeconds));
	// Cents, because both sides are floats off a `numeric` column and dollars-as-floats is
	// the comparison the Badge model already learned not to trust.
	if (Math.round(anthersSupport * 100) >= Math.round(PUBLIC_ACCESS_PRICE * 100)) {
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
