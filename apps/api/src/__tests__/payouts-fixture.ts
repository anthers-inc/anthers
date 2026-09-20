// SPDX-License-Identifier: Apache-2.0
/**
 * Make a fixture account a fully set-up creator, so a test can get as far as publishing.
 *
 * Publishing anything — releasing a Work, publishing or scheduling a post, publishing a
 * project — takes creator mode AND completed payout setup (`publishRefusal`), so this sets
 * both. An account that should be a creator without payouts sets `is_creator` itself.
 *
 * 🚨 **Most callers are suites whose real subject is something else** — the Catalog, the
 * Library, DMCA, reviews, blocking — that need a released Work or a published post to test
 * it. That breadth is the gate working: publishing is a chokepoint, and a chokepoint that
 * nothing noticed would be a gate that did not hold.
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
 * Put this account in creator mode with a connected Stripe account that Stripe is happy with.
 *
 * Takes a username because that is what the fixtures have to hand at setup time, and most
 * of them do not keep the id. Idempotent, so a suite that calls it twice is fine.
 */
export async function enablePayouts(username: string): Promise<void> {
	const [user] = await db.select({ id: users.id }).from(users).where(eq(users.atprotoHandle, username));
	if (!user) throw new Error(`enablePayouts: no user named ${username}`);
	await enablePayoutsFor(user.id);
}

/** The same, when the caller already has the id. */
export async function enablePayoutsFor(userId: number): Promise<void> {
	await db.update(users).set({ isCreator: true }).where(eq(users.id, userId));
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
