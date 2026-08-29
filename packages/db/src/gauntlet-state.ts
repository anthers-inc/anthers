// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deterministic state hops for the User Gauntlet — the harness's way to place the viewer
 * on an exact rung of the staircase without walking a billing flow.
 *
 * Why this exists: the support model made billing real. Changing what a user gives Anthers
 * (`POST /subscriptions/account`) and topping up their creator budget (`/seeds/buy`) are Stripe
 * charges with webhook-driven sync — they 503 without Stripe configured and need a running
 * `stripe listen` forwarder when it is. The e2e spec's default (Stripe-free) mode therefore
 * UI-walks everything that doesn't bill — follow, comment, the giving stepper — and
 * hops the *billing* facts here, at the same three columns the webhooks would have written:
 * `accounts.anthersSupport`, `accounts.creatorSupportTotal`, and a completed `purchases` row.
 * The full-Stripe walk (`GAUNTLET_STRIPE=1`) skips this tool entirely.
 *
 * Usage (flags compose; each is applied only when passed):
 *   bun run db:gauntlet:state --user gauntlet_viewer --anthers-support 3   # $3/mo to Anthers
 *   bun run db:gauntlet:state --user gauntlet_viewer --support-budget 6        # $6 of budget
 *   bun run db:gauntlet:state --user gauntlet_viewer --give 2               # $2 to the creator
 *   bun run db:gauntlet:state --user gauntlet_viewer --purchase gauntlet-paid-download
 *   bun run db:gauntlet:state --user gauntlet_viewer --watched-minutes 570
 *
 * The viewer defaults to `DEV_ACCOUNT_USERNAME`, mirroring `seed-gauntlet.ts`; the harness
 * always passes `--user` explicitly. Everything here is scoped to the gauntlet fixture.
 *
 * Spec: the Anthers wiki, `70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { badgeLabel, heldBadgeName, supportAmount } from "@anthers/shared/constants";
import { and, eq, sql } from "drizzle-orm";
import { assertDevCheckout } from "./dev-only.js";
import { DOWNLOAD_PRICE, GAUNTLET_CREATOR_USERNAME, GAUNTLET_SLUG_PREFIX } from "./gauntlet.js";
import {
	accounts,
	attentionEvents,
	db,
	purchases,
	seedAllocations,
	users,
	works,
} from "./index.js";

const TAG = "[gauntlet-state]";

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

/** First day of the current month, `YYYY-MM-DD` — the app's billing-cycle key. */
function currentBillingCycle(): string {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

async function userIdByUsername(username: string, role: string): Promise<number> {
	const [row] = await db
		.select({ id: users.id })
		.from(users)
		.where(eq(users.username, username))
		.limit(1);
	if (!row) throw new Error(`${role} "${username}" not found. Run \`make gauntlet-reset\` first.`);
	return row.id;
}

