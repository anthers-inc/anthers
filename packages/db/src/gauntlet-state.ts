// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic state hops for the User Gauntlet — the harness's way to place the user
 * on an exact rung of the staircase without walking a billing flow.
 *
 * Why this exists: the support model made billing real. Changing what a user gives Anthers
 * (`POST /subscriptions/account`) is a Stripe charge with webhook-driven sync — it 503s
 * without Stripe configured and needs a running `stripe listen` forwarder when it is. The e2e spec's default (Stripe-free) mode therefore
 * UI-walks everything that doesn't bill — follow, comment, the giving stepper — and
 * hops the *billing* facts here, at the same rows the webhooks would have written:
 * the user's `billing_accounts` row and a completed `purchases` row. Under the Badge
 * model the **amounts are `user_badges` holdings**, which is what the `--give` hop
 * writes; the two amount columns the old `accounts` table carried are gone.
 * The full-Stripe walk (`GAUNTLET_STRIPE=1`) skips this tool entirely.
 *
 * Usage (flags compose; each is applied only when passed):
 *   bun run db:gauntlet:state --user gauntlet_walker --anthers-support 3   # $3/mo to Anthers
 *   bun run db:gauntlet:state --user gauntlet_walker --support-budget 6        # $6 of budget
 *   bun run db:gauntlet:state --user gauntlet_walker --give 2               # $2 to the creator
 *   bun run db:gauntlet:state --user gauntlet_walker --purchase gauntlet-paid-download
 *   bun run db:gauntlet:state --user gauntlet_walker --watched-minutes 570
 *   bun run db:gauntlet:state --instance walk …                             # the walk's instance
 *
 * The walker defaults to `DEV_ACCOUNT_USERNAME`, mirroring `seed-gauntlet.ts`; the harness
 * always passes `--user` explicitly; walk mode (`--instance walk`) falls back to
 * `walk-walker` instead. Everything here is scoped to the instance's gauntlet
 * fixture — the creator is the instance's, and `--purchase` accepts only the instance's
 * slugs.
 *
 * Spec: the Anthers wiki, `70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { cycleKeyFor } from "@anthers/shared/billing-cycle";
import { amountLabel, badgeLabel, heldBadgeName, supportAmount } from "@anthers/shared/constants";
import { and, eq, sql } from "drizzle-orm";
import { assertDevCheckout } from "./dev-only.js";
import {
	DOWNLOAD_PRICE,
	GAUNTLET_CREATOR_USERNAME,
	GAUNTLET_SLUG_PREFIX,
	GAUNTLET_WALKER_USERNAME,
} from "./gauntlet.js";
import {
	anthersUserIdOfSession,
	applyAnthersSupport,
	applySupportBudget,
} from "./gauntlet-support.js";
import { WALK_CREATOR_USERNAME, WALK_SLUG_PREFIX, WALK_WALKER_USERNAME } from "./gauntlet-walk.js";
import {
	attentionEvents,
	badges,
	billingAccounts,
	db,
	purchases,
	userBadges,
	users,
	works,
} from "./index.js";

const TAG = "[gauntlet-state]";

/**
 * Which copy of the fixture the hop addresses, mirroring `seed-gauntlet.ts`'s
 * `--instance` flag. The hop must land on the same instance the caller is walking: a
 * purchase or a give hop pointed at instance A while the browser walks instance B would
 * write rows the staircase never reads — state that looks landed and is not.
 */
interface Instance {
	creatorUsername: string;
	/** The default walker when neither `--user` nor the dev account is in play. */
	userFallbackUsername: string;
	/** The slug prefix `--purchase` accepts — the instance's own Works only. */
	slugPrefix: string;
}

const INSTANCE_A: Instance = {
	creatorUsername: GAUNTLET_CREATOR_USERNAME,
	userFallbackUsername: GAUNTLET_WALKER_USERNAME,
	slugPrefix: GAUNTLET_SLUG_PREFIX,
};

const INSTANCE_WALK: Instance = {
	creatorUsername: WALK_CREATOR_USERNAME,
	userFallbackUsername: WALK_WALKER_USERNAME,
	slugPrefix: WALK_SLUG_PREFIX,
};

/**
 * Read the `--instance` flag the same way `seed-gauntlet.ts` does, refusing loudly on an
 * unrecognized value rather than silently hopping on instance A.
 */
function resolveInstance(): Instance {
	const i = process.argv.indexOf("--instance");
	const value = i !== -1 ? process.argv[i + 1]?.trim() : undefined;
	if (value === undefined || value === "a") return INSTANCE_A;
	if (value === "walk") return INSTANCE_WALK;
	throw new Error(`Unknown --instance "${value}" (expected "a" or "walk")`);
}

function flagValue(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i !== -1 ? process.argv[i + 1]?.trim() : undefined;
}

function intFlag(name: string, min: number, max: number): number | undefined {
	const raw = flagValue(name);
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < min || n > max) {
		throw new Error(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
	}
	return n;
}

/**
 * A dollar-amount flag.
 *
 * Separate from `intFlag` because support amounts stopped being whole units on
 * 2026-08-16 — walking the staircase to its `$9.50` rung is impossible through a flag
 * that rejects anything but an integer, and that rung is the one guarding the float
 * comparison.
 */
function numFlag(name: string, min: number, max: number): number | undefined {
	const raw = flagValue(name);
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min || n > max) {
		throw new Error(`${name} must be a number in [${min}, ${max}], got "${raw}"`);
	}
	return Math.round(n * 100) / 100;
}

/**
 * First day of the current month, `YYYY-MM-DD` — the app's billing-cycle key.
 *
 * 🚨 **UTC, via the shared `cycleKeyFor`, never a local-time read.** This was
 * `getFullYear`/`getMonth` until 2026-10-01, which on a machine behind UTC answered
 * *September* during the first hours of October while the meter — reading the same
 * "month" through `cycleKeyFor` — already counted October. A fixture that anchors its
 * attention walk and its seed allocations at the cycle start then placed every row in
 * the month the meter was no longer counting, and the gauntlet's near-the-limit rungs
 * failed for the rest of the local day. This is the exact failure `billing-cycle.ts`
 * was created to eliminate; never read the calendar directly here again.
 */
function currentBillingCycle(): string {
	return cycleKeyFor(new Date());
}

/**
 * The fixture's username is the preferred NAME the account was created with; the lookup key
 * is the handle the server issued for it — see `gauntletHandle`./
 */
/**
 * The handle an account holds, derived the same way `gauntletHandle` derives it for the
 * spec — the handle-safe spelling (lowercase, non-handle characters to dashes) under the
 * hosted suffix the API publishes. The walk's account names are handle-safe themselves
 * (see `gauntlet-walk.ts` for why), so the two spellings agree, and both the seeder and
 * the spec resolve the same account for the same name.
 */
async function resolveAccountHandle(apiUrl: string, name: string, role: string): Promise<string> {
	const res = await fetch(`${apiUrl}/api/atproto/config`);
	if (!res.ok) throw new Error(`/api/atproto/config answered ${res.status}`);
	const { hostedHandleSuffix: suffix } = (await res.json()) as { hostedHandleSuffix: string };
	if (!suffix) throw new Error(`${role}: /api/atproto/config named no hosted handle domain`);
	const dashed = name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${dashed}.${suffix}`;
}

