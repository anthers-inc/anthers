// SPDX-License-Identifier: Apache-2.0
/**
 * Subscribing to a creator's Badge automatically follows the creator (Parker, 2026-10-11) —
 * the mirror of purchasing a Work saving it.
 *
 * The one door holdings are written at is the webhook's `applyDirectedSupport` — the
 * retired allocation model's pick route went with it, so the ride-under-test is here.
 * The ceremony's refused cases are silent to the door — a block, and an account whose
 * repository permission has not been granted — while the explicit follow route tells the
 * person why (`routes/accounts.ts`'s mapping).
 *
 * ⭐ The last test is an absence: a subscription cancellation never unfollows. The
 * reasoning is `services/follows.ts`'s docblock; the test is what makes the docblock
 * a claim.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { db } from "@anthers/db/client";
import { badges, billingAccounts, follows, notifications, users } from "@anthers/db/schema";
import { and, eq, like } from "drizzle-orm";
import { applyDirectedSupport, syncSubscriptionToAccount } from "../services/billing.js";
import { blockUser } from "../services/blocks.js";
import { createAccount, type FixtureAccount } from "./account-fixture";
import { ensureAnthersLadder } from "./anthers-ladder-fixture";
import { purgeAccountsCreatedHere } from "./cleanup";
import { DB_SETUP_TIMEOUT } from "./setup-timeouts.js";

purgeAccountsCreatedHere();

const RUN = Date.now().toString(36);
const PREFIX = `sf_${RUN}`;

let creator: FixtureAccount;

async function followExists(userId: number, creatorId: number): Promise<boolean> {
	const [row] = await db
		.select({ id: follows.id })
		.from(follows)
		.where(and(eq(follows.followerId, userId), eq(follows.creatorId, creatorId)))
		.limit(1);
	return Boolean(row);
}

async function followerNotifications(creatorId: number): Promise<number> {
	const rows = await db
		.select({ id: notifications.id })
		.from(notifications)
		.where(and(eq(notifications.userId, creatorId), eq(notifications.kind, "new_follower")));
	return rows.length;
}

describe("subscribing to a Badge follows its creator", () => {
	let follower: FixtureAccount;

	beforeAll(async () => {
		creator = await createAccount(`${PREFIX}_creator`, { emailVerified: true });
		follower = await createAccount(`${PREFIX}_picker`, { emailVerified: true });
		await db
			.insert(badges)
			.values({ creatorId: creator.userId, threshold: "3.00", label: "Supporter" });
	}, DB_SETUP_TIMEOUT);

	afterAll(async () => {
		// Everything here cascades from the fixture accounts: the badge, the holdings,
		// the follow, the block, the notification. The Anthers ladder fixture manages
		// its own owner, whose email sits outside this prefix.
		await db.delete(users).where(like(users.email, `${PREFIX}%`));
	});

	it("🚨 creates the follow when the holding is applied", async () => {
		await applyDirectedSupport(follower.userId, [{ creatorId: creator.userId, amount: 3 }]);
		expect(await followExists(follower.userId, creator.userId)).toBe(true);
	});

	it("notifies the creator exactly once across repeated applies", async () => {
		expect(await followerNotifications(creator.userId)).toBe(1);
		// A re-delivered (or renewed) webhook re-writes the same holding; the follow is
		// the same row, and the refollow-of-an-existing-pair silence is what
		// `notifyFollow` carries.
		await applyDirectedSupport(follower.userId, [{ creatorId: creator.userId, amount: 3 }]);
		const followRows = await db
			.select({ id: follows.id })
			.from(follows)
			.where(and(eq(follows.followerId, follower.userId), eq(follows.creatorId, creator.userId)));
		expect(followRows.length).toBe(1);
		expect(await followerNotifications(creator.userId)).toBe(1);
	});

	it("🚨 stays silent when a block stands between the pair", async () => {
		const blocked = await createAccount(`${PREFIX}_blocked`, { emailVerified: true });
		await blockUser(creator.userId, blocked.userId);
		// The holding lands — the money is the act the account chose — and no follow
		// appears: an automatic follow has no banner to explain a refusal with.
		await applyDirectedSupport(blocked.userId, [{ creatorId: creator.userId, amount: 3 }]);
		expect(await followExists(blocked.userId, creator.userId)).toBe(false);
	});

	it("🚨 stays silent when the repository permission is ungranted", async () => {
		// A `brought` identity Anthers holds no credential for, with no grant yet: the
		// follow would be a record Anthers cannot write, so it is not written — the
		// same refusal the explicit route answers 409 with, silent here.
		const ungranted = await createAccount(`${PREFIX}_ungranted`, {
			emailVerified: true,
			identity: "brought",
		});
		await applyDirectedSupport(ungranted.userId, [{ creatorId: creator.userId, amount: 3 }]);
		expect(await followExists(ungranted.userId, creator.userId)).toBe(false);
	});

	it("🚨 creates the follow from the webhook arm, idempotent on replay", async () => {
		const webhookFollower = await createAccount(`${PREFIX}_webhook`, { emailVerified: true });
		await applyDirectedSupport(webhookFollower.userId, [{ creatorId: creator.userId, amount: 6 }]);
		expect(await followExists(webhookFollower.userId, creator.userId)).toBe(true);

		// A re-delivered (or renewed) webhook re-writes the holding and re-offers the
		// same follow — one row, no second notification.
		await applyDirectedSupport(webhookFollower.userId, [{ creatorId: creator.userId, amount: 6 }]);
		const rows = await db
			.select({ id: follows.id })
			.from(follows)
			.where(
				and(eq(follows.followerId, webhookFollower.userId), eq(follows.creatorId, creator.userId)),
			);
		expect(rows.length).toBe(1);
	});

	it("🚨 never follows Anthers from holding a rung on Anthers' own ladder", async () => {
		const anthersId = await ensureAnthersLadder();
		const holder = await createAccount(`${PREFIX}_ladder`, { emailVerified: true });
		// The webhook's picks include the Anthers line — the holding on the Anthers
		// rung is written, and the follow is not: Anthers' own Badges are chosen with
		// the Anthers amount, not a creator pick.
		await applyDirectedSupport(holder.userId, [{ creatorId: anthersId, amount: 3 }]);
		expect(await followExists(holder.userId, anthersId)).toBe(false);
	});

	it("⭐ a cancellation leaves the follow standing", async () => {
		// The cancel branch of the subscription sync updates the billing row and lapses
		// the benefits — and touches `follows` not at all. Unfollowing is always and
		// only the account's own explicit act; a lapsed card does not silently sever a
		// creator relationship (services/follows.ts carries the decision).
		//
		// The fixture's billing row gets a customer id of its own first: the sync
		// resolves the account BY customer id, and a shared empty default could land on
		// another suite's row. The follow itself was created by the first test's apply —
		// this follower is the one whose holding rides the canceled subscription.
		await db
			.update(billingAccounts)
			.set({ stripeCustomerId: `cus_${PREFIX}` })
			.where(eq(billingAccounts.userId, follower.userId));
		await syncSubscriptionToAccount({
			id: "sub_test_canceled",
			object: "subscription",
			status: "canceled",
			customer: `cus_${PREFIX}`,
		} as never);
		expect(await followExists(follower.userId, creator.userId)).toBe(true);
	});
});
