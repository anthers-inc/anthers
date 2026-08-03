// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Deterministic state hops for the User Gauntlet — the harness's way to place the viewer
 * on an exact rung of the staircase without walking a billing flow.
 *
 * Why this exists: the support model made billing real. Changing the Anthers-Seed count
 * (`POST /subscriptions/account`) and buying creator-Seed budget (`/seeds/buy`) are Stripe
 * charges with webhook-driven sync — they 503 without Stripe configured and need a running
 * `stripe listen` forwarder when it is. The e2e spec's default (Stripe-free) mode therefore
 * UI-walks everything that doesn't bill — follow, comment, the Give-Seeds stepper — and
 * hops the *billing* facts here, at the same three columns the webhooks would have written:
 * `accounts.anthersSeeds`, `accounts.creatorSeedTotal`, and a completed `purchases` row.
 * The full-Stripe walk (`GAUNTLET_STRIPE=1`) skips this tool entirely.
 *
 * Usage (flags compose; each is applied only when passed):
 *   bun run db:gauntlet:state --user gauntlet_viewer --anthers-seeds 3
 *   bun run db:gauntlet:state --user gauntlet_viewer --seed-budget 6
 *   bun run db:gauntlet:state --user gauntlet_viewer --give 2   # 2 SEEDS (= $6)
 *   bun run db:gauntlet:state --user gauntlet_viewer --purchase gauntlet-paid-download
 *
 * The viewer defaults to `DEV_ACCOUNT_USERNAME`, mirroring `seed-gauntlet.ts`; the harness
 * always passes `--user` explicitly. Everything here is scoped to the gauntlet fixture.
 *
 * Spec: `40-59 PhD Projects/43 Platforms/Anthers/70-79 Testing & QA/70 - User Gauntlet.md`
 */

import { badgeLabel, heldBadgeName, SEED_PRICE, seedsFromDollars } from "@anthers/shared/constants";
import { and, eq } from "drizzle-orm";
import { DOWNLOAD_PRICE, GAUNTLET_CREATOR_USERNAME, GAUNTLET_SLUG_PREFIX } from "./gauntlet.js";
import { accounts, db, posts, purchases, seedAllocations, users, works } from "./index.js";

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
	const viewerUsername = flagValue("--user") || process.env.DEV_ACCOUNT_USERNAME?.trim();
	if (!viewerUsername) {
		throw new Error("Pass --user <username> or set DEV_ACCOUNT_USERNAME in .env.");
	}
	const viewerId = await userIdByUsername(viewerUsername, "Viewer");
	const creatorId = await userIdByUsername(GAUNTLET_CREATOR_USERNAME, "Gauntlet creator");

	const anthersSeeds = intFlag("--anthers-seeds", 0, 4);
	const seedBudget = intFlag("--seed-budget", 0, 100);
	const give = intFlag("--give", 0, 100);
	const purchaseSlug = flagValue("--purchase");

	// Account row: the two billing facts the subscription/seed-buy webhooks would write.
	if (anthersSeeds !== undefined || seedBudget !== undefined) {
		const patch = {
			...(anthersSeeds !== undefined ? { anthersSeeds } : {}),
			...(seedBudget !== undefined ? { creatorSeedTotal: seedBudget.toFixed(2) } : {}),
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

	// Seed allocation to the gauntlet creator (the fact the Give-Seeds control writes).
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
		// `--give` counts SEEDS, like every other threshold in the model; the ledger stores
		// the money, so the conversion happens here rather than in the flag's meaning.
		const amount = (give * SEED_PRICE).toFixed(2);
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
		.select({ anthersSeeds: accounts.anthersSeeds, creatorSeedTotal: accounts.creatorSeedTotal })
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
	const seeds = Number(acct?.anthersSeeds ?? 0);
	console.log(
		`${TAG} ${viewerUsername}: ${seeds} Anthers-Seed${seeds === 1 ? "" : "s"} (${badgeLabel(
			heldBadgeName(seeds),
		)}) · budget $${Number(acct?.creatorSeedTotal ?? 0).toFixed(2)} · given ${seedsFromDollars(
			alloc?.amount,
		)} Seeds ($${Number(alloc?.amount ?? 0).toFixed(2)}) to ${GAUNTLET_CREATOR_USERNAME}`,
	);
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(`${TAG} failed:`, err instanceof Error ? err.message : err);
	process.exit(1);
}