async function main(): Promise<void> {
	assertDevCheckout();

	const viewerUsername = flagValue("--user") || process.env.DEV_ACCOUNT_USERNAME?.trim();
	if (!viewerUsername) {
		throw new Error("Pass --user <username> or set DEV_ACCOUNT_USERNAME in .env.");
	}
	const viewerId = await userIdByUsername(viewerUsername, "Viewer");
	const creatorId = await userIdByUsername(GAUNTLET_CREATOR_USERNAME, "Gauntlet creator");

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
	 * figure would place the viewer in a state the app cannot actually produce, and would
	 * pass whether or not the derivation worked.
	 */
	const watchedMinutes = intFlag("--watched-minutes", 0, 100_000);

	// Account row: the two billing facts the subscription/seed-buy webhooks would write.
	if (anthersSupport !== undefined || supportBudget !== undefined) {
		const patch = {
			...(anthersSupport !== undefined ? { anthersSupport: anthersSupport.toFixed(2) } : {}),
			...(supportBudget !== undefined ? { creatorSupportTotal: supportBudget.toFixed(2) } : {}),
			updatedAt: new Date(),
		};
		const [existing] = await db
			.select({ id: accounts.id })
			.from(accounts)
			.where(eq(accounts.userId, viewerId))
			.limit(1);
		if (existing) {
			await db.update(accounts).set(patch).where(eq(accounts.userId, viewerId));
		} else {
			await db.insert(accounts).values({ userId: viewerId, ...patch });
		}
	}

	// Public Access consumption, as events rather than as a stored number.
	if (watchedMinutes !== undefined) {
		await db
			.delete(attentionEvents)
			.where(and(eq(attentionEvents.userId, viewerId), eq(attentionEvents.publicAccess, true)));

		if (watchedMinutes > 0) {
			// The endpoint caps one event at 300s, so a realistic month is many rows. Match
			// that shape rather than writing one enormous row — the sum is the same, but a
			// single 10-hour event is not a thing the app can produce, and a bug that only
			// bites on row counts would slip past a fixture that never makes any.
			const CHUNK = 300;
			let left = watchedMinutes * 60;
			const rows: (typeof attentionEvents.$inferInsert)[] = [];
			while (left > 0) {
				const durationSeconds = Math.min(CHUNK, left);
				rows.push({
					userId: viewerId,
					creatorId,
					eventType: "video_watch",
					durationSeconds,
					publicAccess: true,
				});
				left -= durationSeconds;
			}
			for (let i = 0; i < rows.length; i += 500) {
				await db.insert(attentionEvents).values(rows.slice(i, i + 500));
			}
		}
	}

	// Allocation to the gauntlet creator (the fact the giving stepper writes).
	// The UI walk normally covers this; the hop exists for placing a state directly.
	if (give !== undefined) {
		const cycle = currentBillingCycle();
		const [existing] = await db
			.select({ id: seedAllocations.id })
			.from(seedAllocations)
			.where(
				and(
					eq(seedAllocations.userId, viewerId),
					eq(seedAllocations.creatorId, creatorId),
					eq(seedAllocations.billingCycle, cycle),
				),
			)
			.limit(1);
		// `--give` is DOLLARS, like every threshold in the model; the ledger stores money, so
		// the value goes in as it was given rather than through a conversion.
		const amount = give.toFixed(2);
		if (existing) {
			await db
				.update(seedAllocations)
				.set({ amount, updatedAt: new Date() })
				.where(eq(seedAllocations.id, existing.id));
		} else {
			await db.insert(seedAllocations).values({
				userId: viewerId,
				creatorId,
				amount,
				billingCycle: cycle,
			});
		}
	}

	// A completed purchase — the fact the payment webhook would write. The synthetic
	// PaymentIntent id makes the row unmistakably a hop and the insert idempotent.
	if (purchaseSlug !== undefined) {
		if (!purchaseSlug.startsWith(GAUNTLET_SLUG_PREFIX)) {
			throw new Error(`--purchase only accepts gauntlet Works (${GAUNTLET_SLUG_PREFIX}*)`);
		}
		// A purchase unlocks a WORK — that is where access lives, so that is what a
		// permanent unlock has to name.
		const [work] = await db
			.select({ id: works.id })
			.from(works)
			.where(eq(works.slug, purchaseSlug))
			.limit(1);
		if (!work) throw new Error(`Work "${purchaseSlug}" not found. Run \`make gauntlet-reset\`.`);

		const syntheticPi = `pi_gauntlet_hop_${viewerId}_${purchaseSlug}`;
		const [existing] = await db
			.select({ id: purchases.id })
			.from(purchases)
			.where(eq(purchases.stripePaymentIntentId, syntheticPi))
			.limit(1);
		if (!existing) {
			await db.insert(purchases).values({
				buyerId: viewerId,
				workId: work.id,
				type: "digital",
				amount: DOWNLOAD_PRICE,
				processingFee: "0.00",
				deliveryFee: "0.00",
				crfFee: "0.00",
				creatorEarnings: DOWNLOAD_PRICE,
				stripePaymentIntentId: syntheticPi,
				status: "completed",
			});
		}
	}

	// Report the state actually in the database — the number the caller should trust.
	const [acct] = await db
		.select({
			anthersSupport: accounts.anthersSupport,
			creatorSupportTotal: accounts.creatorSupportTotal,
		})
		.from(accounts)
		.where(eq(accounts.userId, viewerId))
		.limit(1);
	const [alloc] = await db
		.select({ amount: seedAllocations.amount })
		.from(seedAllocations)
		.where(
			and(
				eq(seedAllocations.userId, viewerId),
				eq(seedAllocations.creatorId, creatorId),
				eq(seedAllocations.billingCycle, currentBillingCycle()),
			),
		)
		.limit(1);
	const support = supportAmount(acct?.anthersSupport);
	// Report the meter from the same derivation the app uses, not from the flag we were
	// handed — a hop that prints its own input tells you nothing about whether it landed.
	const [watched] = await db
		.select({ total: sql<number>`COALESCE(SUM(${attentionEvents.durationSeconds}), 0)::int` })
		.from(attentionEvents)
		.where(and(eq(attentionEvents.userId, viewerId), eq(attentionEvents.publicAccess, true)));
	const watchedSeconds = Number(watched?.total ?? 0);
	console.log(
		`${TAG} ${viewerUsername}: $${support.toFixed(2)}/mo to Anthers (${badgeLabel(
			heldBadgeName(support),
		)}) · budget $${Number(acct?.creatorSupportTotal ?? 0).toFixed(2)} · given $${Number(
			alloc?.amount ?? 0,
		).toFixed(2)} to ${GAUNTLET_CREATOR_USERNAME} · Public Access watched ${(
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
