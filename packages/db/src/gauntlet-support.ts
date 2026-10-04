// SPDX-License-Identifier: Apache-2.0
/**
 * Where the gauntlet's two money hops write, after the accounts split.
 *
 * The old `accounts` table carried both facts as columns — the user's monthly Anthers
 * amount and the directed support total — and the split (2026-10-03) deleted them; under
 * the Badge model the amounts are `user_badges` holdings. These two helpers are the
 * hops' replacement shapes, and each docblock names the production readers that resolve
 * from the shape it writes.
 *
 * 🚨 Dev-fixture only — both writes are reached through `gauntlet-state.ts`, which asserts
 * a dev checkout, and nothing in production may use either shape.
 */
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import { and, eq, sql } from "drizzle-orm";
import { badges, billingAccounts, db, userBadges, users } from "./index.js";

/** The app's billing-cycle key — UTC, via the shared helper, never a local-time read. */
function cycleKey(): string {
	return cycleKeyFor(new Date());
}

/**
 * The `--anthers-support` hop: give the user the Anthers Badge at this amount.
 *
 * 🚨 **Writes a `user_badges` holding on the Anthers ladder — the Badge-side shape, and
 * under the Badge model the only honest place for the amount.** The old hop wrote the
 * accounts table's Anthers-Support column, which fed `heldAnthersBadgeAmount` and
 * `publicAccessBudget`; that column died with the split, and the issuer pass re-pointed
 * both readers at exactly this shape — the holder's row on the Anthers ladder, threshold
 * resolved through the badge. The re-pointed readers are `services/access.ts` and
 * `services/public-access.ts`, and the account is found by its handle —
 * `anthersUserIdOfSession` below, the session-side twin of the API's `anthersUserId`.
 *
 * ⚠️ **The ladder's owner here is whoever owns the dev session's Free rung** — only
 * Anthers' own set carries a $0 Badge, since a creator's ladder has nothing to sell at
 * Free. (A config-named owner was once proposed for production; the handle lookup is what
 * shipped instead, so this lookup IS the production shape, on a dev database.)
 *
 * 🚨 **Fails loudly when no rung exists at the amount.** A hop that reported success
 * while placing no state is the exact failure the staircase exists to catch, so a
 * missing rung is an error naming the fix, never a silent no-write.
 *
 * Replaces the Anthers ladder's other rungs the user holds (one holding per issuer per
 * cycle — the picker's own replace-not-stack rule), so hopping down is honest: $12 → $3
 * reads as $3, never as $15.
 */
export async function applyAnthersSupport(viewerId: number, dollars: string): Promise<void> {
	const anthers = await anthersUserIdOfSession();
	// Free is the absence of a holding (the 2026-10-03 reversal), not a rung at $0: the
	// $0 hop clears the viewer's Anthers holdings and writes nothing, which is the same
	// shape a canceled subscription leaves.
	if (Number(dollars) === 0) {
		await db
			.delete(userBadges)
			.where(
				sql`${userBadges.userId} = ${viewerId} AND ${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${anthers})`,
			);
		return;
	}
	const [rung] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, anthers), eq(badges.threshold, dollars)))
		.limit(1);
	if (!rung) {
		throw new Error(
			`The Anthers ladder has no Badge at $${dollars}. Run \`make gauntlet-reset\` first — the hop must place a state the model can produce.`,
		);
	}
	await db
		.delete(userBadges)
		.where(
			sql`${userBadges.userId} = ${viewerId} AND ${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${anthers})`,
		);
	await db.insert(userBadges).values({
		userId: viewerId,
		badgeId: rung.id,
		billingCycle: cycleKey(),
	});
}

/**
 * The `--support-budget` hop: set the directed balance the Badge picker draws against.
 *
 * **Writes `billing_accounts.directed_budget`** — the column this split put on the
 * subscription-machinery row for exactly this balance, since the balance is
 * subscription state (what the subscription's directed items add to) riding beside the
 * period columns. **The dependency the split left:** the budget check —
 * `routes/subscriptions.ts`, `GET/POST /my-badges` — read the old accounts table's
 * directed-support column, which died with the split; the issuer pass re-pointed it at
 * `billing_accounts.directed_budget` and made the subscription webhook write it
 * (`syncSubscriptionToAccount` knows the directed total already).
 *
 * The hop carries enough of the row to stand for the webhook's write on its own: a
 * freshly created dev user has no `billing_accounts` row (the table is lazily created),
 * so the upsert is the hop, not an update behind a lookup.
 */
export async function applySupportBudget(viewerId: number, dollars: string): Promise<void> {
	await db
		.insert(billingAccounts)
		.values({
			userId: viewerId,
			directedBudget: dollars,
			isActive: true,
		})
		.onConflictDoUpdate({
			target: billingAccounts.userId,
			set: { directedBudget: dollars, updatedAt: new Date() },
		});
}

/**
 * The Anthers creator account's user id — the same shape as the API's `anthersUserId` in
 * `services/anthers-badges.ts`, duplicated here because this harness cannot import the
 * API package. Found by the handle's first label ("anthers"), which the gauntlet's
 * stand-in account holds on the session's network suffix. Shared with
 * `gauntlet-state.ts`, which reads state the hops write.
 */
export async function anthersUserIdOfSession(): Promise<number> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(sql`${users.atprotoHandle} = 'anthers.org' OR ${users.atprotoHandle} LIKE 'anthers.%'`)
		.orderBy(users.id)
		.limit(1);
	if (!row) {
		throw new Error(
			"No Anthers creator account in this dev database — run `make gauntlet-reset` first (it seeds Anthers' Badges).",
		);
	}
	return row.id;
}
