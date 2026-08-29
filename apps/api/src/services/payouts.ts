// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether a creator can be paid — the one place that question is answered.
 *
 * 🚨 **This became an ENFORCEMENT gate on 2026-08-28, and it was four separate copies of
 * one predicate before that.** `routes/payments.ts` asked it twice to decide whether to
 * take money, and `routes/content.ts` asked it twice to decide whether a buyer sees a live
 * checkout — each spelling out `onboardingComplete && payoutsEnabled` inline. Four readers
 * of one fact is how two of them quietly come to disagree, which this repo has now paid
 * for twice (a cookie-only `getOptionalUserId` beside a bearer-reading `requireAuth`, and
 * a private cookie-only copy in `routes/subscriptions.ts`). Releasing a Work is a fifth
 * caller and the strictest one, so the predicate moved here rather than being written out
 * a fifth time.
 *
 * **Both flags are required, and neither implies the other.** `onboardingComplete` says
 * Stripe finished collecting what it needed; `payoutsEnabled` says Stripe is willing to
 * send money. An account can finish onboarding and still be held — under review, missing a
 * document, in a restricted country — and paying such a creator would be booking an
 * obligation we cannot settle.
 *
 * **Why release is gated on it** (Parker, 2026-08-28), because it is not obvious and the
 * code said the opposite until then:
 *
 *   1. **It is what makes every creator on Anthers an adult.** Stripe runs identity
 *      verification and will not verify a minor. Anthers deliberately collects no date of
 *      birth and no ID of its own (wiki 40.09; `/parents`), so this is the *only*
 *      structural check standing behind that claim — and while free publishing skipped it,
 *      Anthers could not make the claim at all.
 *   2. **It means no Work on Anthers is payout-ineligible.** Ungated work earns from the
 *      Time Pool by the time people spend with it, so a released Work with no way to be
 *      paid accrues a debt to somebody we cannot pay. There is no such thing here as work
 *      that only costs money.
 *
 * ⚠️ **The cost of this is real and was the reason it was not done sooner:** Stripe Connect
 * reaches roughly 34 countries, so requiring it to publish shuts out creators in most of
 * the world, not merely creators who do not want money. That trade is now made
 * deliberately rather than by omission, and it is written down in both places a reader
 * meets it — the Creator Terms and `/parents`.
 */

import { db } from "@anthers/db/client";
import { stripeAccounts } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

/** A creator's payout standing, and enough of it to say what is missing. */
export interface PayoutStanding {
	/** Stripe has finished onboarding AND will send money. The only value callers gate on. */
	ready: boolean;
	/** A connected account exists at all — the difference between "not started" and "held". */
	connected: boolean;
}

/**
 * Nobody has connected an account.
 *
 * Exported because callers meet this case without a lookup — a Work whose `creatorId` is
 * null has nobody to pay, which is the same answer arrived at without asking Stripe.
 */
export const NO_PAYOUT_ACCOUNT: PayoutStanding = { ready: false, connected: false };

/**
 * Can this creator be paid?
 *
 * The columns are nullable `boolean`s defaulting to false, so both are coerced rather than
 * trusted — a `null` here means "Stripe has not told us yes", which is a no.
 */
export async function payoutStanding(userId: number): Promise<PayoutStanding> {
	const [row] = await db
		.select({
			payoutsEnabled: stripeAccounts.payoutsEnabled,
			onboardingComplete: stripeAccounts.onboardingComplete,
		})
		.from(stripeAccounts)
		.where(eq(stripeAccounts.userId, userId))
		.limit(1);

	if (!row) return NO_PAYOUT_ACCOUNT;
	return {
		ready: row.onboardingComplete === true && row.payoutsEnabled === true,
		connected: true,
	};
}

/** The short form, for callers that only need the verdict. */
export async function canBePaid(userId: number): Promise<boolean> {
	return (await payoutStanding(userId)).ready;
}

/**
 * What to tell a creator whose release was refused.
 *
 * Two messages rather than one, because the two states need different actions from
 * different people: nobody has started, or Stripe is holding an account that exists. A
 * single "set up payouts" would send somebody already waiting on Stripe back to a form
 * they have already filled in.
 *
 * ⚠️ **The first one names a place, so the place has to be real.** It said *"Open Payouts in
 * the Studio"* until 2026-08-29, and the Studio has no Payouts — the section is Payouts under
 * Studio settings, which is also where Connect's own return leg now lands. A sentence sending
 * somebody somewhere is a route reference that no test can follow, exactly like the
 * `return_url` this was wrong alongside, so it is worth re-reading whenever either moves.
 */
export function payoutRefusalMessage(standing: PayoutStanding): string {
	return standing.connected
		? "Your payout setup isn't finished — Stripe still needs something from you. Open Payouts under Studio settings to see what, and you'll be able to release once it clears."
		: "Set up payouts before releasing your first Work. It's how you get paid, and it takes a few minutes — Anthers takes no cut, so it all comes to you.";
}
