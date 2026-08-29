// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Make a fixture creator payout-ready, so a test can get as far as releasing a Work.
 *
 * 🚨 **Releasing requires completed payout setup since 2026-08-28**, and adding that gate
 * turned 41 tests across 15 files red at once — every one of them a suite whose real
 * subject was something else (the Catalog, the Library, DMCA, reviews, blocking) that
 * happened to need a released Work to test it. That breadth is the gate working: release
 * is a chokepoint, and a chokepoint nothing noticed would have been a gate that did not
 * hold.
 *
 * ⚠️ **This writes the row directly rather than going through Stripe**, which is the only
 * option — Connect onboarding is a hosted flow with an identity check in it, and there is
 * nothing to stub that would make a test more honest. What it must therefore never do is
 * become the *default*: a helper called automatically by the signup fixture would restore
 * exactly the state the gate was added to end, and every test would pass whether or not the
 * gate existed. Each suite calls it deliberately, and the suites that test the gate itself
 * do not call it at all.
 */

import { db } from "@anthers/db/client";
import { stripeAccounts, users } from "@anthers/db/schema";
import { eq } from "drizzle-orm";

/**
 * Give this account a connected Stripe account that Stripe is happy with.
 *
 * Takes a username because that is what the fixtures have to hand at setup time, and most
 * of them do not keep the id. Idempotent, so a suite that calls it twice is fine.
 */
export async function enablePayouts(username: string): Promise<void> {
	const [user] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
	if (!user) throw new Error(`enablePayouts: no user named ${username}`);
	await enablePayoutsFor(user.id);
}

/** The same, when the caller already has the id. */
export async function enablePayoutsFor(userId: number): Promise<void> {
	await db
		.insert(stripeAccounts)
		.values({
			userId,
			// Marked as a fixture so it is obvious in a database nobody expected to contain
			// Connect accounts, and so it can never collide with a real `acct_` id.
			stripeAccountId: `acct_test_${userId}_${crypto.randomUUID().slice(0, 8)}`,
			onboardingComplete: true,
			payoutsEnabled: true,
			chargesEnabled: true,
		})
		.onConflictDoUpdate({
			target: stripeAccounts.userId,
			set: { onboardingComplete: true, payoutsEnabled: true, chargesEnabled: true },
		});
}
