// SPDX-License-Identifier: Apache-2.0
/**
 * Where the gauntlet's two money hops write, after the accounts split.
 *
 * The old `accounts` table carried both facts as columns (`anthers_support`,
 * `creator_support_total`); the split (2026-10-03) deleted them — under the Badge model
 * the amounts are `user_badges` holdings. These two helpers are the hops' replacement
 * shapes, and each docblock carries the Phase B dependency it leaves rather than leaving
 * the dependency to be discovered by whoever runs the staircase next.
 *
 * 🚨 Dev-fixture only — both writes are reached through `gauntlet-state.ts`, which asserts
 * a dev checkout, and nothing in production may use either shape.
 */
import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import { and, eq, sql } from "drizzle-orm";
import { billingAccounts, badges, db, userBadges } from "./index.js";

/** The app's billing-cycle key — UTC, via the shared helper, never a local-time read. */
function cycleKey(): string {
	return cycleKeyFor(new Date());
}

/**
 * The `--anthers-support` hop: give the user the Anthers Badge at this amount.
 *
 * 🚨 **Writes a `user_badges` holding on the org's ladder — the Badge-side shape, and
 * under the Badge model the only honest place for the amount.** The old hop wrote
 * `accounts.anthers_support`, which fed `heldAnthersBadgeAmount` and
 * `publicAccessBudget`; that column died with the split, and Phase B re-points both
 * readers at exactly this shape — the holder's row on the org-owned ladder, threshold
 * resolved through the badge. **The dependency Phase B's brief must name:** those two
 * readers (`services/access.ts`, `services/public-access.ts`) still read the deleted
 * column and are broken until they re-point, and re-pointing needs an *identifiable org
 * identity in production* — a config-named org account whose ladder is Anthers' own set
 * (the identity decision's recorded follow-up, named in `services/anthers-badges.ts`).
 *
 * ⚠️ **The org's owner here is whoever owns the dev session's Free rung** — only
 * Anthers' own set carries a $0 Badge, since a creator's ladder has nothing to sell at
 * Free. Phase B's config-named owner supersedes this lookup; the hop's write does not
 * change shape when it lands.
 *
 * 🚨 **Fails loudly when no rung exists at the amount.** A hop that reported success
 * while placing no state is the exact failure the staircase exists to catch, so a
 * missing rung is an error naming the fix, never a silent no-write.
 *
 * Replaces the org's other rungs the user holds (one holding per issuer per cycle — the
 * picker's own replace-not-stack rule), so hopping down is honest: $12 → $3 reads as $3,
 * never as $15.
 */
export async function applyAnthersSupport(viewerId: number, dollars: string): Promise<void> {
	const org = await orgOwnerUserId();
	const [rung] = await db
		.select({ id: badges.id })
		.from(badges)
		.where(and(eq(badges.creatorId, org), eq(badges.threshold, dollars)))
		.limit(1);
	if (!rung) {
		throw new Error(
			`The org ladder has no Badge at $${dollars}. Run \`make gauntlet-reset\` first — the hop must place a state the model can produce.`,
		);
	}
	await db
		.delete(userBadges)
		.where(
			sql`${userBadges.userId} = ${viewerId} AND ${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${org})`,
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
 * period columns. **The dependency Phase B's brief must name:** the budget check —
 * `routes/subscriptions.ts`, `GET/POST /my-badges` — reads the deleted
 * `accounts.creator_support_total` today; Phase B re-points it at
 * `billing_accounts.directed_budget` and makes the subscription webhook write it
 * (`syncSubscriptionToAccount` knows the directed total already). If Phase B derives the
 * budget from Stripe items at read time instead, the column is dropped again — the
 * fixture's shape survives either way, because a fixture needs a stored place to write.
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
 * The org identity's user id, found as the dev database marks it.
 *
 * ⚠️ **Dev stand-in, deliberately simple: the owner of the Free rung.** Only Anthers' own
 * set carries a $0 Badge, since a creator's ladder has nothing to sell at Free. Phase B's
 * config-named org identity supersedes this lookup; the hops' writes do not change shape
 * when it lands.
 */
async function orgOwnerUserId(): Promise<number> {
	const [row] = await db
		.select({ id: badges.creatorId })
		.from(badges)
		.where(eq(badges.threshold, "0.00"))
		.orderBy(badges.id)
		.limit(1);
	if (!row) {
		throw new Error(
			"No org ladder in this dev database — run `make gauntlet-reset` first (it seeds Anthers' Badges).",
		);
	}
	return row.id;
}