async function userIdByHandle(handle: string): Promise<number> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.atprotoHandle, handle))
		.limit(1);
	if (!row) throw new Error(`${handle} not found. Run \`make gauntlet-reset\` first.`);
	return row.id;
}

async function main(): Promise<void> {
	assertDevCheckout();

	const inst = resolveInstance();

	// The instance's own walker is the fallback: `--user` still wins, and with neither
	// `--user` nor the dev account set, walk mode falls back to `walk-walker`
	// rather than instance A's user.
	const walkerUsername =
		flagValue("--user") || process.env.DEV_ACCOUNT_USERNAME?.trim() || inst.userFallbackUsername;
	const apiUrl = `http://localhost:${process.env.API_PORT ?? 8000}`;
	const userId = await userIdByHandle(
		await resolveAccountHandle(apiUrl, walkerUsername, "Viewer"),
	);
	const creatorId = await userIdByHandle(
		await resolveAccountHandle(apiUrl, inst.creatorUsername, "Gauntlet creator"),
	);

	const anthersSupport = numFlag("--anthers-support", 0, 300);
	const supportBudget = numFlag("--support-budget", 0, 300);
	const give = numFlag("--give", 0, 300);
	const purchaseSlug = flagValue("--purchase");
	/**
	 * Public Access minutes already spent this month.
	 *
	 * The meter is the one staircase rung that cannot be UI-walked at all: reaching it
	 * honestly means watching ten hours of video, which no test can do. So this writes
	 * the same `attention_events` rows a real viewing would have left — stamped
	 * `publicAccess: true`, which is what `publicAccessSecondsThisMonth` sums.
	 *
	 * 🚨 Writes rows rather than a total, because there is no total to write: the budget
	 * is **derived** from the events every time it is read. A hop that set some cached
	 * figure would place the user in a state the app cannot actually produce, and would
	 * pass whether or not the derivation worked.
	 */
	const watchedMinutes = intFlag("--watched-minutes", 0, 100_000);

	// Billing rows: the facts the subscription webhooks would write. `--anthers-support`
	// gives the user the Anthers Badge at that amount (a holding on the Anthers ladder —
	// see `applyAnthersSupport` in `gauntlet-support.ts`), and `--support-budget` places
	// the directed balance the Badge picker draws against (see `applySupportBudget`).
	if (anthersSupport !== undefined || supportBudget !== undefined) {
		if (anthersSupport !== undefined) {
			await applyAnthersSupport(userId, anthersSupport.toFixed(2));
		}
		if (supportBudget !== undefined) {
			await applySupportBudget(userId, supportBudget.toFixed(2));
		}
	}

	// Public Access consumption, as events rather than as a stored number.
	if (watchedMinutes !== undefined) {
		await db
			.delete(attentionEvents)
			.where(and(eq(attentionEvents.userId, userId), eq(attentionEvents.publicAccess, true)));

		if (watchedMinutes > 0) {
			// 🚨 The walk STARTS at the current cycle's first instant and runs FORWARD,
			// never backwards from now. Two directions both break: a walk ending "now"
			// runs past the cycle start whenever the month is younger than the walk is
			// long (570 minutes at 03:00 on the 1st credited about 180), and a walk
			// ENDING at the cycle start lies entirely before the meter's window, whose
			// overlap test is `ended > windowStart` — a range ending at the boundary
			// credits nothing at all. Forward from the boundary, the whole walk lies
			// inside the month at any hour of any day. A tail extending past "now" early
			// in the month is harmless: the read-side split clips ranges to the window,
			// and the fixture is synthetic rows either way.
			const CHUNK = 600;
			let left = watchedMinutes * 60;
			let start = new Date(`${currentBillingCycle()}T00:00:00.000Z`).getTime();
			const rows: (typeof attentionEvents.$inferInsert)[] = [];
			while (left > 0) {
				const durationSeconds = Math.min(CHUNK, left);
				const startedAt = new Date(start);
				const endedAt = new Date(start + durationSeconds * 1_000);
				rows.push({
					userId: userId,
					creatorId,
					eventType: "watch",
					durationSeconds,
					startedAt,
					endedAt,
					clientId: `gauntlet-${userId}-${rows.length}`,
					publicAccess: true,
				});
				left -= durationSeconds;
				start += durationSeconds * 1_000;
			}
			for (let i = 0; i < rows.length; i += 500) {
				await db.insert(attentionEvents).values(rows.slice(i, i + 500));
			}
		}
	}

	// A Badge holding on the gauntlet creator — the fact the Badge picker writes.
	// The UI walk normally covers this; the hop exists for placing a state directly.
	//
	// Under the Badge model the holding names a Badge rather than an amount: the
	// creator's ladder lives in `badges`, and `--give` is DOLLARS, like every threshold
	// in the model. So the hop resolves the rung whose THRESHOLD is the given amount
	// and creates it if the fixture ladder has no row there yet — the gauntlet is a
	// dev-only fixture and may not depend on the seed scripts having run.
	//
	// 🚨 **The hop REPLACES the user's holding on this creator, it does not add one.**
	// The walk the e2e drives is cumulative — $3, then the gap states, then $6, upward —
	// and a user holds ONE Badge per issuer per cycle, the highest they have reached.
	// A hop that inserted beside the existing holding would stack rungs ($3 + $4.50 +
	// $6 …) against the cycle's budget until the picker's affordability check refused
	// the next step — a fixture drifting away from what the model can produce, which is
	// exactly what a hop must never do. Deleting the creator-scoped holdings first and
	// writing the one named rung is the state the picker itself would leave behind.
	if (give !== undefined) {
		const cycle = currentBillingCycle();
		const threshold = give.toFixed(2);
		let [badge] = await db
			.select({ id: badges.id })
			.from(badges)
			.where(and(eq(badges.creatorId, creatorId), eq(badges.threshold, threshold)))
			.limit(1);
		if (!badge) {
			[badge] = await db
				.insert(badges)
				.values({
					creatorId,
					threshold,
					label: amountLabel(give),
					description: `Fixture rung created by a --give hop at ${amountLabel(give)}.`,
				})
				.returning({ id: badges.id });
		}
		// Scoped through the ladder's badge ids for the same reason `resetWalker` does it:
		// the holding carries the badge, and the issuer is reachable through it.
		await db
			.delete(userBadges)
			.where(
				sql`${userBadges.userId} = ${userId} AND ${userBadges.badgeId} IN (SELECT id FROM badges WHERE creator_id = ${creatorId})`,
			);
		await db.insert(userBadges).values({
			userId: userId,
			badgeId: badge.id,
			billingCycle: cycle,
		});
	}

	// A completed purchase — the fact the payment webhook would write. The synthetic
	// PaymentIntent id makes the row unmistakably a hop and the insert idempotent.
	if (purchaseSlug !== undefined) {
		if (!purchaseSlug.startsWith(inst.slugPrefix)) {
			throw new Error(
				`--purchase only accepts this instance's gauntlet Works (${inst.slugPrefix}*)`,
			);
		}
		// A purchase unlocks a WORK — that is where access lives, so that is what a
		// permanent unlock has to name.
		const [work] = await db
			.select({ id: works.id })
			.from(works)
			.where(eq(works.slug, purchaseSlug))
			.limit(1);
		if (!work) throw new Error(`Work "${purchaseSlug}" not found. Run \`make gauntlet-reset\`.`);

		const syntheticPi = `pi_gauntlet_hop_${userId}_${purchaseSlug}`;
		const [existing] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, syntheticPi))
			.limit(1);
		if (!existing) {
			await db.insert(purchases).values({
				buyerId: userId,
				workId: work.id,
				type: "digital",
				amount: DOWNLOAD_PRICE,
				processingFee: "0.00",
				creatorEarnings: DOWNLOAD_PRICE,
				stripePaymentIntentId: syntheticPi,
				status: "completed",
			});
		}
	}

	// Report the state actually in the database — the numbers the caller should trust.
	// The Anthers side reads the held Badge's threshold summed over the Anthers ladder —
	// the same derivation `heldAnthersBadgeAmount` takes, and the reason the report does
	// not echo the flag it was handed; the budget side reads the `billing_accounts`
	// balance the budget hop writes. The Anthers account is found by its handle's first
	// label, exactly as `gauntlet-support.ts` finds it for the write — the retired shape
	// identified the ladder by a $0 rung that no longer exists (2026-10-03).
	const anthersId = await anthersUserIdOfSession();
	const [anthersHeld] = await db
		.select({ amount: sql<string>`COALESCE(SUM(${badges.threshold}), 0)` })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(
			and(
				eq(userBadges.userId, userId),
				eq(userBadges.billingCycle, currentBillingCycle()),
				sql`${badges.creatorId} = ${anthersId}`,
			),
		)
		.limit(1);
	const [acct] = await db
		.select({ directedBudget: billingAccounts.directedBudget })
		.from(billingAccounts)
		.where(eq(billingAccounts.userId, userId))
		.limit(1);
	// The user's holdings on the gauntlet creator this cycle, summed through the
	// badge thresholds — the number the old allocation row's `amount` used to carry.
	const [alloc] = await db
		.select({ amount: sql<string>`COALESCE(SUM(${badges.threshold}), 0)` })
		.from(userBadges)
		.innerJoin(badges, eq(badges.id, userBadges.badgeId))
		.where(
			and(
				eq(userBadges.userId, userId),
				eq(badges.creatorId, creatorId),
				eq(userBadges.billingCycle, currentBillingCycle()),
			),
		)
		.limit(1);
	const support = supportAmount(anthersHeld?.amount ?? "0.00");
	// Report the meter from the same derivation the app uses, not from the flag we were
	// handed — a hop that prints its own input tells you nothing about whether it landed.
	const [watched] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(and(eq(attentionEvents.userId, userId), eq(attentionEvents.publicAccess, true)));
	const watchedSeconds = Number(watched?.total ?? 0);
	console.log(
		`${TAG} ${walkerUsername}: $${support.toFixed(2)}/mo to Anthers (${badgeLabel(
			heldBadgeName(support),
		)}) · budget $${Number(acct?.directedBudget ?? 0).toFixed(2)} · given $${Number(
			alloc?.amount ?? 0,
		).toFixed(2)} to ${inst.creatorUsername} · Public Access watched ${(
			watchedSeconds / 3600
		).toFixed(2)}h`,
	);
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
	process.exit(1);
}
